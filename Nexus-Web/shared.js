/**
 * Nexus platform — shared auth helpers (integrated stack).
 */
const API = {
  auth: '', // same origin; nginx proxies /api/auth/* and /api/me
  // chatbot endpoints (/api/chat, /api/portfolio) are also proxied by nginx
};

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
