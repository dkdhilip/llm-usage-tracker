"""Opt-in, admin-only prompt/response content logging (app/content_capture.py).

Everything runs against the real gateway code with a MOCKED provider (the `mock_provider` fixture): no test
here reaches a real provider or uses a real credential."""

import json
import logging
import threading
import time
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select, text

from app import bootstrap, content_capture, crypto
from app.adapters import openai_adapter
from app.config import Settings, settings
from app.db import SessionLocal
from app.gateway import stream_native_passthrough
from app.models import UsageContent, UsageLog

ALL = ["openai", "anthropic", "gemini", "openrouter"]


# ------------------------------------------------------------------------------------------------ helpers


@pytest.fixture()
def env(admin_client, make_live_key, mock_provider):
    """The admin's workspace with every provider attached (fake keys) and a live key allowing all of them."""
    key = make_live_key(allowed_providers=ALL, default_provider="openai", content_logging_enabled=True, image_logging_enabled=True)
    return admin_client, key, mock_provider


def _auth(key: dict, **extra) -> dict:
    return {"Authorization": f"Bearer {key['key']}", **extra}


def _enable(c, on: bool = True) -> dict:
    r = c.patch("/api/workspace/content-logging", json={"enabled": on})
    assert r.status_code == 200, r.text
    return r.json()


def _chat(c, key, model="openai/gpt-4o-mini", content="hello gateway", **extra):
    body = {"model": model, "messages": [{"role": "system", "content": "be terse"}, {"role": "user", "content": content}], **extra}
    return c.post("/v1/chat/completions", json=body, headers=_auth(key))


def _rows() -> list[UsageContent]:
    with SessionLocal() as db:
        return list(db.scalars(select(UsageContent).order_by(UsageContent.id)))


def _usage() -> list[UsageLog]:
    with SessionLocal() as db:
        return list(db.scalars(select(UsageLog).order_by(UsageLog.id)))


def _payload(row: UsageContent) -> dict:
    data = content_capture.load(row)
    assert data is not None
    return data


def _all_text(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False)


def _first_usage_id(c) -> int:
    return c.get("/api/requests").json()["items"][0]["id"]


def _insert_content(usage_id: int, workspace_id: int, hours_from_now: float, kind: str = "chat") -> None:
    with SessionLocal() as db:
        db.add(
            UsageContent(
                usage_log_id=usage_id,
                workspace_id=workspace_id,
                kind=kind,
                content_encrypted=crypto.encrypt(json.dumps({"v": 1, "kind": kind, "request": {}, "response": {"text": "", "summary": ""}})),
                expires_at=datetime.now(UTC) + timedelta(hours=hours_from_now),
            )
        )
        db.commit()


# --------------------------------------------------------------------------------------- default is OFF


def test_default_is_off_and_nothing_is_stored(env):
    c, key, _ = env
    cl = c.get("/api/workspace").json()["content_logging"]
    assert {k: cl[k] for k in ("enabled", "retention_days", "updated_at")} == {"enabled": False, "retention_days": 30, "updated_at": None}
    assert cl["keys_total"] == 1 and cl["keys_logging"] == 1  # the key switch is on, but the workspace master is off
    assert _chat(c, key, content="a private prompt").status_code == 200
    assert _rows() == []  # so nothing is captured: the workspace master switch wins
    item = c.get("/api/requests").json()["items"][0]
    assert item["has_content"] is False
    detail = c.get(f"/api/requests/{item['id']}/content").json()
    assert detail["content_status"] == "not_captured" and detail["content"] is None


def test_the_global_legacy_flag_does_not_turn_the_new_feature_on(env, monkeypatch):
    c, key, _ = env
    monkeypatch.setattr(settings, "LOG_BODIES", True)  # the legacy previews flag
    _chat(c, key)
    assert _rows() == []  # still off for the workspace


def test_enabling_is_recorded_and_visible_to_members(env, new_member):
    c, _key, _ = env
    mc, _uid = new_member(c)
    payload = _enable(c)
    assert payload["content_logging"]["enabled"] is True and payload["content_logging"]["updated_at"]
    seen = mc.get("/api/workspace").json()  # a Team Member can see that their traffic is logged
    assert seen["content_logging"]["enabled"] is True and "members" not in seen
    assert _enable(c, False)["content_logging"]["enabled"] is False


