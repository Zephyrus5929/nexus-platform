# Auth Server

A production-ready auth server built with FastAPI, JWT, SQLite, and Redis.

## Features

- JWT access + refresh tokens with rotation
- bcrypt password hashing
- SQLite database via SQLAlchemy
- Redis-backed refresh token storage
- Rate limiting (20 req/min per IP)
- Brute-force lockout (5 failed attempts → 15 min lockout)
- User enumeration prevention

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (recommended)
- Or: Python 3.12+ and a Redis-compatible server (e.g. [Memurai](https://www.memurai.com/) on Windows)

## Setup

**1. Clone the repo**
```bash
git clone https://github.com/Zephyrus5929/Auth-Server
cd Auth-Server
```

**2. Create your `.env`**
```bash
cp .env.example .env   # Windows: copy .env.example .env
```

Edit `.env` and set your secret key — generate one with:
```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

**3. Run**

With Docker (recommended):
```bash
docker compose up --build
```

Without Docker:
```bash
pip install -r requirements.txt
uvicorn main:app --reload
```

Server runs at **http://localhost:8000** — interactive docs at **http://localhost:8000/docs**

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/register` | — | Create account |
| POST | `/auth/login` | — | Returns access + refresh tokens |
| POST | `/auth/refresh` | — | Rotate refresh token |
| POST | `/auth/logout` | — | Revoke refresh token |
| GET | `/me` | Bearer | Current user info |

## Configuration

All config is via `.env`. See `.env.example` for all options.

| Variable | Default | Description |
|----------|---------|-------------|
| `SECRET_KEY` | **required** | JWT signing key |
| `DATABASE_URL` | `sqlite:///./data/auth.db` | SQLAlchemy connection string |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis connection string |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `15` | Access token lifetime |
| `REFRESH_TOKEN_EXPIRE_DAYS` | `7` | Refresh token lifetime |
| `RATE_LIMIT_PER_MINUTE` | `20` | Max requests per IP per minute |
| `MAX_FAILED_ATTEMPTS` | `5` | Failed logins before lockout |
| `LOCKOUT_MINUTES` | `15` | Lockout duration |

## Token Flow

```
register → login → { access_token, refresh_token }
                         │                │
                  use for API calls    store securely
                  (15 min lifetime)    swap for new pair
                                       when access expires
```

Use the access token in the `Authorization` header:
```
Authorization: Bearer <access_token>
```
