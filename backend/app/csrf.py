"""CSRF protection for the cookie-authenticated web/admin surface.

The browser UI authenticates with a session cookie, which a browser attaches to
any request to this origin — including one forged by another site. SameSite=Lax
blunts that but is only defense-in-depth, so unsafe requests must also prove they
came from our own page by echoing a token the attacker's page cannot read:

  * The server sets a readable `csrf_token` cookie alongside the session cookie
    (login / signup / GET /api/auth/me). Its value is an HMAC of the session
    cookie (app.security.csrf_token_for), so it is bound to that one session.
  * The SPA copies it into an `X-CSRF-Token` header on every unsafe request
    (frontend/src/lib/api.ts).
  * This middleware rejects an unsafe /api/* request that carries a session cookie
    but a missing / wrong token with 403.

What is deliberately NOT covered:
  * Safe methods (GET/HEAD/OPTIONS/TRACE) never change state.
  * `/v1*` and `/v1beta*` — the virtual-key API. Those authenticate with an
    `Authorization` / `x-api-key` / `x-goog-api-key` header, never a cookie, so
    there is no ambient credential for a forged request to ride on.
  * `/api/auth/login` and `/api/auth/signup` — they have no session to protect
    yet; they mint the session and its token.
  * Requests with no session cookie: nothing is authenticated, and the endpoint's
    own `require_user` returns 401.

Invariant this relies on: every cookie-authenticated route lives under `/api/`
(guarded by tests/test_csrf.py so a new route outside it can't silently escape).

Pure ASGI (not BaseHTTPMiddleware): it only inspects the request scope and never
wraps or buffers a response, so /v1 streaming is untouched.
"""

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.security import CSRF_HEADER, SESSION_COOKIE, csrf_valid

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})
PROTECTED_PREFIX = "/api/"
EXEMPT_PATHS = frozenset({"/api/auth/login", "/api/auth/signup"})


class CSRFMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and self._needs_check(scope):
            request = Request(scope)
            session = request.cookies.get(SESSION_COOKIE, "")
            if session and not csrf_valid(session, request.headers.get(CSRF_HEADER, "")):
                response = JSONResponse(
                    {"detail": "CSRF token missing or invalid - reload the page and try again"},
                    status_code=403,
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)

    @staticmethod
    def _needs_check(scope: Scope) -> bool:
        path = scope["path"]
        return (
            scope["method"] not in SAFE_METHODS
            and path.startswith(PROTECTED_PREFIX)
            and path not in EXEMPT_PATHS
        )
