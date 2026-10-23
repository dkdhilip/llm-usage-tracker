"""Opt-in prompt/response content capture for workspace admins (30-day retention).

OFF by default per workspace (`workspaces.content_logging_enabled`). When a workspace turns it on, the
gateway stores a bounded, redacted, Fernet-encrypted copy of each supported request and its response in
`usage_content`, linked 1:1 to the `usage_logs` row, readable only by that workspace's admins and gone after
`settings.CONTENT_RETENTION_DAYS` (max 30). Independent of the legacy global LOG_BODIES flag.

Design rules (see the approved plan):

* **Never in the way.** The usage row is committed first; content is stored afterwards in its own session and
  transaction, and every public function here swallows its own errors (logging only the exception CLASS, never
  its message or any content). A capture problem can therefore never fail a request or touch analytics.
* **Whitelist, not blacklist.** Only the prompt-bearing fields of each endpoint's *JSON body* are read, so a
  stray `api_key`/`metadata`/`user` field in a body is never stored. Headers, cookies and virtual-key or
  provider-key material are not reachable from here at all. Images, audio, embedding vectors and base64 media
  are replaced by short placeholders or summaries, never stored.
* **Bounded.** Every text field is cut at CONTENT_MAX_FIELD_CHARS and each side (request / response) at
  CONTENT_MAX_BYTES of redacted UTF-8 text; a `truncated` flag records any cut. Streams are observed line by
  line into a capped buffer, so memory is bounded and the client's stream is never held back.
* **Best-effort redaction** of well-known credential shapes. It is NOT PII scrubbing or DLP: personal data a
  user types into a prompt is stored as typed.
"""

import json
import logging
import random
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import timedelta

from sqlalchemy import delete, func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app import content_images, crypto
from app.config import settings
from app.db import SessionLocal
from app.models import UsageContent, UsageContentImage, VirtualKey, Workspace

logger = logging.getLogger("app.content_capture")

KINDS = ("chat", "responses", "messages", "gemini", "embedding", "image", "speech", "transcription")

_MAX_MESSAGES = 50  # the first system/developer message plus the most recent ones
_MAX_TOOLS = 50
_SWEEP_PROBABILITY = 0.02  # share of captures that also run an opportunistic expiry sweep
_SWEEP_MAX_BATCHES = 20  # one scheduled run deletes at most this many batches (bounded work per trigger)
_SWEEP_BATCH = 500  # records per scheduled-sweep batch
_PRESTORE_CLEANUP_LIMIT = 50  # records freed synchronously by an image-bearing request (the sweep does the bulk)
_SWEEP_RETRY_SECONDS = 300  # after a failed/unstartable sweep, the next attempt is allowed this much later

# Throttled sweep state (see maybe_sweep). `_last_sweep` is a time.monotonic() reading, None = never this boot.
_last_sweep: float | None = None
_sweep_lock = threading.Lock()
_SWEEP_INLINE = False  # tests only: run the sweep in the calling thread instead of a background thread
_TRUNC = " …[truncated]"

# ---------------------------------------------------------------------------------------------- redaction

_SECRET_ASSIGN = re.compile(
    r"(?i)\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd)\b"
    r"(\s*[:=]\s*)(['\"]?)([^\s'\",;]{6,})"
)

# Most specific first. Each entry replaces the whole match with [REDACTED:<name>].
_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("private-key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|\Z)", re.S)),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")),
    ("anthropic-key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{8,}")),
    ("openai-key", re.compile(r"\bsk-[A-Za-z0-9_-]{16,}")),
    ("virtual-key", re.compile(r"\bvk_[A-Za-z0-9_-]{8,}")),
    ("google-key", re.compile(r"\bAIza[0-9A-Za-z_-]{20,}")),
    ("google-key", re.compile(r"\bAQ\.[A-Za-z0-9_-]{20,}")),
    ("github-token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}")),
    ("slack-token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
    ("aws-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("bearer-token", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{16,}")),
]


