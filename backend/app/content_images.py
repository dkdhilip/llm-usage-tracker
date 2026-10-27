"""Opt-in storage of the actual images in logged requests/responses (workspace admins only).

A SECOND opt-in on top of text logging (`workspaces.image_logging_enabled`, default off; turning text logging on
never turns this on). Rules:

* **Only bytes already embedded in the JSON body/response** — `data:` URLs and base64 fields. A URL is NEVER
  fetched (no SSRF, no server-side download) and never persisted: a signed or expiring URL would pose as a
  permanent copy. Such images are recorded only as a skipped reason ("url_not_stored").
* **Verified by magic number**: PNG, JPEG, GIF, WebP. The declared MIME type is ignored; the sniffed type is
  what gets stored and served. SVG/PDF/audio/anything else is skipped.
* **Bounded**: base64 length is checked BEFORE decoding; per-image, per-request, per-workspace and global caps
  (config `CONTENT_IMAGE_*`, counted on the encrypted size as stored). A cap skips the image, never fails
  anything, and never deletes live content.
* Encrypted with the same Fernet key as everything else (`crypto.encrypt_bytes`); a rotated key makes stored
  images unreadable. No transcoding or resizing (CPU, decompression-bomb risk).

Nothing here may raise into the gateway: `prepare` is only called from `content_capture.store`, which already
swallows every error."""

import base64
import binascii
import hashlib
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import crypto
from app.config import settings
from app.models import UsageContentImage

_MAX_SCAN = 32  # candidates examined per request/response: bounds the work a hostile body can cause

# reasons shown to admins for an image that was not stored
SKIP_REASONS = ("url_not_stored", "not_fetchable", "too_large", "unsupported_type", "request_limit", "cap_reached", "not_in_stream")


@dataclass
class Candidate:
    role: str  # input | output
    position: int
    b64: str | None = None  # embedded base64 payload (not yet decoded)
    skip: str | None = None  # reason it can never be stored


@dataclass
class Prepared:
    role: str
    position: int
    mime: str
    data: bytes
    sha256: str
    token: bytes


# ------------------------------------------------------------------------------------------------ sniffing