# ------------------------------------------------------------------- every supported kind, non-streaming


def _post(c, key, path, body, **extra):
    return c.post(path, json=body, headers=_auth(key), **extra)


CASES = {
    "chat-native": (
        lambda c, k: _chat(c, k),
        "chat",
        lambda p: p["request"]["messages"][-1] == {"role": "user", "text": "hello gateway"} and p["response"]["text"] == "reply to: hello gateway",
    ),
    "chat-legacy-anthropic": (
        lambda c, k: _chat(c, k, model="anthropic/claude-3-5-haiku"),
        "chat",
        lambda p: p["request"]["messages"][-1]["text"] == "hello gateway" and "hello gateway" in p["response"]["text"],
    ),
    "responses": (
        lambda c, k: _post(c, k, "/v1/responses", {"model": "gpt-4o-mini", "input": "hello gateway"}),
        "responses",
        lambda p: p["request"]["input"] == "hello gateway" and p["response"]["text"] == "reply to: hello gateway",
    ),
    "messages": (
        lambda c, k: _post(c, k, "/v1/messages", {"model": "claude-3-5-haiku", "max_tokens": 16, "system": "be terse",
                                                  "messages": [{"role": "user", "content": "hello gateway"}]}),
        "messages",
        lambda p: p["request"]["system"] == "be terse" and p["request"]["messages"][0]["text"] == "hello gateway"
        and p["response"]["text"] == "reply to: hello gateway",
    ),
    "gemini": (
        lambda c, k: _post(c, k, "/v1beta/models/gemini-3.8-flash:generateContent",
                           {"contents": [{"role": "user", "parts": [{"text": "hello gateway"}]}]}),
        "gemini",
        lambda p: p["request"]["model"] == "gemini-3.8-flash" and p["request"]["messages"][0]["text"] == "hello gateway"
        and p["response"]["text"].startswith("reply to:"),  # the mock Gemini response does not echo the prompt
    ),
    "embedding": (
        lambda c, k: _post(c, k, "/v1/embeddings", {"model": "text-embedding-3-small", "input": ["hello gateway", "second"]}),
        "embedding",
        lambda p: p["request"]["input"] == ["hello gateway", "second"] and p["response"]["summary"] == "2 embedding(s) x 3 dims"
        and p["response"]["text"] == "" and "0.1" not in _all_text(p),  # never the vectors
    ),
    "gemini-embed": (
        lambda c, k: _post(c, k, "/v1beta/models/gemini-embedding-001:embedContent", {"content": {"parts": [{"text": "hello gateway"}]}}),
        "embedding",
        lambda p: p["request"]["input"] == ["hello gateway"] and p["response"]["summary"] == "1 embedding(s) x 3 dims",
    ),
    "image": (
        lambda c, k: _post(c, k, "/v1/images/generations", {"model": "gpt-image-1", "prompt": "a red bicycle", "size": "1024x1024"}),
        "image",
        lambda p: p["request"]["prompt"] == "a red bicycle" and p["response"]["summary"] == "1 image(s)" and "ZmFrZQ" not in _all_text(p),
    ),
    "speech": (
        lambda c, k: _post(c, k, "/v1/audio/speech", {"model": "tts-1", "input": "say hello", "voice": "alloy"}),
        "speech",
        lambda p: p["request"]["input"] == "say hello" and "bytes audio" in p["response"]["summary"] and "FAKE_AUDIO" not in _all_text(p),
    ),
    "transcription": (
        lambda c, k: c.post("/v1/audio/transcriptions", data={"model": "whisper-1", "prompt": "names: Ada"},
                            files={"file": ("a.mp3", b"AUDIOBYTES", "audio/mpeg")}, headers=_auth(k)),
        "transcription",
        lambda p: p["request"]["file"] == {"name": "a.mp3", "bytes": 10} and p["request"]["prompt"] == "names: Ada"
        and p["response"]["text"] == "reply to: mock transcription" and "AUDIOBYTES" not in _all_text(p),
    ),
}


