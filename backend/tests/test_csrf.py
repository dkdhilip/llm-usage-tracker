"""CSRF protection for the cookie-authenticated /api/* surface (app/csrf.py).

These tests use a PLAIN TestClient on purpose: the shared fixtures' client echoes
the token like the SPA does, which would hide exactly what is being tested here.
"""

from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from app.main import app
from app.security import (
    CSRF_COOKIE,
    CSRF_HEADER,
    SESSION_COOKIE,
    csrf_token_for,
    csrf_valid,
    issue_session,
)

_PW = "pw-abcdefgh"


def _signup(name: str = "alice") -> TestClient:
    c = TestClient(app)
    r = c.post("/api/auth/signup", json={"username": name, "password": _PW})
    assert r.status_code == 200, r.text
    return c


def _token(c: TestClient) -> str:
    tok = c.cookies.get(CSRF_COOKIE)
    assert tok, "signup should have issued a csrf_token cookie"
    return tok


def _workspace_name(c: TestClient):
    ws = c.get("/api/auth/me").json()["user"]["workspace"]
    return ws["name"] if ws else None


# ---------------------------------------------------------------- (a) valid token


def test_valid_csrf_token_allows_a_mutation():
    c = _signup()
    r = c.post("/api/workspace", json={"name": "w1"}, headers={CSRF_HEADER: _token(c)})
    assert r.status_code == 200, r.text
    assert _workspace_name(c) == "w1"


# ------------------------------------------------------- (b) missing / invalid token


def test_missing_csrf_token_is_rejected_and_changes_nothing():
    c = _signup()
    r = c.post("/api/workspace", json={"name": "w1"})  # session cookie, no header
    assert r.status_code == 403
    assert "CSRF" in r.json()["detail"]
    assert _workspace_name(c) is None  # the mutation did not run


def test_wrong_csrf_token_is_rejected():
    c = _signup()
    r = c.post("/api/workspace", json={"name": "w1"}, headers={CSRF_HEADER: "not-the-token"})
    assert r.status_code == 403
    assert _workspace_name(c) is None


def test_empty_csrf_token_is_rejected():
    c = _signup()
    r = c.post("/api/workspace", json={"name": "w1"}, headers={CSRF_HEADER: ""})
    assert r.status_code == 403


def test_token_is_bound_to_its_own_session():
    """Another user's valid token must not work against this session."""
    alice, bob = _signup("alice"), _signup("bobby")
    r = alice.post("/api/workspace", json={"name": "w1"}, headers={CSRF_HEADER: _token(bob)})
    assert r.status_code == 403
    assert _workspace_name(alice) is None


def test_put_and_delete_are_protected_too():
    c = _signup()
    assert c.delete("/api/account").status_code == 403  # DELETE
    assert c.put("/api/workspace/providers/openai/key", json={"api_key": "sk-x"}).status_code == 403  # PUT
    assert c.get("/api/auth/me").json()["authenticated"] is True  # account untouched


# ----------------------------------------------------- (c) read-only requests still work


def test_get_requests_need_no_token():
    c = _signup()
    c.post("/api/workspace", json={"name": "w1"}, headers={CSRF_HEADER: _token(c)})
    assert c.get("/api/auth/me").status_code == 200
    assert c.get("/api/requests").status_code == 200  # a workspace-scoped read, no header


def test_me_issues_the_token_to_a_session_that_predates_csrf():
    """The upgrade path: a session cookie minted before CSRF existed has no
    csrf_token cookie. Its first GET /me hands one out, so the user never has to
    log in again."""
    c = _signup()
    c.cookies.delete(CSRF_COOKIE)  # simulate a pre-CSRF session
    assert c.post("/api/workspace", json={"name": "w1"}).status_code == 403  # no token yet
    assert c.get("/api/auth/me").status_code == 200  # picks the cookie up
    r = c.post("/api/workspace", json={"name": "w1"}, headers={CSRF_HEADER: _token(c)})
    assert r.status_code == 200, r.text


def test_me_issues_no_token_when_anonymous():
    r = TestClient(app).get("/api/auth/me")
    assert r.json()["authenticated"] is False
    assert CSRF_COOKIE not in r.headers.get("set-cookie", "")