def sniff(data: bytes) -> str | None:
    """The image type from the leading bytes, or None. Only these four are ever stored."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _decode(b64: str) -> bytes | None:
    s = "".join(b64.split())  # tolerate wrapped lines
    s += "=" * (-len(s) % 4)
    # Pick the alphabet from the data. Never "try standard first": b64decode silently DROPS '-' and '_' instead of
    # failing, so URL-safe input (what the Google Gemini Python SDK sends) decoded to a corrupted image.
    decoder = base64.urlsafe_b64decode if ("-" in s or "_" in s) else base64.b64decode
    try:
        return decoder(s)
    except (binascii.Error, ValueError):
        return None


# ---------------------------------------------------------------------------------------------- extraction


class _Collector:
    def __init__(self, role: str) -> None:
        self.role = role
        self.items: list[Candidate] = []
        self.scanned = 0
        self.overflow = False

    def _add(self, b64: str | None, skip: str | None) -> None:
        self.scanned += 1
        if self.scanned > _MAX_SCAN:
            if not self.overflow:
                self.overflow = True
                self.items.append(Candidate(self.role, len(self.items), skip="request_limit"))
            return
        self.items.append(Candidate(self.role, len(self.items), b64=b64, skip=skip))

    def data_url(self, url) -> None:
        """An image reference given as a URL string: only an embedded base64 `data:` URL is capturable."""
        if isinstance(url, dict):
            url = url.get("url")
        if not isinstance(url, str) or not url:
            return
        if url[:5].lower() == "data:":
            head, _, payload = url.partition(",")
            if "base64" in head.lower() and payload:
                self._add(payload, None)
            else:
                self._add(None, "unsupported_type")
        elif url[:8].lower() == "https://" or url[:7].lower() == "http://":
            self._add(None, "url_not_stored")  # never fetched, never persisted
        else:
            self._add(None, "unsupported_type")

    def base64(self, data) -> None:
        if isinstance(data, str) and data:
            self._add(data, None)

    def skip(self, reason: str) -> None:
        self._add(None, reason)


def _parts(content):
    if isinstance(content, dict):
        content = [content]
    return [p for p in content if isinstance(p, dict)] if isinstance(content, list) else []


def _is_image_mime(blob: dict) -> bool:
    return str(blob.get("mimeType") or blob.get("mime_type") or "").lower().startswith("image/")


def request_candidates(kind: str, body: dict) -> list[Candidate]:
    """Embedded images in the JSON request body of `kind` (only the fields that can carry a prompt image)."""
    c = _Collector("input")
    if not isinstance(body, dict):
        return []
    if kind == "chat":
        for msg in (body.get("messages") or [])[:100] if isinstance(body.get("messages"), list) else []:
            for part in _parts(msg.get("content")) if isinstance(msg, dict) else []:
                if part.get("type") == "image_url":
                    c.data_url(part.get("image_url"))
    elif kind == "responses":
        items = body.get("input")
        for item in (items[:100] if isinstance(items, list) else []):
            if not isinstance(item, dict):
                continue
            for part in [item] + _parts(item.get("content")):
                if part.get("type") == "input_image":
                    if part.get("image_url"):
                        c.data_url(part["image_url"])
                    elif part.get("file_id"):
                        c.skip("not_fetchable")
    elif kind == "messages":
        for msg in (body.get("messages") or [])[:100] if isinstance(body.get("messages"), list) else []:
            for part in _parts(msg.get("content")) if isinstance(msg, dict) else []:
                if part.get("type") != "image" or not isinstance(part.get("source"), dict):
                    continue
                src = part["source"]
                if src.get("type") == "base64":
                    c.base64(src.get("data"))
                elif src.get("type") == "url":
                    c.skip("url_not_stored")
                else:
                    c.skip("not_fetchable")
    elif kind == "gemini":
        for content in (body.get("contents") or [])[:100] if isinstance(body.get("contents"), list) else []:
            for part in _parts(content.get("parts")) if isinstance(content, dict) else []:
                blob = part.get("inlineData") or part.get("inline_data")
                if isinstance(blob, dict) and _is_image_mime(blob):
                    c.base64(blob.get("data"))
                fdata = part.get("fileData") or part.get("file_data")
                if isinstance(fdata, dict) and _is_image_mime(fdata):
                    c.skip("not_fetchable")  # a Google Files / remote URI: never fetched
    return c.items


def response_candidates(kind: str, resp: dict) -> list[Candidate]:
    """Embedded generated images in a non-streaming JSON response of `kind`."""
    c = _Collector("output")
    if not isinstance(resp, dict):
        return []
    if kind == "image":
        for d in (resp.get("data") or [])[:_MAX_SCAN] if isinstance(resp.get("data"), list) else []:
            if not isinstance(d, dict):
                continue
            if isinstance(d.get("b64_json"), str) and d["b64_json"]:
                c.base64(d["b64_json"])
            elif d.get("url"):
                c.skip("url_not_stored")  # provider URLs expire; never fetched
    elif kind == "gemini":
        cands = resp.get("candidates") or []
        content = (cands[0].get("content") if cands and isinstance(cands[0], dict) else None) or {}
        for part in _parts(content.get("parts")) if isinstance(content, dict) else []:
            blob = part.get("inlineData") or part.get("inline_data")
            if isinstance(blob, dict) and _is_image_mime(blob):
                c.base64(blob.get("data"))
    elif kind == "responses":
        for item in (resp.get("output") or [])[:_MAX_SCAN] if isinstance(resp.get("output"), list) else []:
            if isinstance(item, dict) and item.get("type") == "image_generation_call":
                c.base64(item.get("result"))
    elif kind == "chat":  # OpenRouter image models: message.images[].image_url.url (a data URL)
        for ch in (resp.get("choices") or [])[:4] if isinstance(resp.get("choices"), list) else []:
            msg = ch.get("message") if isinstance(ch, dict) else None
            imgs = msg.get("images") if isinstance(msg, dict) else None
            for img in (imgs[:_MAX_SCAN] if isinstance(imgs, list) else []):
                if isinstance(img, dict):
                    c.data_url(img.get("image_url"))
    return c.items


# ---------------------------------------------------------------------------------------------- storage


def usage_bytes(db: Session, workspace_id: int | None = None, *, include_expired: bool = False) -> int:
    """Stored image bytes: one workspace's, or (workspace_id=None) everyone's.

    By default only LIVE (unexpired) bytes - what the user-facing meter shows. The storage CAPS pass
    include_expired=True: an expired image that the sweep has not physically deleted yet still occupies the
    database, so it must count toward the cap or a lagging sweep would let physical usage run past it."""
    q = select(func.coalesce(func.sum(UsageContentImage.stored_bytes), 0))
    if not include_expired:
        q = q.where(UsageContentImage.expires_at > func.now())
    if workspace_id is not None:
        q = q.where(UsageContentImage.workspace_id == workspace_id)
    return int(db.scalar(q) or 0)


# Arbitrary constant: the Postgres advisory-lock key that serialises the cap check + insert of IMAGES (only
# requests that actually carry an image ever take it). Without it, concurrent requests all read the same
# "bytes used" before any of them inserts, and a burst sails past every cap.
LOCK_KEY = 7_315_904_221


def stage(candidates: list[Candidate]) -> tuple[list[Prepared], list[dict]]:
    """The part that needs no database: decode, verify and size-check `candidates`, and encrypt the keepers.
    Returns (candidates that passed, [{role, reason}] for the rest). Storage caps are applied later by
    `apply_caps`, under the lock."""
    accepted: list[Prepared] = []
    skipped: list[dict] = []
    request_bytes = 0
    max_image = settings.CONTENT_IMAGE_MAX_BYTES
    for cand in candidates:
        reason = cand.skip
        item: Prepared | None = None
        if reason is None and len(accepted) >= settings.CONTENT_IMAGE_MAX_PER_REQUEST:
            reason = "request_limit"
        if reason is None and cand.b64 is not None and len(cand.b64) * 3 // 4 > max_image + 8:
            reason = "too_large"  # judged from the base64 length, before any decoding
        if reason is None:
            data = _decode(cand.b64 or "")
            mime = sniff(data) if data else None
            if data is None or mime is None:
                reason = "unsupported_type"
            elif len(data) > max_image:
                reason = "too_large"
            else:
                token = crypto.encrypt_bytes(data)
                if request_bytes + len(token) > settings.CONTENT_IMAGE_MAX_REQUEST_BYTES:
                    reason = "request_limit"
                else:
                    request_bytes += len(token)
                    item = Prepared(cand.role, cand.position, mime, data, hashlib.sha256(data).hexdigest(), token)
        if item is not None:
            accepted.append(item)
        else:
            skipped.append({"role": cand.role, "reason": reason})
    return accepted, skipped


def apply_caps(db: Session, workspace_id: int, staged: list[Prepared]) -> tuple[list[Prepared], list[dict]]:
    """Workspace and global storage caps. The caller MUST hold the advisory lock (`LOCK_KEY`) in the same
    transaction as the inserts that follow, which makes the caps exact: every concurrent image store sees
    the bytes committed by the one before it."""
    ws_used = usage_bytes(db, workspace_id, include_expired=True)  # physical, not just live: see usage_bytes
    total_used = usage_bytes(db, include_expired=True)
    accepted: list[Prepared] = []
    skipped: list[dict] = []
    for img in staged:
        stored = len(img.token)
        if (
            ws_used + stored > settings.CONTENT_IMAGE_MAX_BYTES_PER_WORKSPACE
            or total_used + stored > settings.CONTENT_IMAGE_MAX_BYTES_TOTAL
        ):
            skipped.append({"role": img.role, "reason": "cap_reached"})
        else:
            ws_used += stored
            total_used += stored
            accepted.append(img)
    return accepted, skipped


def load_bytes(row: UsageContentImage) -> bytes | None:
    """The decrypted image, or None if unreadable (e.g. ENCRYPTION_KEY changed)."""
    return crypto.decrypt_bytes(row.data_encrypted)
