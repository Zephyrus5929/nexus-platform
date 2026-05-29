from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from database import User
import os

MAX_FAILED_ATTEMPTS = int(os.getenv("MAX_FAILED_ATTEMPTS", "5"))
LOCKOUT_MINUTES = int(os.getenv("LOCKOUT_MINUTES", "15"))


def record_failed_login(db: Session, user: User) -> None:
    attempts = int(user.failed_attempts or 0) + 1
    user.failed_attempts = str(attempts)
    if attempts >= MAX_FAILED_ATTEMPTS:
        user.locked_until = datetime.utcnow() + timedelta(minutes=LOCKOUT_MINUTES)
    db.commit()


def reset_failed_logins(db: Session, user: User) -> None:
    user.failed_attempts = "0"
    user.locked_until = None
    db.commit()


def is_locked_out(user: User) -> bool:
    if user.locked_until and datetime.utcnow() < user.locked_until:
        return True
    return False