@pytest.mark.parametrize("name", list(CASES))
def test_each_supported_request_type_is_captured_when_enabled(env, name):
    c, key, _ = env
    call, kind, check = CASES[name]
    _enable(c)
    assert call(c, key).status_code == 200
    (row,) = _rows()
    assert row.kind == kind and not row.request_truncated and not row.response_truncated
    assert check(_payload(row)), _payload(row)
    detail = c.get(f"/api/requests/{_first_usage_id(c)}/content")
    assert detail.status_code == 200 and detail.headers["cache-control"] == "no-store"
    body = detail.json()
    assert body["content_status"] == "available" and body["content"]["kind"] == kind
    assert c.get("/api/requests").json()["items"][0]["has_content"] is True


# ---------------------------------------------------------------------------------------------- streaming


def _consume(c, path, body, key):
    with c.stream("POST", path, json=body, headers=_auth(key)) as r:
        assert r.status_code == 200
        r.read()


STREAMS = {
    "chat-native": ("/v1/chat/completions", {"model": "openai/gpt-4o-mini", "stream": True, "messages": [{"role": "user", "content": "stream me"}]}, "chat"),
    "responses": ("/v1/responses", {"model": "gpt-4o-mini", "stream": True, "input": "stream me"}, "responses"),
    "messages": ("/v1/messages", {"model": "claude-3-5-haiku", "stream": True, "max_tokens": 16, "messages": [{"role": "user", "content": "stream me"}]}, "messages"),
    "gemini": ("/v1beta/models/gemini-3.8-flash:streamGenerateContent", {"contents": [{"role": "user", "parts": [{"text": "stream me"}]}]}, "gemini"),
    "chat-legacy-gemini": ("/v1/chat/completions", {"model": "gemini/gemini-3.8-flash", "stream": True, "messages": [{"role": "user", "content": "stream me"}]}, "chat"),
}


@pytest.mark.parametrize("name", list(STREAMS))
def test_streams_are_captured_with_the_full_text(env, name):
    c, key, _ = env
    path, body, kind = STREAMS[name]
    _enable(c)
    _consume(c, path, body, key)
    deadline = time.monotonic() + 3
    while not _rows() and time.monotonic() < deadline:
        time.sleep(0.05)
    (row,) = _rows()
    payload = _payload(row)
    assert row.kind == kind and payload["response"]["text"] == "hello world"
    assert "stream me" in _all_text(payload["request"])


def test_a_stream_is_not_captured_when_logging_is_off(env):
    c, key, _ = env
    path, body, _kind = STREAMS["chat-native"]
    _consume(c, path, body, key)
    assert _rows() == [] and len(_usage()) == 1  # analytics still recorded


def _stream_harness(admin_client, key, lines_fn, capture_kind="chat"):
    ws_id = admin_client.get("/api/workspace").json()["id"]
    req, trunc, size = content_capture.build_request(capture_kind, {"messages": [{"role": "user", "content": "q"}]})
    capture = content_capture.ContentCapture(ws_id, capture_kind, req, trunc, size)
    gen = stream_native_passthrough(
        key["id"], "openai", "gpt-4o-mini", "q",
        stream_fn=lambda b, k: lines_fn(),
        accumulator_cls=openai_adapter.ChatStreamUsageAccumulator,
        api_key="sk-fake", body={}, capture=capture,
    )
    return gen, capture


def test_lines_reach_the_client_before_the_upstream_finishes_and_capture_never_holds_them_back(env):
    c, key, _ = env
    gate = threading.Event()

    def lines():
        yield 'data: {"choices":[{"delta":{"content":"hello "}}]}'
        assert gate.wait(10), "the upstream was never released"
        yield 'data: {"choices":[{"delta":{"content":"world"}}]}'
        yield 'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2}}'

    gen, capture = _stream_harness(c, key, lines)
    first = next(gen)  # returns while the upstream generator is still blocked on the gate
    assert "hello " in first and not gate.is_set()
    assert capture.response_text == ""  # nothing is finalised until the stream ends
    gate.set()
    list(gen)
    assert capture.response_text == "hello world"
    assert capture.response_truncated is False


def test_capture_memory_stays_bounded_for_a_huge_stream(env, monkeypatch):
    c, key, _ = env
    monkeypatch.setattr(settings, "CONTENT_MAX_BYTES", 1024)

    def lines():
        for _ in range(5000):
            yield 'data: {"choices":[{"delta":{"content":"' + "y" * 200 + '"}}]}'

    gen, capture = _stream_harness(c, key, lines)
    forwarded = sum(1 for _ in gen)
    assert forwarded >= 5000  # the client still got every line
    assert capture.response_truncated is True
    assert len(capture.response_text.encode()) <= 1024 + len(" …[truncated]") + 8
    assert capture._stream.size <= 2048  # the buffer itself never grew past its cap


