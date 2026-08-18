/**
 * Finance Chatbot API — integrates with Auth-Server JWTs and PostgreSQL portfolio data.
 */

require('dotenv').config();
const crypto = require('crypto');
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

if (!GEMINI_API_KEY) {
  console.warn('GEMINI_API_KEY not set - chat functionality will be unavailable');
}

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
    // Primary match: email prefix (e.g. 'alex' matches 'alex@example.com')
    // Fallback: exact case-insensitive match on display_name (never ILIKE —
    // ILIKE would treat '_' and '%' in the username as wildcards and could
    // match a display_name like "Alexandra" for the username "alex").
    `SELECT id, email, display_name FROM users
     WHERE split_part(email, '@', 1) = $1 OR lower(display_name) = lower($1)
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

// ── Helpers (must be defined before routes that use them) ──────────────────

// Single source of truth for portfolio_summary + holdings, shared by
// /api/portfolio and the chat context builder below.
async function fetchPortfolioRows(userId) {
  const summary = await db.query(
    `SELECT total_value, return_pct, daily_pnl, cash_balance, ytd_return_pct, beta
     FROM portfolio_summary WHERE user_id = $1`,
    [userId]
  );
  if (!summary.rows.length) return null;

  const holdings = await db.query(
    `SELECT ticker, company_name, shares, current_value, daily_change_pct, sector,
            avg_cost_basis, current_price
     FROM holdings WHERE user_id = $1
     ORDER BY current_value DESC NULLS LAST`,
    [userId]
  );

  return { summary: summary.rows[0], holdings: holdings.rows };
}

async function getPortfolioContext(userId) {
  const rows = await fetchPortfolioRows(userId);
  if (!rows) {
    throw new Error('No portfolio summary');
  }

  const { summary: s, holdings } = rows;
  const totalValue = Number(s.total_value);
  const techValue = holdings
    .filter((h) => h.sector === 'Technology')
    .reduce((sum, h) => sum + Number(h.current_value), 0);

  // Sum of unrealized losses across positions where cost basis > current price.
  // Computed from real DB data instead of a hardcoded value.
  const unrealizedLosses = holdings.reduce((sum, h) => {
    const cost = Number(h.avg_cost_basis);
    const price = Number(h.current_price);
    const loss = (cost - price) * Number(h.shares);
    return sum + (loss > 0 ? loss : 0);
  }, 0);

  return {
    totalValue,
    returnPct: Number(s.return_pct),
    pnlToday: Number(s.daily_pnl),
    cash: Number(s.cash_balance),
    beta: Number(s.beta) || 1,
    techWeight: totalValue > 0 ? techValue / totalValue : 0,
    ytdReturn: Number(s.ytd_return_pct) || 0,
    benchmarkYtd: Number(process.env.BENCHMARK_YTD) || 9.8, // TODO: source from a real market-data feed
    holdings: holdings.map((h) => ({
      ticker: h.ticker,
      shares: Number(h.shares),
      value: Number(h.current_value),
      changePct: Number(h.daily_change_pct),
    })),
    unrealizedLosses,
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
    const rows = await fetchPortfolioRows(req.user.userId);
    if (!rows) {
      return res.status(404).json({ error: 'No portfolio data for user' });
    }

    const { summary, holdings } = rows;
    res.json({
      totalValue: Number(summary.total_value),
      returnPct: Number(summary.return_pct),
      pnlToday: Number(summary.daily_pnl),
      cash: Number(summary.cash_balance),
      holdings: holdings.slice(0, 10).map((h) => ({
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

  const convId = conversationId || crypto.randomUUID();

  try {
    const histRows = await db.query(
      // Most recent 40 messages in chronological order (LIMIT applies after
      // the inner DESC ordering, so we get the newest messages, not the oldest).
      `SELECT role, content FROM (
         SELECT role, content, created_at FROM chat_messages
         WHERE user_id = $1 AND conversation_id = $2
         ORDER BY created_at DESC LIMIT 40
       ) recent ORDER BY created_at ASC`,
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Finance chatbot server running on port ${PORT}`));
