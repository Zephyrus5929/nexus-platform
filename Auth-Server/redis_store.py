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