def test_a_stream_that_fails_stores_the_request_only(env):
    c, key, _ = env
    _enable(c)

    def lines():
        yield 'data: {"choices":[{"delta":{"content":"partial"}}]}'
        raise RuntimeError("upstream broke")

    gen, capture = _stream_harness(c, key, lines)
    out = "".join(gen)
    assert "event: error" in out
    assert capture.response_text == ""  # not finalised for an error
    rows = _rows()
    assert len(rows) == 1 and _payload(rows[0])["response"] == {"text": "", "summary": ""}
    assert len(_usage()) == 1 and _usage()[0].status == "error"


# --------------------------------------------------------------------------------- analytics unchanged


def test_enabling_capture_changes_no_analytics(env):
    c, key, _ = env

    def run() -> None:
        _chat(c, key)
        _post(c, key, "/v1/responses", {"model": "gpt-4o-mini", "input": "hi"})
        _post(c, key, "/v1/messages", {"model": "claude-3-5-haiku", "max_tokens": 8, "messages": [{"role": "user", "content": "hi"}]})
        _post(c, key, "/v1beta/models/gemini-3.8-flash:generateContent", {"contents": [{"role": "user", "parts": [{"text": "hi"}]}]})
        _post(c, key, "/v1/embeddings", {"model": "text-embedding-3-small", "input": "hi"})

    def shape() -> list[tuple]:
        return [(u.provider, u.model, u.prompt_tokens, u.completion_tokens, u.total_tokens,
                 float(u.cost) if u.cost is not None else None, u.cost_source, u.status) for u in _usage()]

    run()
    off = shape()
    assert _rows() == []
    _enable(c)
    run()
    both = shape()
    assert both[: len(off)] == off and both[len(off):] == off  # identical rows, field for field
    assert len(_rows()) == len(off)
    assert c.get("/api/usage/summary").json()["total_requests"] == 2 * len(off)


# --------------------------------------------------------------------------------- credentials / safety

LEAKY = (
    "my key is sk-proj-abcdefghijklmnopqrstuvwx and vk_abcdefghijklmnop123 plus "
    "Bearer abcdefghijklmnopqrstuvwxyz1234 and password=hunter2hunter2 and AQ.Ab8RN6LUzgQ-NbIwNTOf96NC6_Y-Rz1G"
)


def test_credentials_and_unknown_fields_are_never_stored(env):
    c, key, _ = env
    _enable(c)
    r = _chat(
        c, key, content=LEAKY,
        api_key="sk-TOPLEVEL-SHOULD-NOT-BE-STORED-123456",
        metadata={"authorization": "Bearer zzzzzzzzzzzzzzzzzzzzzzzz"},
        user="alice@example.com",
        logit_bias={"50256": -100},
    )
    assert r.status_code == 200
    dumped = _all_text(_payload(_rows()[0]))
    for secret in ("sk-proj-abcdefghijklmnopqrstuvwx", "vk_abcdefghijklmnop123", "abcdefghijklmnopqrstuvwxyz1234",
                   "hunter2hunter2", "AQ.Ab8RN6LUzgQ", "TOPLEVEL", "zzzzzzzz", "alice@example.com", "logit_bias"):
        assert secret not in dumped, secret
    assert key["key"] not in dumped and "sk-fake-" not in dumped  # neither the virtual key nor an upstream key
    assert dumped.count("[REDACTED:") >= 5
    # and the echoed response text was redacted too
    assert "sk-proj" not in _payload(_rows()[0])["response"]["text"]


