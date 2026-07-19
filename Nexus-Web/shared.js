/**
 * Nexus platform — shared auth helpers (integrated stack).
 */
const API = {
  auth: '', // same origin; nginx proxies /api/auth/* and /api/me
  // chatbot endpoints (/api/chat, /api/portfolio) are also proxied by nginx
};

const TOKEN_REFRESH_BUFFER_MS = 60 * 1000; // refresh 1 minute before expiry

function getToken() {
  return localStorage.getItem('access_token');
}

function getRefreshToken() {
  return localStorage.getItem('refresh_token');
}

function setTokens(access, refresh) {
  localStorage.setItem('access_token', access);
  if (refresh) localStorage.setItem('refresh_token', refresh);
}

function clearTokens() {
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
}

function isLoggedIn() {
  return !!getToken();
}

function logout() {
  clearTokens();
  window.location.href = '/login.html';
}

async function login(username, password) {
  const body = new URLSearchParams();
  body.set('username', username);
  body.set('password', password);

  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Invalid credentials');
  }

  const data = await res.json();
  setTokens(data.access_token, data.refresh_token);
  return data;
}

async function register(username, password) {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Registration failed');
  }

  return login(username, password);
}

function redirectIfLoggedIn(target) {
  if (isLoggedIn()) window.location.href = target || '/app.html';
}

/**
 * Parse JWT payload (without verification) to get expiry.
 * Returns expiry timestamp in milliseconds, or null if invalid.
 */
function getTokenExpiry(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp * 1000; // exp is in seconds
  } catch {
    return null;
  }
}

/**
 * Check if access token is expired or about to expire.
 */
function isTokenExpiringSoon(token) {
  const expiry = getTokenExpiry(token);
  if (!expiry) return true;
  return Date.now() + TOKEN_REFRESH_BUFFER_MS >= expiry;
}

/**
 * Refresh the access token using the refresh token.
 * Returns new access token on success, throws on failure.
 */
async function refreshAccessToken() {
  const refreshToken = getRefreshToken();
  if (!refreshToken) throw new Error('No refresh token');

  const res = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!res.ok) {
    clearTokens();
    throw new Error('Token refresh failed');
  }

  const data = await res.json();
  setTokens(data.access_token, data.refresh_token);
  return data.access_token;
}

/**
 * Fetch wrapper that automatically refreshes token on 401.
 * Usage: await authFetch('/api/portfolio') instead of fetch('/api/portfolio')
 */
async function authFetch(url, options = {}) {
  let token = getToken();

  // Proactively refresh if token is about to expire
  if (token && isTokenExpiringSoon(token)) {
    try {
      token = await refreshAccessToken();
    } catch {
      // Refresh failed, will fall through to 401 handling below
    }
  }

  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let res = await fetch(url, { ...options, headers });

  // If 401, try one refresh and retry
  if (res.status === 401) {
    try {
      token = await refreshAccessToken();
      headers.set('Authorization', `Bearer ${token}`);
      res = await fetch(url, { ...options, headers });
    } catch {
      // Refresh failed, redirect to login
      logout();
      throw new Error('Session expired');
    }
  }

  return res;
}

/**
 * Get current user info (proxied to auth server /me endpoint).
 */
async function getCurrentUser() {
  const res = await authFetch('/api/me');
  if (!res.ok) throw new Error('Failed to get user');
  return res.json();
}