# ------------------------------------------------- (d) /v1 virtual-key API is unaffected


def test_v1_virtual_key_api_is_not_subject_to_csrf(admin_client, make_live_key, mock_provider):
    k = make_live_key(allowed_providers=["anthropic"])
    # A client that DOES carry a live session cookie — the worst case for "did the
    # browser CSRF check wrongly leak onto the virtual-key API?" — but no token.
    c = TestClient(app)
    c.cookies.set(SESSION_COOKIE, admin_client.cookies.get(SESSION_COOKIE))

    # control: the same client is cookie-authenticated and /api rejects it w/o a token
    assert c.post("/api/auth/logout").status_code == 403

    body = {"model": "claude-3-5-haiku-20241022", "max_tokens": 5,
            "messages": [{"role": "user", "content": "hi"}]}
    r = c.post("/v1/messages", json=body, headers={"x-api-key": k["key"]})
    assert r.status_code == 200, r.text  # not 403: virtual-key auth is header-based


def test_every_unsafe_route_outside_the_virtual_key_api_is_under_api():
    """The invariant app/csrf.py relies on: cookie-authenticated routes all live
    under /api/. A new unsafe route elsewhere would silently escape the check."""
    safe = {"GET", "HEAD", "OPTIONS", "TRACE"}
    for route in app.routes:
        if isinstance(route, APIRoute) and (set(route.methods) - safe):
            assert route.path.startswith(("/api/", "/v1/", "/v1beta/")), route.path


# ------------------------------------------------------------- login/signup exemption


def test_login_and_signup_do_not_need_a_token_even_with_a_stale_session():
    c = TestClient(app)
    c.cookies.set(SESSION_COOKIE, "stale.session")
    bad = c.post("/api/auth/login", json={"username": "nobody", "password": "x"})
    assert bad.status_code == 401  # reached the handler: not a 403 CSRF rejection
    ok = c.post("/api/auth/signup", json={"username": "carol", "password": _PW})
    assert ok.status_code == 200, ok.text
    assert CSRF_COOKIE in ok.headers["set-cookie"]


# ------------------------------------------------------- logout + cookie hygiene


def test_logout_needs_the_token_and_then_clears_both_cookies():
    c = _signup()
    assert c.post("/api/auth/logout").status_code == 403
    assert c.get("/api/auth/me").json()["authenticated"] is True  # still signed in

    r = c.post("/api/auth/logout", headers={CSRF_HEADER: _token(c)})
    assert r.status_code == 200
    cleared = " ".join(r.headers.get_list("set-cookie")).lower()
    assert f"{SESSION_COOKIE}=" in cleared and f"{CSRF_COOKIE}=" in cleared
    assert cleared.count("max-age=0") == 2
    assert c.get("/api/auth/me").json()["authenticated"] is False


def test_cookie_flags_session_stays_httponly_and_neither_is_weakened():
    r = TestClient(app).post("/api/auth/signup", json={"username": "dave", "password": _PW})
    by_name = {h.split("=", 1)[0]: h.lower() for h in r.headers.get_list("set-cookie")}
    session, csrf = by_name[SESSION_COOKIE], by_name[CSRF_COOKIE]
    assert "httponly" in session and "samesite=lax" in session
    # the CSRF cookie must be script-readable (the SPA echoes it) but is not weaker otherwise
    assert "httponly" not in csrf
    assert "samesite=lax" in csrf and "path=/" in csrf
    assert "max-age=" in csrf


# ------------------------------------------------------------------------ unit


def test_csrf_token_primitives():
    a, b = issue_session(1), issue_session(2)
    assert csrf_token_for(a) == csrf_token_for(a)  # deterministic
    assert csrf_token_for(a) != csrf_token_for(b)  # per-session
    assert csrf_valid(a, csrf_token_for(a))
    assert not csrf_valid(a, csrf_token_for(b))
    assert not csrf_valid(a, "")
    assert not csrf_valid("", csrf_token_for(a))
    assert not csrf_valid(a, "é")  # non-ASCII input must be a clean False, never a crash
