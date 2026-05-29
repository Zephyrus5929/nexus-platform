import redis
import os

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
REFRESH_TOKEN_EXPIRE_DAYS = int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS", "7"))

_client: redis.Redis | None = None


def get_redis() -> redis.Redis:
    global _client
    if _client is None:
        _client = redis.from_url(REDIS_URL, decode_responses=True)
    return _client


def store_refresh_token(token: str) -> None:
    r = get_redis()
    r.setex(f"refresh:{token}", REFRESH_TOKEN_EXPIRE_DAYS * 86400, "1")


def refresh_token_exists(token: str) -> bool:
    r = get_redis()
    return r.exists(f"refresh:{token}") == 1


def revoke_refresh_token(token: str) -> None:
    r = get_redis()
    r.delete(f"refresh:{token}")


# ── Rate limiting helpers (also stored in Redis) ──────────────────────────────

RATE_WINDOW_SECONDS = 60
MAX_REQUESTS_PER_WINDOW = int(os.getenv("RATE_LIMIT_PER_MINUTE", "20"))

def check_rate_limit(key: str) -> bool:
    """Return True if the request is allowed, False if rate-limited."""
    r = get_redis()
    full_key = f"rl:{key}"
    current = r.get(full_key)
    if current is None:
        r.setex(full_key, RATE_WINDOW_SECONDS, 1)
        return True
    count = int(current)
    if count >= MAX_REQUESTS_PER_WINDOW:
        return False
    r.incr(full_key)
    return True