def redact(text: str) -> str:
    """Replace well-known credential shapes with [REDACTED:<kind>]. Best-effort, not DLP."""
    for name, rx in _PATTERNS:
        text = rx.sub(f"[REDACTED:{name}]", text)
    return _SECRET_ASSIGN.sub(lambda m: f"{m.group(1)}{m.group(2)}{m.group(3)}[REDACTED:secret]", text)


class _Budget:
    """Redacts and size-limits the text of ONE side of a record. Redaction runs on the whole field before any
    cut, so a credential can never survive as a partial fragment at a truncation boundary."""

    def __init__(self, max_bytes: int | None = None) -> None:
        self.left = settings.CONTENT_MAX_BYTES if max_bytes is None else max_bytes
        self.truncated = False
        self.used = 0

    def text(self, value) -> str:
        s = value if isinstance(value, str) else str(value)
        field_cap = settings.CONTENT_MAX_FIELD_CHARS
        cut = len(s) > field_cap
        s = redact(s[: field_cap + 256])  # bound the regex work on huge inputs
        if len(s) > field_cap:
            s, cut = s[:field_cap], True
        raw = s.encode("utf-8")
        if len(raw) > self.left:
            s, cut = raw[: max(self.left, 0)].decode("utf-8", "ignore"), True
            raw = s.encode("utf-8")
        self.left -= len(raw)
        self.used += len(raw)
        if cut:
            self.truncated = True
            return s + _TRUNC
        return s


# --------------------------------------------------------------------------------- request normalisation


def _json_short(value, limit: int = 500) -> str:
    try:
        return json.dumps(value, ensure_ascii=False)[:limit]
    except (TypeError, ValueError):
        return "?"


