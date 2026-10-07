"""Auth: signup + login, session cookie, logout, and `/me`. Username + password —
no email, no password reset yet."""

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import ratelimit
from app.config import settings
from app.db import get_db
from app.models import User, Workspace
from app.security import (
    CSRF_COOKIE,
    SESSION_COOKIE,
    csrf_token_for,
    current_user,
    hash_password,
    issue_session,
    verify_password,
)

# 3–32 chars, alphanumeric plus . _ - inside, must start and end alphanumeric.
_USERNAME_RE = r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{1,30}[A-Za-z0-9])$"

router = APIRouter(prefix="/api/auth", tags=["auth"])


class Credentials(BaseModel):
    username: str = Field(pattern=_USERNAME_RE, max_length=40)
    password: str = Field(min_length=8, max_length=200)


class LoginBody(BaseModel):
    username: str
    password: str


def _set_csrf_cookie(resp: Response, session_cookie: str) -> None:
    """The CSRF token cookie (see app/csrf.py). Deliberately NOT HttpOnly — the SPA
    must read it to echo it in X-CSRF-Token — but otherwise held to the session
    cookie's standard: same lifetime, SameSite=Lax, Secure outside development."""
    resp.set_cookie(
        CSRF_COOKIE,
        csrf_token_for(session_cookie),
        max_age=settings.SESSION_TTL_HOURS * 3600,
        httponly=False,
        samesite="lax",
        secure=settings.ENVIRONMENT.strip().lower() != "development",
        path="/",
    )


def _set_cookie(resp: Response, user_id: int) -> None:
    session = issue_session(user_id)
    resp.set_cookie(
        SESSION_COOKIE,
        session,
        max_age=settings.SESSION_TTL_HOURS * 3600,
        httponly=True,
        samesite="lax",
        secure=settings.ENVIRONMENT.strip().lower() != "development",
        path="/",
    )
    _set_csrf_cookie(resp, session)


def _me(db: Session, user: User | None) -> dict:
    if user is None:
        return {"authenticated": False, "user": None}
    workspace = None
    if user.workspace_id is not None:
        ws = db.get(Workspace, user.workspace_id)
        if ws is not None:
            workspace = {
                "id": ws.id,
                "name": ws.name,
                "role": user.workspace_role or "member",
            }
    return {
        "authenticated": True,
        "user": {
            "id": user.id,
            "username": user.username,
            "workspace": workspace,
        },
    }


def _throttle_signup(ip: str) -> None:
    if not ratelimit.allow(f"signup:{ip}", limit=settings.SIGNUPS_PER_IP_PER_HOUR, window_seconds=3600):
        raise HTTPException(429, "too many signups from this address — try later")


@router.post("/signup")
def signup(body: Credentials, request: Request, resp: Response, db: Session = Depends(get_db)) -> dict:
    if not settings.ALLOW_SIGNUP:
        raise HTTPException(403, "signup is disabled")
    username = body.username.strip().lower()
    _throttle_signup(request.client.host if request.client else "?")

    account_count = db.scalar(select(func.count()).select_from(User))
    if (account_count or 0) >= settings.MAX_USERS:
        raise HTTPException(503, "sign-ups are currently closed — try again later")
    if db.scalar(select(User.id).where(func.lower(User.username) == username)):
        raise HTTPException(409, "that username is taken")

    user = User(username=username, password_hash=hash_password(body.password))
    db.add(user)
    db.commit()
    db.refresh(user)
    _set_cookie(resp, user.id)
    return _me(db, user)


@router.post("/login")
def login(body: LoginBody, resp: Response, db: Session = Depends(get_db)) -> dict:
    ident = body.username.strip().lower()
    user = db.scalar(select(User).where(func.lower(User.username) == ident))
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "invalid username or password")
    _set_cookie(resp, user.id)
    return _me(db, user)


@router.post("/logout")
def logout(resp: Response) -> dict:
    resp.delete_cookie(SESSION_COOKIE, path="/")
    resp.delete_cookie(CSRF_COOKIE, path="/")
    return {"authenticated": False, "user": None}


@router.get("/me")
def me(
    resp: Response,
    user: User | None = Depends(current_user),
    session: str = Cookie(default="", alias=SESSION_COOKIE),
    db: Session = Depends(get_db),
) -> dict:
    if user is not None and session:
        # (Re)issue the CSRF cookie for an already-valid session. This is how a
        # session that predates CSRF protection (no csrf_token cookie yet) picks
        # one up on the SPA's first /me call, without forcing a re-login.
        _set_csrf_cookie(resp, session)
    return _me(db, user)
