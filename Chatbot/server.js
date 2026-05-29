/**
 * Finance Chatbot API — integrates with Auth-Server JWTs and PostgreSQL portfolio data.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const JWT_SECRET = process.env.JWT_SECRET || process.env.SECRET_KEY;
if (!JWT_SECRET) {
  console.error('JWT_SECRET or SECRET_KEY is required');
  process.exit(1);
}

const app = express();
app.use(cors({ origin: process.env.WIDGET_ORIGIN || 'http://localhost:8080' }));
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const gemini = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

const db = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'financedb',
  user: process.env.DB_USER || 'dbuser',
  password: process.env.DB_PASSWORD || 'dbpass',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// ── Resolve Auth username (JWT sub) → Postgres user UUID ─────────────────
async function resolvePostgresUserId(username) {
  const { rows } = await db.query(
    `SELECT id, email, display_name FROM users
     WHERE split_part(email, '@', 1) = $1 OR display_name ILIKE $1
     LIMIT 1`,
    [username]
  );
  return rows[0] || null;
}

// ── JWT middleware (Auth-Server access tokens: { sub, type, exp }) ─────────
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing token' });

  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (payload.type && payload.type !== 'access') {
      return res.status(401).json({ error: 'Invalid token type' });
    }
    const username = payload.sub;
    if (!username) return res.status(401).json({ error: 'Invalid token payload' });

    const pgUser = await resolvePostgresUserId(username);
    if (!pgUser) {
      return res.status(404).json({
        error: 'Portfolio user not found',
        hint: 'Register with username matching a portfolio account (e.g. alex)',
      });
    }

    req.user = {
      username,
      userId: pgUser.id,
      email: pgUser.email,
      displayName: pgUser.display_name || username,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Dev-only token endpoint (legacy widget flow)
if (process.env.NODE_ENV === 'development') {
  app.post('/api/auth/token', async (req, res) => {
    const { clientId } = req.body || {};
    if (clientId !== process.env.WIDGET_CLIENT_ID) {
      return res.status(401).json({ error: 'Unknown client' });
    }
    const token = jwt.sign(
      { sub: 'alex', type: 'access' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    res.json({ access_token: token, user_id: 'alex', expires_in: 3600 });
  });
}

app.get('/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false, error: 'database unavailable' });
  }
});

// ── Portfolio ──────────────────────────────────────────────────────────────
app.get('/api/portfolio', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;

    const summary = await db.query(
      `SELECT total_value, return_pct, daily_pnl, cash_balance, ytd_return_pct, beta
       FROM portfolio_summary WHERE user_id = $1`,
      [userId]
    );
    if (!summary.rows.length) {
      return res.status(404).json({ error: 'No portfolio data for user' });
    }

    const holdings = await db.query(
      `SELECT ticker, company_name, current_value, daily_change_pct
       FROM holdings WHERE user_id = $1
       ORDER BY current_value DESC NULLS LAST LIMIT 10`,
      [userId]
    );

    const result = summary.rows[0];
    res.json({
      totalValue: Number(result.total_value),
      returnPct: Number(result.return_pct),
      pnlToday: Number(result.daily_pnl),
      cash: Number(result.cash_balance),
      holdings: holdings.rows.map((h) => ({
        ticker: h.ticker,
        name: h.company_name,
        value: '$' + Number(h.current_value).toLocaleString(),
        change:
          (h.daily_change_pct >= 0 ? '▲ ' : '▼ ') +
          Math.abs(Number(h.daily_change_pct)).toFixed(1) +
          '%',
        up: Number(h.daily_change_pct) >= 0,
      })),
    });
  } catch (err) {
    console.error('Portfolio fetch error:', err);
    res.status(500).json({ error: 'Failed to load portfolio' });
  }
});

// ── Chat ───────────────────────────────────────────────────────────────────
app.post('/api/chat', requireAuth, async (req, res) => {
  const { message, conversationId } = req.body;
  const userId = req.user.userId;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }
  if (!gemini) {
    return res.status(503).json({ error: 'GEMINI_API_KEY is not configured' });
  }

  const convId = conversationId || require('crypto').randomUUID();

  try {
    const histRows = await db.query(
      `SELECT role, content FROM chat_messages
       WHERE user_id = $1 AND conversation_id = $2
       ORDER BY created_at ASC LIMIT 40`,
      [userId, convId]
    );
    const priorMessages = histRows.rows.map((r) => ({ role: r.role, content: r.content }));

    const portfolioContext = await getPortfolioContext(userId);
    const systemPrompt = buildSystemPrompt(portfolioContext, req.user);

    const assistantText = await generateGeminiReply(systemPrompt, priorMessages, message);

    await db.query(
      `INSERT INTO chat_messages (user_id, conversation_id, role, content)
       VALUES ($1, $2, 'user', $3), ($1, $2, 'assistant', $4)`,
      [userId, convId, message, assistantText]
    );

    res.json({ text: assistantText, conversationId: convId });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Chat request failed' });
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function generateGeminiReply(systemPrompt, priorMessages, userMessage) {
  const model = gemini.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: systemPrompt,
  });

  const history = priorMessages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const chat = model.startChat({ history });
  const result = await chat.sendMessage(userMessage);
  return result.response.text();
}

async function getPortfolioContext(userId) {
  const summary = await db.query(
    `SELECT total_value, return_pct, daily_pnl, cash_balance, ytd_return_pct, beta
     FROM portfolio_summary WHERE user_id = $1`,
    [userId]
  );
  const holdings = await db.query(
    `SELECT ticker, shares, current_value, daily_change_pct, sector
     FROM holdings WHERE user_id = $1 ORDER BY current_value DESC`,
    [userId]
  );

  if (!summary.rows.length) {
    throw new Error('No portfolio summary');
  }

  const s = summary.rows[0];
  const rows = holdings.rows;
  const totalValue = Number(s.total_value);
  const techValue = rows
    .filter((h) => h.sector === 'Technology')
    .reduce((sum, h) => sum + Number(h.current_value), 0);

  return {
    totalValue,
    returnPct: Number(s.return_pct),
    pnlToday: Number(s.daily_pnl),
    cash: Number(s.cash_balance),
    beta: Number(s.beta) || 1,
    techWeight: totalValue > 0 ? techValue / totalValue : 0,
    ytdReturn: Number(s.ytd_return_pct) || 0,
    benchmarkYtd: 9.8,
    holdings: rows.map((h) => ({
      ticker: h.ticker,
      shares: Number(h.shares),
      value: Number(h.current_value),
      changePct: Number(h.daily_change_pct),
    })),
    unrealizedLosses: 1840,
    openTaxYear: new Date().getFullYear(),
  };
}

function buildSystemPrompt(portfolio, user) {
  const h = portfolio.holdings
    .map(
      (row) =>
        `  ${row.ticker}: ${row.shares} shares, value $${row.value.toLocaleString()}, today ${row.changePct >= 0 ? '+' : ''}${row.changePct}%`
    )
    .join('\n');

  const name = user.displayName || user.username;

  return `You are FinAssist, a personal finance assistant embedded in the user's investment dashboard.
You have real-time access to the user's portfolio data (shown below). Use it to give precise,
personalised answers. Always be concise, data-driven, and reassuring without being promotional.

USER: ${user.email} (${name})
DATE: ${new Date().toDateString()}

PORTFOLIO SUMMARY
─────────────────
Total value:       $${portfolio.totalValue.toLocaleString()}
Daily P&L:         ${portfolio.pnlToday >= 0 ? '+' : ''}$${portfolio.pnlToday} (${portfolio.returnPct >= 0 ? '+' : ''}${portfolio.returnPct}%)
YTD return:        +${portfolio.ytdReturn}% vs S&P 500 ${portfolio.benchmarkYtd}%
Portfolio beta:    ${portfolio.beta}
Tech concentration: ${(portfolio.techWeight * 100).toFixed(0)}%
Cash available:    $${portfolio.cash.toLocaleString()}
Unrealised losses: $${portfolio.unrealizedLosses} (harvesting opportunity)

HOLDINGS
${h}

GUIDELINES
- Greet the user by first name only when explicitly asked; otherwise get straight to the answer.
- Use markdown bold (**text**) for key numbers or insights.
- When recommending trades, always note this is informational and not financial advice.
- Never fabricate data not present in the portfolio summary above.
- Keep responses under 120 words unless a detailed analysis is requested.`;
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Finance chatbot server running on port ${PORT}`));