def test_media_is_replaced_by_placeholders(env):
    c, key, _ = env
    _enable(c)
    content = [
        {"type": "text", "text": "look at this"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA"}},
        {"type": "input_audio", "input_audio": {"data": "QUJDREVGR0hJSktM", "format": "wav"}},
    ]
    assert _chat(c, key, content=content).status_code == 200
    payload = _payload(_rows()[0])
    assert payload["request"]["messages"][-1]["text"] == "look at this\n[image]\n[audio]"
    assert "iVBOR" not in _all_text(payload) and "QUJDRE" not in _all_text(payload)


def test_oversized_content_is_truncated_and_flagged(env, monkeypatch):
    c, key, _ = env
    monkeypatch.setattr(settings, "CONTENT_MAX_BYTES", 2048)
    monkeypatch.setattr(settings, "CONTENT_MAX_FIELD_CHARS", 500)
    _enable(c)
    assert _chat(c, key, content="x" * 5000).status_code == 200
    (row,) = _rows()
    assert row.request_truncated and row.response_truncated
    payload = _payload(row)
    text_in = payload["request"]["messages"][-1]["text"]
    assert text_in.endswith("…[truncated]") and len(text_in) < 600
    body = c.get(f"/api/requests/{_first_usage_id(c)}/content").json()
    assert body["request_truncated"] is True and body["response_truncated"] is True


@pytest.mark.parametrize("kind", [k for k in content_capture.KINDS if k != "transcription"])
@pytest.mark.parametrize(
    "body",
    [
        {},
        {"messages": "oops", "input": 5, "contents": None, "prompt": 7, "tools": "x"},
        {"messages": [None, 3, "x", {"role": None, "content": [1, None, {"type": 5}]}], "contents": [{"parts": [1, None]}]},
        {"messages": [{"role": "user", "content": {"deep": {"er": [1, 2, 3]}}}], "input": {"a": 1}, "requests": [None, 5]},
        {"input": [[1, 2, 3], None, 4.5, {"x": 1}], "content": {"parts": "nope"}},
    ],
)
def test_odd_request_shapes_are_normalised_never_raise(kind, body):
    request, truncated, size = content_capture.build_request(kind, body)
    json.dumps(request)  # always serialisable
    assert isinstance(truncated, bool) and size >= 0


def test_malformed_but_accepted_requests_still_succeed_and_are_captured(env):
    c, key, _ = env
    _enable(c)
    body = {"model": "openai/gpt-4o-mini", "messages": [{"role": "user", "content": None}, {"role": "user", "content": [1, {"type": 9}]}, {"role": "user", "content": "ok"}]}
    assert c.post("/v1/chat/completions", json=body, headers=_auth(key)).status_code == 200
    payload = _payload(_rows()[0])
    assert [m["text"] for m in payload["request"]["messages"]][-1] == "ok"


# ------------------------------------------------------------------------------------- failure handling


def test_a_capture_failure_never_affects_the_request_or_its_analytics(env, monkeypatch, caplog):
    c, key, _ = env
    _enable(c)

    def boom(_plain):
        raise RuntimeError("boom-secret-detail")

    monkeypatch.setattr(content_capture.crypto, "encrypt", boom)
    with caplog.at_level(logging.WARNING, logger="app.content_capture"):
        r = _chat(c, key)
    assert r.status_code == 200 and r.json()["choices"][0]["message"]["content"] == "reply to: hello gateway"
    assert _rows() == [] and len(_usage()) == 1 and _usage()[0].status == "success"
    logged = " ".join(rec.getMessage() for rec in caplog.records)
    assert "store failed" in logged and "RuntimeError" in logged and "boom-secret-detail" not in logged


def test_a_failure_while_starting_capture_is_swallowed(env, monkeypatch):
    c, key, _ = env
    _enable(c)
    monkeypatch.setattr(content_capture, "build_request", lambda *a, **k: (_ for _ in ()).throw(ValueError("bad")))
    assert _chat(c, key).status_code == 200
    assert _rows() == [] and len(_usage()) == 1


def test_a_provider_failure_stores_the_request_but_no_error_text(env, monkeypatch):
    c, key, _ = env
    _enable(c)

    def exploding(url, headers, json_body, *, timeout=60.0):
        raise RuntimeError("upstream exploded at 10.0.0.7")

    monkeypatch.setattr("app.providers.send_request", exploding)
    assert _chat(c, key).status_code == 502
    assert _usage()[0].status == "error"
    (row,) = _rows()
    dumped = _all_text(_payload(row))
    assert "hello gateway" in dumped and "exploded" not in dumped and "10.0.0.7" not in dumped and "call failed" not in dumped


def test_unreadable_content_is_reported_not_raised(env, monkeypatch):
    c, key, _ = env
    _enable(c)
    _chat(c, key)
    monkeypatch.setattr(content_capture.crypto, "decrypt", lambda _c: None)  # e.g. ENCRYPTION_KEY changed
    assert c.get(f"/api/requests/{_first_usage_id(c)}/content").json()["content_status"] == "unreadable"


def test_content_is_encrypted_at_rest(env):
    c, key, _ = env
    _enable(c)
    _chat(c, key, content="a very distinctive sentence about pelicans")
    with SessionLocal() as db:
        raw = db.scalar(text("select content_encrypted from usage_content"))
    assert "pelicans" not in raw and raw.startswith("gAAAA")  # a Fernet token, not plaintext


def test_an_idempotent_replay_captures_nothing_new(env):
    c, key, _ = env
    _enable(c)
    h = _auth(key, **{"Idempotency-Key": "same-key-1"})
    body = {"model": "openai/gpt-4o-mini", "messages": [{"role": "user", "content": "once"}]}
    assert c.post("/v1/chat/completions", json=body, headers=h).status_code == 200
    assert c.post("/v1/chat/completions", json=body, headers=h).status_code == 200  # replay
    assert len(_usage()) == 1 and len(_rows()) == 1


# -------------------------------------------------------------------------------------- authorisation


def test_only_workspace_admins_can_read_or_change_content_settings(env, new_member, client):
    c, key, _ = env
    _enable(c)
    _chat(c, key)
    uid = _first_usage_id(c)
    mc, _ = new_member(c)
    assert mc.get(f"/api/requests/{uid}/content").status_code == 403
    assert mc.patch("/api/workspace/content-logging", json={"enabled": False}).status_code == 403
    assert mc.delete("/api/workspace/content").status_code == 403
    assert client.get(f"/api/requests/{uid}/content").status_code == 401  # signed out
    assert client.patch("/api/workspace/content-logging", json={"enabled": True}).status_code == 401
    assert c.get("/api/workspace").json()["content_logging"]["enabled"] is True  # nothing was changed


def test_another_workspace_can_neither_read_nor_affect_content(env, new_admin):
    a, key, _ = env
    _enable(a)
    _chat(a, key)
    uid = _first_usage_id(a)
    b, b_ws = new_admin("Other")
    assert b.get(f"/api/requests/{uid}/content").status_code == 404  # not found, not "forbidden"
    assert b.get("/api/requests").json()["items"] == []
    assert b.get("/api/requests/999999/content").status_code == 404
    _enable(b)
    assert a.get("/api/workspace").json()["content_logging"]["enabled"] is True  # b's switch is its own
    assert b.delete("/api/workspace/content").json() == {"deleted": 0} and len(_rows()) == 1
    # belt and braces: even a content row mis-labelled with another workspace is not served to the owner
    with SessionLocal() as db:
        db.execute(text("update usage_content set workspace_id = :w"), {"w": b_ws["id"]})
        db.commit()
    assert a.get(f"/api/requests/{uid}/content").json()["content_status"] == "not_captured"
    assert b.get(f"/api/requests/{uid}/content").status_code == 404


# ------------------------------------------------------------------------------------------- retention


def test_content_expires_exactly_30_days_after_capture(env):
    c, key, _ = env
    _enable(c)
    _chat(c, key)
    (row,) = _rows()
    assert row.expires_at - row.created_at == timedelta(days=30)


def test_retention_cannot_be_configured_beyond_30_days():
    assert Settings().CONTENT_RETENTION_DAYS == 30
    with pytest.raises(ValueError):
        Settings(CONTENT_RETENTION_DAYS=31)
    with pytest.raises(ValueError):
        Settings(CONTENT_RETENTION_DAYS=0)


def test_expired_content_is_never_returned_even_before_the_sweep_deletes_it(env):
    c, key, _ = env
    _enable(c)
    _chat(c, key)
    uid = _first_usage_id(c)
    with SessionLocal() as db:
        db.execute(text("update usage_content set expires_at = now() - interval '1 hour'"))
        db.commit()
    assert len(_rows()) == 1  # still physically there...
    assert c.get(f"/api/requests/{uid}/content").json() == {"usage_id": uid, "retention_days": 30, "content": None, "content_status": "expired"}
    assert c.get("/api/requests").json()["items"][0]["has_content"] is False  # ...but invisible
    assert _rows() == []  # and loading the first page opportunistically swept it


def test_cleanup_deletes_only_expired_rows_in_batches(env):
    c, key, _ = env
    for _ in range(3):
        _chat(c, key)
    ws = c.get("/api/workspace").json()["id"]
    ids = [u.id for u in _usage()]
    _insert_content(ids[0], ws, -2)
    _insert_content(ids[1], ws, -1)
    _insert_content(ids[2], ws, +24)
    with SessionLocal() as db:
        assert content_capture.cleanup_expired(db, limit=1) == 1
        assert content_capture.cleanup_expired(db, limit=10) == 1
        assert content_capture.cleanup_expired(db, limit=10) == 0
    assert [r.usage_log_id for r in _rows()] == [ids[2]]  # the live one is untouched


def test_the_startup_sweep_removes_expired_content(env):
    c, key, _ = env
    _chat(c, key)
    ws = c.get("/api/workspace").json()["id"]
    _insert_content(_usage()[0].id, ws, -5)
    content_capture.cleanup_expired_startup()
    assert _rows() == []


def test_a_capture_opportunistically_sweeps_expired_content(env, monkeypatch):
    c, key, _ = env
    _chat(c, key)  # logging off: just a usage row to attach an expired record to
    ws = c.get("/api/workspace").json()["id"]
    _insert_content(_usage()[0].id, ws, -5)
    monkeypatch.setattr(content_capture, "_SWEEP_PROBABILITY", 1.0)
    _enable(c)
    _chat(c, key)
    assert [r.usage_log_id for r in _rows()] == [_usage()[1].id]


def test_capture_pauses_at_the_workspace_row_cap_without_failing_requests(env, monkeypatch):
    c, key, _ = env
    monkeypatch.setattr(settings, "CONTENT_MAX_ROWS_PER_WORKSPACE", 1)
    _enable(c)
    assert _chat(c, key).status_code == 200 and _chat(c, key).status_code == 200
    assert len(_rows()) == 1 and len(_usage()) == 2


def test_disabling_stops_capture_keeps_existing_content_and_delete_purges_it(env):
    c, key, _ = env
    _enable(c)
    _chat(c, key)
    _enable(c, False)
    _chat(c, key)
    assert len(_rows()) == 1 and len(_usage()) == 2
    flags = [i["has_content"] for i in c.get("/api/requests").json()["items"]]
    assert flags == [False, True]  # newest first: the second request was not captured
    assert c.delete("/api/workspace/content").json() == {"deleted": 1}
    assert _rows() == [] and len(_usage()) == 2  # analytics untouched


def test_deleting_the_workspace_removes_its_content(env):
    c, key, _ = env
    _enable(c)
    _chat(c, key)
    assert c.delete("/api/workspace").status_code == 200
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(UsageContent)) == 0
        assert db.scalar(select(func.count()).select_from(UsageLog)) == 0