def _parts_text(content) -> str:
    """Flatten message content (a string, or a list of typed parts) to text. Media becomes a placeholder."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        content = [content]
    if not isinstance(content, list):
        return str(content)
    out: list[str] = []
    for part in content:
        if isinstance(part, str):
            out.append(part)
            continue
        if not isinstance(part, dict):
            out.append(str(part))
            continue
        kind = part.get("type")
        if isinstance(part.get("text"), str):  # text / input_text / output_text / Gemini {"text": ...}
            out.append(part["text"])
        elif part.get("inlineData") or part.get("inline_data"):
            blob = part.get("inlineData") or part.get("inline_data")
            out.append(f"[inline data: {blob.get('mimeType') or blob.get('mime_type') or 'unknown'}]" if isinstance(blob, dict) else "[inline data]")
        elif part.get("fileData") or part.get("file_data"):
            out.append("[file]")
        elif isinstance(part.get("functionCall"), dict) or isinstance(part.get("function_call"), dict):
            call = part.get("functionCall") or part.get("function_call")
            out.append(f"[function_call {call.get('name')}({_json_short(call.get('args'))})]")
        elif isinstance(part.get("functionResponse"), dict):
            out.append(f"[function_response {part['functionResponse'].get('name')}]")
        elif kind in ("image_url", "input_image", "image"):
            out.append("[image]")
        elif kind in ("input_audio", "audio"):
            out.append("[audio]")
        elif kind in ("file", "input_file", "document"):
            out.append("[file]")
        elif kind == "tool_use":
            out.append(f"[tool_use {part.get('name')}({_json_short(part.get('input'))})]")
        elif kind == "tool_result":
            out.append("[tool_result] " + _parts_text(part.get("content")))
        elif kind in ("thinking", "redacted_thinking", "reasoning") or part.get("thought") is True:
            continue  # internal reasoning is not part of the conversation
        else:
            out.append(f"[{kind or 'part'}]")
    return "\n".join(x for x in out if x)


def _tool_calls_text(message: dict) -> str:
    calls = message.get("tool_calls")
    if not isinstance(calls, list):
        return ""
    parts = []
    for c in calls:
        fn = c.get("function") if isinstance(c, dict) else None
        if isinstance(fn, dict):
            parts.append(f"[tool_call {fn.get('name')}({str(fn.get('arguments'))[:500]})]")
    return "\n".join(parts)


def _tool_names(tools) -> list[str]:
    names: list[str] = []
    if isinstance(tools, list):
        for t in tools[:_MAX_TOOLS]:
            if not isinstance(t, dict):
                continue
            if isinstance(t.get("functionDeclarations"), list):
                names += [str(d.get("name"))[:100] for d in t["functionDeclarations"] if isinstance(d, dict)]
                continue
            fn = t.get("function") if isinstance(t.get("function"), dict) else t
            names.append(str(fn.get("name") or t.get("type") or "tool")[:100])
    return names[:_MAX_TOOLS]


def _params(body: dict, keys: tuple[str, ...]) -> dict:
    out = {}
    for k in keys:
        v = body.get(k)
        if isinstance(v, (bool, int, float)) or (isinstance(v, str) and len(v) <= 64):
            out[k] = v
    return out


def _messages(msgs, b: _Budget) -> list[dict]:
    if msgs is None:
        return []
    if not isinstance(msgs, list):
        return [{"role": "", "text": b.text(_parts_text(msgs))}]
    chosen = msgs
    if len(msgs) > _MAX_MESSAGES:
        first_system = next((m for m in msgs if isinstance(m, dict) and m.get("role") in ("system", "developer")), None)
        tail = msgs[-(_MAX_MESSAGES - (1 if first_system else 0)) :]
        chosen = ([first_system] if first_system and first_system not in tail else []) + tail
        b.truncated = True
    out = []
    for m in chosen:
        if isinstance(m, dict):
            text = _parts_text(m.get("content") if "content" in m else m.get("parts"))
            extra = _tool_calls_text(m)
            out.append({"role": str(m.get("role", ""))[:32], "text": b.text("\n".join(x for x in (text, extra) if x))})
        else:
            out.append({"role": "", "text": b.text(str(m))})
    return out


def _input_items(value, b: _Budget):
    """OpenAI Responses `input`: a string, or a list of message/typed items."""
    if isinstance(value, str):
        return b.text(value)
    if not isinstance(value, list):
        return b.text(_json_short(value)) if value is not None else ""
    out = []
    for item in value[:_MAX_MESSAGES]:
        if isinstance(item, dict) and ("role" in item or item.get("type") == "message"):
            out.append({"role": str(item.get("role", ""))[:32], "text": b.text(_parts_text(item.get("content")))})
        elif isinstance(item, dict):
            out.append({"role": "", "text": b.text(f"[{item.get('type', 'item')}] " + _json_short(item.get("arguments") or item.get("output") or ""))})
        else:
            out.append({"role": "", "text": b.text(str(item))})
    return out


def _embedding_inputs(body: dict, b: _Budget) -> list[str]:
    raw = body.get("input")
    if raw is None and isinstance(body.get("content"), dict):  # Gemini embedContent
        raw = _parts_text(body["content"].get("parts"))
    if raw is None and isinstance(body.get("requests"), list):  # Gemini batchEmbedContents
        raw = [_parts_text((r.get("content") or {}).get("parts")) for r in body["requests"] if isinstance(r, dict)]
    items = raw if isinstance(raw, list) else [raw]
    out = []
    for x in items[:100]:
        if isinstance(x, str):
            out.append(b.text(x))
        elif isinstance(x, list):  # a token array
            out.append(f"[{len(x)} tokens]")
        elif x is not None:
            out.append(b.text(str(x)))
    return out


def build_request(kind: str, body: dict, model: str | None = None) -> tuple[dict, bool, int]:
    """The whitelisted, redacted, size-limited request side for `kind`. Returns (request, truncated, bytes)."""
    if kind not in KINDS:
        raise ValueError(f"unsupported content kind {kind!r}")
    body = body if isinstance(body, dict) else {}
    b = _Budget()
    m = str(model or body.get("model") or "")[:200]
    if kind == "chat":
        req = {"model": m, "messages": _messages(body.get("messages"), b), "tools": _tool_names(body.get("tools")),
               "params": _params(body, ("temperature", "top_p", "max_tokens", "max_completion_tokens", "stream"))}
    elif kind == "responses":
        req = {"model": m, "instructions": b.text(body["instructions"]) if isinstance(body.get("instructions"), str) else "",
               "input": _input_items(body.get("input"), b), "tools": _tool_names(body.get("tools")),
               "params": _params(body, ("temperature", "top_p", "max_output_tokens", "stream"))}
    elif kind == "messages":
        system = body.get("system")
        req = {"model": m, "system": b.text(_parts_text(system)) if system else "", "messages": _messages(body.get("messages"), b),
               "tools": _tool_names(body.get("tools")), "params": _params(body, ("temperature", "top_p", "max_tokens", "stream"))}
    elif kind == "gemini":
        sys_i = body.get("systemInstruction") or body.get("system_instruction")
        cfg = body.get("generationConfig") if isinstance(body.get("generationConfig"), dict) else {}
        req = {"model": m, "system": b.text(_parts_text((sys_i or {}).get("parts"))) if isinstance(sys_i, dict) else "",
               "messages": _messages(body.get("contents"), b), "tools": _tool_names(body.get("tools")),
               "params": _params(cfg, ("temperature", "topP", "maxOutputTokens"))}
    elif kind == "embedding":
        req = {"model": m, "input": _embedding_inputs(body, b), "params": _params(body, ("dimensions", "encoding_format"))}
    elif kind == "image":
        req = {"model": m, "prompt": b.text(body.get("prompt") or ""), "params": _params(body, ("n", "size", "quality"))}
    elif kind == "speech":
        req = {"model": m, "input": b.text(body.get("input") or ""), "params": _params(body, ("voice", "response_format", "speed"))}
    else:  # transcription: the router passes {"model","language","prompt","file":{"name","bytes"}} — never the audio
        f = body.get("file") if isinstance(body.get("file"), dict) else {}
        req = {"model": m, "prompt": b.text(body.get("prompt") or ""), "params": _params(body, ("language",)),
               "file": {"name": b.text(f.get("name") or ""), "bytes": int(f.get("bytes") or 0)}}
    return req, b.truncated, b.used


# --------------------------------------------------------------------------------- response extraction


def _chat_text(resp: dict) -> str:
    out = []
    for ch in resp.get("choices") or []:
        msg = ch.get("message") if isinstance(ch, dict) else None
        if isinstance(msg, dict):
            out.append("\n".join(x for x in (_parts_text(msg.get("content")), _tool_calls_text(msg)) if x))
    return "\n\n".join(x for x in out if x)


def _responses_text(resp: dict) -> str:
    if isinstance(resp.get("output_text"), str) and resp["output_text"]:
        return resp["output_text"]
    out = []
    for item in resp.get("output") or []:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "message":
            out.append(_parts_text(item.get("content")))
        elif item.get("type") == "function_call":
            out.append(f"[function_call {item.get('name')}({str(item.get('arguments'))[:500]})]")
    return "\n".join(x for x in out if x)


def _gemini_text(resp: dict) -> str:
    cands = resp.get("candidates") or []
    content = (cands[0].get("content") if cands and isinstance(cands[0], dict) else None) or {}
    return _parts_text(content.get("parts"))


def _embedding_summary(resp: dict) -> str:
    vecs = [d.get("embedding") for d in resp.get("data") or [] if isinstance(d, dict)]  # OpenAI
    if not vecs and isinstance(resp.get("embedding"), dict):  # Gemini embedContent
        vecs = [resp["embedding"].get("values")]
    if not vecs and isinstance(resp.get("embeddings"), list):  # Gemini batchEmbedContents
        vecs = [e.get("values") for e in resp["embeddings"] if isinstance(e, dict)]
    dim = len(vecs[0]) if vecs and isinstance(vecs[0], list) else None  # a base64 vector has no cheap dimension
    return f"{len(vecs)} embedding(s)" + (f" x {dim} dims" if dim else "")


def extract_response(kind: str, resp: dict) -> tuple[str, str]:
    """(text, summary) of a non-streaming JSON response. Vectors and image data are never returned."""
    if not isinstance(resp, dict):
        return "", ""
    if kind == "chat":
        return _chat_text(resp), ""
    if kind == "responses":
        return _responses_text(resp), ""
    if kind == "messages":
        return _parts_text(resp.get("content")), ""
    if kind == "gemini":
        return _gemini_text(resp), ""
    if kind == "embedding":
        return "", _embedding_summary(resp)
    if kind == "image":
        data = [d for d in resp.get("data") or [] if isinstance(d, dict)]
        revised = "\n".join(str(d["revised_prompt"]) for d in data if d.get("revised_prompt"))
        return revised, f"{len(data)} image(s)"
    return "", ""


def stream_delta(kind: str, line: str) -> str:
    """The text added by ONE SSE line of a native stream ('' for anything else). Never raises."""
    if not line.startswith("data:"):
        return ""
    payload = line[5:].strip()
    if not payload or payload == "[DONE]":
        return ""
    try:
        evt = json.loads(payload)
    except (json.JSONDecodeError, ValueError):
        return ""
    if not isinstance(evt, dict):
        return ""
    if kind == "chat":
        ch = (evt.get("choices") or [None])[0]
        delta = ch.get("delta") if isinstance(ch, dict) else None
        return _parts_text(delta.get("content")) if isinstance(delta, dict) else ""
    if kind == "responses":
        return evt["delta"] if evt.get("type") == "response.output_text.delta" and isinstance(evt.get("delta"), str) else ""
    if kind == "messages":
        d = evt.get("delta")
        return d["text"] if evt.get("type") == "content_block_delta" and isinstance(d, dict) and isinstance(d.get("text"), str) else ""
    if kind == "gemini":
        return _gemini_text(evt)
    return ""


class _StreamBuffer:
    """Collects streamed text up to a cap so memory stays bounded however long the stream is."""

    def __init__(self) -> None:
        self.parts: list[str] = []
        self.size = 0
        self.limit = settings.CONTENT_MAX_BYTES * 2  # head-room: redaction/field caps shrink it later
        self.truncated = False

    def add(self, s: str) -> None:
        if self.truncated or not s:
            return
        n = len(s.encode("utf-8"))
        if self.size + n > self.limit:
            s = s.encode("utf-8")[: max(self.limit - self.size, 0)].decode("utf-8", "ignore")
            self.truncated = True
            n = len(s.encode("utf-8"))
        self.parts.append(s)
        self.size += n


@dataclass
class ContentCapture:
    """One request's content, built in the router (request side) and completed in the gateway (response
    side). Created only for a workspace that opted in. Every method swallows its own errors."""

    workspace_id: int
    kind: str
    request: dict
    request_truncated: bool = False
    request_bytes: int = 0
    response_text: str = ""
    response_summary: str = ""
    response_truncated: bool = False
    response_bytes: int = 0
    _stream: _StreamBuffer | None = field(default=None, repr=False)
    # Image logging is a separate opt-in; these stay empty (and nothing is scanned) unless the workspace has it on.
    want_images: bool = False
    images: list = field(default_factory=list, repr=False)  # content_images.Candidate, bytes NOT decoded yet

    def _set_response(self, text: str, summary: str, truncated_before: bool = False) -> None:
        b = _Budget()
        self.response_text = b.text(text) if text else ""
        self.response_summary = b.text(summary) if summary else ""
        self.response_truncated = b.truncated or truncated_before
        self.response_bytes = b.used

    def set_response_json(self, resp: dict) -> None:
        try:
            text, summary = extract_response(self.kind, resp)
            self._set_response(text, summary)
            if self.want_images:
                self.images.extend(content_images.response_candidates(self.kind, resp))
        except Exception as exc:  # noqa: BLE001 — capture must never break a request
            logger.warning("content capture: response extraction failed (%s)", type(exc).__name__)

    def set_response_text(self, text: str) -> None:
        """For the paths that only hold the final text (the legacy chat route and the Playground)."""
        try:
            self._set_response(text or "", "")
        except Exception as exc:  # noqa: BLE001
            logger.warning("content capture: response text failed (%s)", type(exc).__name__)

    def set_response_bytes(self, content: bytes, content_type: str) -> None:
        """Audio endpoints: a transcript is text; synthesized speech is summarised, never stored."""
        try:
            if self.kind == "speech":
                self._set_response("", f"{len(content)} bytes audio ({content_type or 'unknown type'})")
            else:
                text = content.decode("utf-8", "replace")
                if "json" in (content_type or "").lower():
                    try:
                        parsed = json.loads(text)
                        text = parsed.get("text", text) if isinstance(parsed, dict) else text
                    except (json.JSONDecodeError, ValueError):
                        pass
                self._set_response(text, "")
        except Exception as exc:  # noqa: BLE001
            logger.warning("content capture: audio response failed (%s)", type(exc).__name__)

    def feed_stream_line(self, line: str) -> None:
        try:
            if self._stream is None:
                self._stream = _StreamBuffer()
            self._stream.add(stream_delta(self.kind, line))
        except Exception as exc:  # noqa: BLE001
            logger.warning("content capture: stream line failed (%s)", type(exc).__name__)

    def feed_text(self, text: str) -> None:
        """For a path that already holds the streamed text pieces (the legacy chat stream)."""
        try:
            if self._stream is None:
                self._stream = _StreamBuffer()
            self._stream.add(text)
        except Exception as exc:  # noqa: BLE001
            logger.warning("content capture: stream text failed (%s)", type(exc).__name__)

    def finish_stream(self) -> None:
        try:
            if self._stream is not None:
                self._set_response("".join(self._stream.parts), "", self._stream.truncated)
        except Exception as exc:  # noqa: BLE001
            logger.warning("content capture: stream finish failed (%s)", type(exc).__name__)


def begin(db: Session, vk: VirtualKey, kind: str, body: dict, *, model: str | None = None) -> ContentCapture | None:
    """None unless BOTH this key and its workspace opted in. A key with logging off (the default) returns at once
    without touching the database; otherwise one primary-key lookup reads the workspace master switches.
    Images need the key's image switch AND the workspace's. Never raises."""
    try:
        if not vk.content_logging_enabled:
            return None  # per-key switch off (default): not captured, whatever the workspace says
        flags = db.execute(
            select(Workspace.content_logging_enabled, Workspace.image_logging_enabled).where(
                Workspace.id == vk.workspace_id
            )
        ).first()
        if not flags or not flags[0]:
            return None  # text logging off: nothing is captured, images included
        request, truncated, size = build_request(kind, body, model)
        capture = ContentCapture(vk.workspace_id, kind, request, truncated, size)
        if flags[1] and vk.image_logging_enabled:  # the separate image opt-in, at workspace AND key level
            capture.want_images = True
            try:
                capture.images = content_images.request_candidates(kind, body)
            except Exception as exc:  # noqa: BLE001 — images are optional; text capture carries on
                logger.warning("content capture: image scan failed (%s)", type(exc).__name__)
        return capture
    except Exception as exc:  # noqa: BLE001
        logger.warning("content capture: could not start (%s)", type(exc).__name__)
        return None


# ------------------------------------------------------------------------------------------- storage


def store(usage_log_id: int, capture: ContentCapture) -> bool:
    """Persist `capture` for an already-committed usage row, in its own session. True if a row was written.
    Skips (never deletes live content) once the workspace holds CONTENT_MAX_ROWS_PER_WORKSPACE live rows.
    Images (only when the workspace opted in separately) are stored after the text record, in their own commit:
    an image problem keeps the text."""
    try:
        with SessionLocal() as db:
            live = db.scalar(
                select(func.count())
                .select_from(UsageContent)
                .where(UsageContent.workspace_id == capture.workspace_id, UsageContent.expires_at > func.now())
            )
            if (live or 0) >= settings.CONTENT_MAX_ROWS_PER_WORKSPACE:
                logger.info("content capture: skipped, workspace %s is at its row cap", capture.workspace_id)
                return False
            staged: list = []
            skipped: list = []
            if capture.want_images and capture.images:
                try:
                    staged, skipped = content_images.stage(capture.images)  # no DB, no lock
                except Exception as exc:  # noqa: BLE001
                    staged, skipped = [], []
                    logger.warning("content capture: image staging failed (%s)", type(exc).__name__)
            accepted: list = []
            if staged:
                # Free expired images first, so the caps below count (almost) only live bytes. This commits, so
                # it must happen BEFORE the lock, which is held until the commit that stores the new rows.
                cleanup_expired(db, _PRESTORE_CLEANUP_LIMIT)
                # One transaction from here to the commit: the lock makes the storage caps exact under
                # concurrency (it is released by the commit/rollback, and only image-bearing stores take it).
                try:
                    db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": content_images.LOCK_KEY})
                    accepted, over = content_images.apply_caps(db, capture.workspace_id, staged)
                    skipped = skipped + over
                except Exception as exc:  # noqa: BLE001
                    db.rollback()  # also releases the lock
                    accepted = []
                    logger.warning("content capture: image cap check failed (%s)", type(exc).__name__)
            body = {
                "v": 1,
                "kind": capture.kind,
                "request": capture.request,
                "response": {"text": capture.response_text, "summary": capture.response_summary},
            }
            if skipped:
                body["images_skipped"] = skipped  # [{role, reason}] - never the image or its URL
            encrypted = crypto.encrypt(json.dumps(body, ensure_ascii=False))
            row = db.execute(
                pg_insert(UsageContent)
                .values(
                    usage_log_id=usage_log_id,
                    workspace_id=capture.workspace_id,
                    kind=capture.kind,
                    content_encrypted=encrypted,
                    request_truncated=capture.request_truncated,
                    response_truncated=capture.response_truncated,
                    request_bytes=capture.request_bytes,
                    response_bytes=capture.response_bytes,
                    expires_at=func.now() + timedelta(days=settings.CONTENT_RETENTION_DAYS),
                )
                .on_conflict_do_nothing(index_elements=[UsageContent.usage_log_id])
                .returning(UsageContent.id, UsageContent.expires_at)
            ).first()
            if row is not None and accepted:
                try:
                    with db.begin_nested():  # a failed image insert rolls back to here and keeps the text
                        for img in accepted:
                            db.add(
                                UsageContentImage(
                                    content_id=row[0],
                                    workspace_id=capture.workspace_id,
                                    role=img.role,
                                    position=img.position,
                                    mime=img.mime,
                                    byte_size=len(img.data),
                                    stored_bytes=len(img.token),
                                    sha256=img.sha256,
                                    data_encrypted=img.token,
                                    expires_at=row[1],
                                )
                            )
                except Exception as exc:  # noqa: BLE001
                    logger.warning("content capture: image store failed (%s)", type(exc).__name__)
            db.commit()
            if random.random() < _SWEEP_PROBABILITY:
                cleanup_expired(db)
            return row is not None
    except Exception as exc:  # noqa: BLE001 — never let capture affect the request
        logger.warning("content capture: store failed for usage %s (%s)", usage_log_id, type(exc).__name__)
        return False


def load(row: UsageContent) -> dict | None:
    """The decrypted payload, or None if it cannot be read (e.g. ENCRYPTION_KEY changed)."""
    plain = crypto.decrypt(row.content_encrypted)
    if plain is None:
        return None
    try:
        return json.loads(plain)
    except (json.JSONDecodeError, ValueError):
        return None


# ------------------------------------------------------------------------------------------ retention


def _cleanup_batch(db: Session, limit: int) -> int | None:
    """Delete up to `limit` expired records (their images go with them: ON DELETE CASCADE). Returns how many
    were deleted, or None if it FAILED (rolled back, and logged as the exception CLASS and the number of
    records it was about to delete - never row content, image bytes, keys or the exception message).

    The records are picked in id order and row-locked with FOR UPDATE SKIP LOCKED, in the same transaction as
    the delete: two sweepers running at once take different records instead of blocking on, or deadlocking
    over, the same ones, and the returned count is exact. Records another transaction holds locked are simply
    left for a later sweep. (A new capture never touches these rows - they are expired - so storing images is
    unaffected.)"""
    selected = 0
    try:
        ids = db.scalars(
            select(UsageContent.id)
            .where(UsageContent.expires_at <= func.now())
            .order_by(UsageContent.id)
            .limit(limit)
            .with_for_update(skip_locked=True)
        ).all()
        selected = len(ids)
        if not ids:
            # Nothing selected means nothing locked (FOR UPDATE only locks the rows it returns) and nothing
            # changed, so there is nothing to release. Do NOT roll back: that would expire every ORM object the
            # caller has already loaded on this session (e.g. the Requests page rows) and make each one re-query.
            return 0
        db.execute(delete(UsageContent).where(UsageContent.id.in_(ids)))
        db.commit()
        return len(ids)
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.warning("content capture: expiry cleanup failed (%s) for %d record(s)", type(exc).__name__, selected)
        return None


def cleanup_expired(db: Session, limit: int = 500) -> int:
    """Best-effort `_cleanup_batch` for callers that only want a count: returns 0 on any failure (already
    logged) and never raises. Safe to retry: the next sweep selects whatever is still expired."""
    return _cleanup_batch(db, limit) or 0


def _schedule_retry() -> None:
    """After a failed or unstartable sweep, allow the next attempt in ~_SWEEP_RETRY_SECONDS instead of a full
    interval. Fixed spacing (not "on every request"), so a persistent fault costs at most ~12 attempts an
    hour, and never later than the normal interval."""
    global _last_sweep
    interval = settings.CONTENT_SWEEP_INTERVAL_SECONDS
    with _sweep_lock:
        _last_sweep = time.monotonic() + min(_SWEEP_RETRY_SECONDS, interval) - interval


def _run_sweep() -> None:
    """One bounded scheduled sweep, in its own session. Never raises; a failure schedules an early retry."""
    failed = False
    try:
        with SessionLocal() as db:
            removed = 0
            for _ in range(_SWEEP_MAX_BATCHES):
                n = _cleanup_batch(db, _SWEEP_BATCH)
                if n is None:
                    failed = True
                    break
                removed += n
                if n < _SWEEP_BATCH:
                    break
            if removed:
                logger.info("content capture: scheduled sweep removed %d expired record(s)", removed)
    except Exception as exc:  # noqa: BLE001
        failed = True
        logger.warning("content capture: scheduled sweep failed (%s)", type(exc).__name__)
    if failed:
        _schedule_retry()


def maybe_sweep() -> bool:
    """Throttled physical cleanup, triggered from existing authenticated request paths (a signed-in API
    request, or a gateway request with a valid virtual key) - so expired content is reclaimed even when
    logging is off or the app sees little traffic, with no scheduler, no new service, and nothing on
    /healthz. At most one run per CONTENT_SWEEP_INTERVAL_SECONDS; the work itself runs on a short-lived
    background thread so the request is not delayed. Returns True if a sweep was started. Never raises."""
    global _last_sweep
    try:
        with _sweep_lock:
            now = time.monotonic()
            if _last_sweep is not None and now - _last_sweep < settings.CONTENT_SWEEP_INTERVAL_SECONDS:
                return False
            _last_sweep = now  # claim the slot first, so concurrent requests start at most one sweep
        try:
            if _SWEEP_INLINE:
                _run_sweep()
            else:
                threading.Thread(target=_run_sweep, name="content-sweep", daemon=True).start()
        except Exception as exc:  # noqa: BLE001 - e.g. the thread could not start
            logger.warning("content capture: could not start sweep (%s)", type(exc).__name__)
            _schedule_retry()
            return False
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("content capture: could not schedule sweep (%s)", type(exc).__name__)
        return False


def cleanup_expired_startup() -> None:
    """Sweep expired content once at boot. Best-effort; never blocks or fails startup."""
    global _last_sweep
    _last_sweep = time.monotonic()  # the boot sweep counts as this interval's run
    failed = False
    try:
        with SessionLocal() as db:
            removed = 0
            while True:
                n = _cleanup_batch(db, 1000)
                if n is None:
                    failed = True
                    break
                removed += n
                if n < 1000:
                    break
            if removed:
                logger.info("content capture: removed %d expired record(s) at startup", removed)
    except Exception as exc:  # noqa: BLE001
        failed = True
        logger.warning("content capture: startup cleanup failed (%s)", type(exc).__name__)
    if failed:
        _schedule_retry()  # same early retry as a failed scheduled sweep


def purge_workspace(db: Session, workspace_id: int) -> int:
    """Delete ALL stored content of one workspace (the admin's 'delete stored content' action)."""
    result = db.execute(delete(UsageContent).where(UsageContent.workspace_id == workspace_id))
    db.commit()
    return result.rowcount or 0
