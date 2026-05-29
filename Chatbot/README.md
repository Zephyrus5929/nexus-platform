# Finance Chatbot Widget — Integration Guide

A secure, AI-powered finance assistant you can embed in any website. It connects to your database for live portfolio data and uses Google Gemini for intelligent responses.

---

## File structure

```
Chatbot/
├── finance-chatbot.html    ← Drop this into your site (or iframe it)
├── server.js               ← Node/Express backend
├── schema.sql              ← PostgreSQL schema
├── env.example             ← Environment variables template
└── README.md
```

---

## Quick start

### 1 — Database

```bash
psql -U postgres -c "CREATE DATABASE financedb;"
psql -U postgres -d financedb -f schema.sql
```

### 2 — Backend

```bash
cd Chatbot
npm install express cors jsonwebtoken pg @google/generative-ai dotenv
cp env.example .env           # Fill in your values
node server.js                # Starts on port 3001
```

### 3 — Widget

Open `finance-chatbot.html` and update the `CONFIG` block at the top of the `<script>` tag:

```js
const CONFIG = {
  apiBase:   'https://your-api.example.com',  // Your backend URL
  authBase:  'https://your-auth.example.com', // Auth server (can be same as apiBase)
  demoMode:  false,                           // ← Set to false for production
};
```

Then embed it in your site:

```html
<!-- Option A: Direct include -->
<script src="finance-chatbot.html"></script>

<!-- Option B: iframe (cleanest isolation) -->
<iframe
  src="https://your-cdn.com/finance-chatbot.html"
  width="420" height="680"
  style="border:none; border-radius:14px;"
  title="Finance assistant">
</iframe>
```

---

## Architecture

```
Browser (widget)
    │
    │  1. POST /api/auth/token      ← widget requests scoped JWT
    │  2. GET  /api/portfolio       ← live DB data for header stats
    │  3. POST /api/chat            ← user messages
    │
    ▼
Express Server (server.js)
    │
    ├── JWT verification  (jsonwebtoken / JWKS)
    ├── PostgreSQL         (pg Pool)  ← portfolio, holdings, history
    └── Google Gemini API  (gemini-2.0-flash)  ← AI responses
```

The server builds a **rich system prompt** injecting the user's live portfolio (total value, holdings, beta, YTD return, tax-loss opportunities) before every Gemini call, so the AI always has real financial context.

---

## Auth server integration

The widget uses a simple token-request flow. In production, replace the `/api/auth/token` endpoint with your real IdP:

| Provider   | How to integrate |
|------------|-----------------|
| Auth0      | Set `AUTH_JWKS_URI` in `.env`; verify tokens with `jwks-rsa` instead of `JWT_SECRET` |
| AWS Cognito | Use the Cognito JWKS URL from your User Pool |
| Okta       | Same JWKS approach |
| Custom JWT | Use `JWT_SECRET` (HS256) — make sure it's a 64-byte random string |

Replace the `requireAuth` middleware in `server.js` with your JWKS verification if needed.

---

## Database integration

The `getPortfolioContext()` function in `server.js` currently returns mock data. Uncomment the real queries and adapt them to your schema:

```js
const summary = await db.query(
  `SELECT total_value, return_pct, daily_pnl, cash_balance
   FROM portfolio_summary WHERE user_id = $1`,
  [userId]
);
```

For real-time prices, add a data pipeline that:
1. Subscribes to a market data feed (Alpaca, Polygon.io, Yahoo Finance)
2. Updates `holdings.current_price` and `portfolio_summary` on a schedule
3. The widget then always shows live data on each `GET /api/portfolio` call

---

## Conversation history

Conversation history is stored in `chat_messages` per `(user_id, conversation_id)`. The server loads the last 40 rows (20 turns) before each Gemini call. The `conversationId` is generated in the browser on page load, so each session gets a fresh thread — but you can persist it in `localStorage` to resume across page reloads.

---

## Security checklist

- [ ] `JWT_SECRET` is a 64-byte random string, stored only in `.env`
- [ ] CORS `WIDGET_ORIGIN` is set to your exact domain
- [ ] Database credentials use a least-privilege DB user (SELECT + INSERT only)
- [ ] `demoMode: false` in the widget config
- [ ] `GEMINI_API_KEY` is never exposed to the browser
- [ ] HTTPS enforced on both widget host and API server
- [ ] Rate-limit the `/api/chat` endpoint (e.g. `express-rate-limit`)

---

## Customisation

| What | Where |
|------|-------|
| Bot name / logo | `finance-chatbot.html` → header section |
| Colour scheme | `finance-chatbot.html` → `:root` CSS variables |
| Quick-reply buttons | `finance-chatbot.html` → `.quick-replies` section |
| AI persona & rules | `server.js` → `buildSystemPrompt()` |
| Portfolio stats bar | `server.js` → `getPortfolioContext()` + `renderPortfolio()` |
| DB schema | `schema.sql` |