# --------------------------------------------------------------------------------------------- migration


def test_migration_is_idempotent_and_existing_workspaces_stay_off(admin_client):
    with SessionLocal() as db:
        bootstrap._migrate(db)
        bootstrap._migrate(db)
    assert admin_client.get("/api/workspace").json()["content_logging"]["enabled"] is False


def test_migration_upgrades_an_old_schema_without_touching_existing_data(env):
    c, key, _ = env
    _chat(c, key)  # an existing usage row
    with SessionLocal() as db:
        db.execute(text("drop table usage_content_images, usage_content"))  # the images table depends on it
        db.execute(text(
            "alter table workspaces drop column content_logging_enabled, "
            "drop column content_logging_updated_at, drop column content_logging_updated_by"
        ))
        db.commit()
        bootstrap._migrate(db)
        assert bootstrap._has_table(db, "usage_content")
        for col in ("content_logging_enabled", "content_logging_updated_at", "content_logging_updated_by"):
            assert bootstrap._has_col(db, "workspaces", col)
        assert db.scalar(text("select content_logging_enabled from workspaces")) is False
        assert db.scalar(select(func.count()).select_from(UsageLog)) == 1
    assert c.get("/api/workspace").json()["content_logging"]["enabled"] is False


def test_the_legacy_response_fields_are_preserved(env):
    c, key, _ = env
    _chat(c, key)
    body = c.get("/api/requests").json()
    assert body["bodies_logged"] in (True, False) and body["content_logging_enabled"] is False
    item = body["items"][0]
    assert {"prompt_preview", "response_preview", "has_content"} <= set(item)
