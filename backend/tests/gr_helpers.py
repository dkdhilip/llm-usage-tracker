"""Shared helpers for the guardrail tests: install rules on a key, and the table of every gateway route."""
from sqlalchemy import select

from app import guardrails
from app.db import SessionLocal
from app.models import GuardrailHit, GuardrailRule, GuardrailRuleSet, UsageLog, VirtualKey

ALL = ["openai", "anthropic", "gemini", "openrouter"]
TRIGGER = "the launch codename is bluefalcon"
RULE_BLOCK = ("phrase", "bluefalcon", "block")


def install(key_id: int, *rules, set_name: str = "Test set", **over) -> int:
    """Create a rule set with these (kind, pattern, action[, extras]) rules and attach it to the key. Returns set id."""
    with SessionLocal() as db:
        vk = db.get(VirtualKey, key_id)
        rs = GuardrailRuleSet(workspace_id=vk.workspace_id, name=set_name, enabled=over.get("enabled", True))
        db.add(rs)
        db.flush()
        for i, r in enumerate(rules):
            kind, pattern, action, *extra = r
            extras = extra[0] if extra else {}
            db.add(GuardrailRule(
                rule_set_id=rs.id, name=extras.pop("name", f"rule-{i}"), kind=kind,
                pattern=None if kind == "preset" else pattern, preset_id=pattern if kind == "preset" else None,
                action=action, position=i, **extras,
            ))
        db.flush()
        guardrails.attach_rule_sets(db, vk, [rs.id])
        db.commit()
        return rs.id


def hits() -> list[GuardrailHit]:
    with SessionLocal() as db:
        return list(db.scalars(select(GuardrailHit).order_by(GuardrailHit.id)))


def usage() -> list[UsageLog]:
    with SessionLocal() as db:
        return list(db.scalars(select(UsageLog).order_by(UsageLog.id)))


def bearer(k: str) -> dict:
    return {"authorization": f"Bearer {k}"}


def _chat(model, stream=False):
    return lambda t: dict(path="/v1/chat/completions", json={"model": model, "stream": stream, "messages": [{"role": "user", "content": t}]})


def _messages(stream=False):
    return lambda t: dict(path="/v1/messages", json={
        "model": "claude-3-5-haiku-20241022", "max_tokens": 20, "stream": stream, "messages": [{"role": "user", "content": t}]})


def _responses(stream=False):
    return lambda t: dict(path="/v1/responses", json={"model": "gpt-4o-mini", "stream": stream, "input": t})


def _gemini(op):
    def build(t):
        body = {"contents": [{"role": "user", "parts": [{"text": t}]}]}
        if op == "embedContent":
            body = {"content": {"parts": [{"text": t}]}}
        if op == "batchEmbedContents":
            body = {"requests": [{"model": "models/text-embedding-004", "content": {"parts": [{"text": t}]}}]}
        return dict(path=f"/v1beta/models/gemini-1.5-flash:{op}", json=body)
    return build


# (id, builder(text) -> request kwargs, streaming)
ROUTES = [
    ("chat-native", _chat("openai/gpt-4o-mini"), False),
    ("chat-native-stream", _chat("openai/gpt-4o-mini", True), True),
    ("chat-legacy", _chat("anthropic/claude-3-5-haiku-20241022"), False),
    ("chat-legacy-stream", _chat("anthropic/claude-3-5-haiku-20241022", True), True),
    ("messages", _messages(), False),
    ("messages-stream", _messages(True), True),
    ("responses", _responses(), False),
    ("responses-stream", _responses(True), True),
    ("embeddings", lambda t: dict(path="/v1/embeddings", json={"model": "text-embedding-3-small", "input": t}), False),
    ("images", lambda t: dict(path="/v1/images/generations", json={"model": "gpt-image-1", "prompt": t}), False),
    ("transcription", lambda t: dict(
        path="/v1/audio/transcriptions", files={"file": ("clip.mp3", b"FAKE_MP3_CONTENT", "audio/mpeg")},
        data={"model": "whisper-1", "prompt": t}), False),
    ("speech", lambda t: dict(path="/v1/audio/speech", json={"model": "tts-1", "input": t, "voice": "alloy"}), False),
    ("gemini-generate", _gemini("generateContent"), False),
    ("gemini-stream", _gemini("streamGenerateContent"), True),
    ("gemini-embed", _gemini("embedContent"), False),
    ("gemini-batch-embed", _gemini("batchEmbedContents"), False),
    ("proxy-chat", lambda t: dict(path="/v1/proxy/chat", json={"provider": "openai", "model": "gpt-4o-mini", "prompt": t}), False),
]
ROUTE_IDS = [r[0] for r in ROUTES]


def call(client, key, route, text, extra_headers=None):
    _, build, _ = next(r for r in ROUTES if r[0] == route)
    kw = build(text)
    path = kw.pop("path")
    return client.post(path, headers={**bearer(key), **(extra_headers or {})}, **kw)
