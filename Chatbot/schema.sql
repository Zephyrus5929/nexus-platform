-- ─────────────────────────────────────────────────────────────────────────
-- finance_chatbot_schema.sql
-- PostgreSQL schema for the Finance Chatbot backend
-- ─────────────────────────────────────────────────────────────────────────

-- ── Extensions ───────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Users ─────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         TEXT UNIQUE NOT NULL,
  display_name  TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  last_login    TIMESTAMPTZ
);

-- ── Portfolio summary (updated by your data pipeline / broker feed) ───────
CREATE TABLE portfolio_summary (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total_value    NUMERIC(18,2) NOT NULL,
  return_pct     NUMERIC(8,4),   -- daily return %
  ytd_return_pct NUMERIC(8,4),
  daily_pnl      NUMERIC(18,2),
  cash_balance   NUMERIC(18,2),
  beta           NUMERIC(6,4),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id)               -- one live row per user; history in a separate table
);

-- ── Holdings ──────────────────────────────────────────────────────────────
CREATE TABLE holdings (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticker            TEXT NOT NULL,
  company_name      TEXT,
  shares            NUMERIC(18,6) NOT NULL,
  avg_cost_basis    NUMERIC(18,4),
  current_price     NUMERIC(18,4),
  current_value     NUMERIC(18,2) GENERATED ALWAYS AS (shares * current_price) STORED,
  daily_change_pct  NUMERIC(8,4),
  sector            TEXT,
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, ticker)
);

-- ── Transactions ──────────────────────────────────────────────────────────
CREATE TABLE transactions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN ('BUY','SELL','DIVIDEND','TRANSFER','FEE')),
  ticker         TEXT,
  shares         NUMERIC(18,6),
  price_per_share NUMERIC(18,4),
  total_amount   NUMERIC(18,2),
  executed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note           TEXT
);

CREATE INDEX idx_transactions_user ON transactions(user_id, executed_at DESC);

-- ── Chat conversation history ──────────────────────────────────────────────
CREATE TABLE chat_messages (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id  UUID NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content          TEXT NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_chat_conv ON chat_messages(user_id, conversation_id, created_at ASC);

-- ── Auth sessions (if not using an external IdP) ──────────────────────────
CREATE TABLE auth_sessions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT UNIQUE NOT NULL,   -- store hash, never plaintext
  scope         TEXT,
  issued_at     TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked       BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_session_user ON auth_sessions(user_id, expires_at DESC);

-- ── Useful views ──────────────────────────────────────────────────────────

-- Live portfolio overview per user
CREATE OR REPLACE VIEW v_portfolio_overview AS
SELECT
  u.id            AS user_id,
  u.email,
  u.display_name,
  ps.total_value,
  ps.return_pct,
  ps.ytd_return_pct,
  ps.daily_pnl,
  ps.cash_balance,
  ps.beta,
  ps.updated_at   AS portfolio_updated
FROM users u
JOIN portfolio_summary ps ON ps.user_id = u.id;

-- Holdings with unrealized P&L
CREATE OR REPLACE VIEW v_holdings_pnl AS
SELECT
  h.*,
  (h.current_value - (h.shares * h.avg_cost_basis)) AS unrealized_pnl,
  CASE
    WHEN h.avg_cost_basis > 0
    THEN ((h.current_price - h.avg_cost_basis) / h.avg_cost_basis) * 100
  END AS unrealized_pnl_pct
FROM holdings h;

-- ── Sample seed data (remove in production) ───────────────────────────────
INSERT INTO users (id, email, display_name)
VALUES ('00000000-0000-0000-0000-000000000001', 'alex@example.com', 'Alex Johnson');

INSERT INTO portfolio_summary (user_id, total_value, return_pct, ytd_return_pct, daily_pnl, cash_balance, beta)
VALUES ('00000000-0000-0000-0000-000000000001', 84203.00, 2.4, 11.2, 312.00, 6450.00, 1.18);

INSERT INTO holdings (user_id, ticker, company_name, shares, avg_cost_basis, current_price, daily_change_pct, sector)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'AAPL',  'Apple Inc.',   105,  180.50, 208.00,  1.8,  'Technology'),
  ('00000000-0000-0000-0000-000000000001', 'MSFT',  'Microsoft',     47,  360.00, 387.23,  3.1,  'Technology'),
  ('00000000-0000-0000-0000-000000000001', 'NVDA',  'NVIDIA Corp.',  31,  430.00, 482.58, -0.9,  'Technology'),
  ('00000000-0000-0000-0000-000000000001', 'BRK.B', 'Berkshire B',   78,  128.40, 144.87,  0.4,  'Financials');
