"""Guardrails: content rules on virtual keys (see docs/guardrails.md).

An admin attaches rule sets (words, patterns, built-in detectors) to a key. For every gateway request on such a key,
`enforce_guardrails` reads the request's text and applies the rules: a matching BLOCK rule stops the request with a 403
before any provider call; a matching FLAG rule lets it through and marks it. Evidence (who, which rule, a short redacted
snippet) is recorded for the admin.

The shape of this module is the contract, so read it in this order:

1.  `evaluate` decides, using only the request text and the rules. No database, no ceiling, no logging of content.
2.  `enforce_guardrails` applies the decision. A block is ALWAYS raised, whatever happens while recording evidence.
3.  `write_*_evidence` records evidence, guarded by an hourly ceiling and by its own failure handling.

This is a policy aid, not a security boundary: word and pattern matching can be bypassed (misspelling, other
languages, encodings). Nothing here ever logs or stores the matched text.
"""

from __future__ import annotations

import bisect
import logging
import threading
import time
import unicodedata
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import regex as rx
from fastapi import HTTPException
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.config import settings
from app.content_capture import redact
from app.crypto import encrypt
from app.db import SessionLocal
from app.models import (
    AuditEvent,
    GuardrailHit,
    GuardrailRule,
    GuardrailRuleSet,
    KeyGuardrailSet,
    UsageLog,
    VirtualKey,
    Workspace,
)
from app.usage_status import BLOCKED, GUARDRAIL_BLOCKED, GUARDRAIL_FLAGGED, GUARDRAIL_UNCHECKED

logger = logging.getLogger("app.guardrails")

BLOCK_MESSAGE = "This request was blocked by your workspace's content rules."
_MARK = "[matched]"
_MAX_OCCURRENCES = 99

# ----------------------------------------------------------------------------------------------- results


@dataclass(frozen=True)
class Rule:
    id: int
    name: str
    set_name: str
    kind: str  # phrase | regex | preset
    action: str  # flag | block
    whole_word: bool
    needle: str | None = None  # phrase: the folded text to find
    regex: object | None = None  # regex rule: compiled, runs on the ORIGINAL text
    preset: str | None = None  # preset id
    secret: bool = False  # a secret/PII detector: never stores a snippet

    @property
    def sort_key(self) -> tuple[int, int, int]:
        return (0 if self.action == "block" else 1, {"phrase": 0, "preset": 1, "regex": 2}[self.kind], self.id)


@dataclass
class Hit:
    rule: Rule
    role: str
    occurrences: int
    snippet: str | None  # redacted context with the match replaced by [matched]; None when none is safe
    ordinal: int = 0


@dataclass
class Decision:
    blocked: bool = False
    hits: list[Hit] = field(default_factory=list)
    unchecked: bool = False
    reasons: list[str] = field(default_factory=list)
    elapsed_ms: int = 0


@dataclass
class GuardResult:
    """What a route carries from the guard to the place the usage row is written."""

    hits: list[Hit] = field(default_factory=list)  # flag hits of a request that went through
    unchecked: bool = False

    @property
    def marker(self) -> str | None:
        if self.hits:
            return GUARDRAIL_FLAGGED
        return GUARDRAIL_UNCHECKED if self.unchecked else None


NO_GUARD = GuardResult()

# ------------------------------------------------------------------------------------- text extraction

_ROLE_BY_KEY = {"system": "system", "systemInstruction": "system", "system_instruction": "system", "instructions": "system"}
_TEXT_KEYS = frozenset(
    {"text", "content", "prompt", "system", "instructions", "instruction", "query", "message", "input"}
)
# subtrees where EVERY string is request text (tool inputs and results, embedding input lists, ...)
_TAKE_ALL = frozenset(
    {"input", "arguments", "args", "functionCall", "functionResponse", "tool_use", "tool_result", "tool_calls",
     "function_call", "output", "response", "parts", "contents", "messages", "requests"}
)
# never request text: identifiers, types, and binary payloads
_SKIP_KEYS = frozenset(
    {"model", "type", "role", "id", "name", "object", "status", "mime_type", "mimeType", "format", "image_url",
     "inlineData", "inline_data", "fileData", "file_data", "data", "b64_json", "audio", "file", "image", "source",
     "tool_call_id", "tool_use_id", "call_id", "created", "index", "temperature", "max_tokens", "stream"}
)


@dataclass
class Segment:
    role: str
    text: str
    _norm: str | None = None
    deadline: float | None = None  # set by evaluate(): normalising a huge non-ASCII text must respect the time budget

    @property
    def norm(self) -> str:
        if self._norm is None:
            self._norm = self.text.lower() if self.text.isascii() else _fold_within(self.text, self.deadline)
        return self._norm


def _looks_binary(s: str) -> bool:
    if s.startswith("data:") and ";base64," in s[:80]:
        return True
    return len(s) > 2000 and " " not in s[:300] and all(c.isalnum() or c in "+/=_-" for c in s[:300])


def _walk(node, role: str, out: list[tuple[str, str]], take_all: bool, depth: int, budget: list[int]) -> None:
    if depth > 40:
        return
    if budget[0] <= 0:
        if isinstance(node, (str, list, dict)) and node:
            budget[1] = 1
        return
    if isinstance(node, str):
        if node and not _looks_binary(node):
            if len(node) > budget[0]:
                budget[1] = 1  # cut: the remainder is not scanned
            out.append((role, node[: budget[0]]))
            budget[0] -= len(node)
        return
    if isinstance(node, list):
        for item in node:
            _walk(item, role, out, take_all, depth + 1, budget)
        return
    if isinstance(node, dict):
        r = node.get("role")
        role = r if isinstance(r, str) and r else role
        for key, value in node.items():
            if key in _SKIP_KEYS:
                continue
            child_role = _ROLE_BY_KEY.get(key, role)
            if isinstance(value, str):
                if take_all or key in _TEXT_KEYS:
                    _walk(value, child_role, out, take_all, depth + 1, budget)
            elif isinstance(value, (dict, list)):
                _walk(value, child_role, out, take_all or key in _TAKE_ALL, depth + 1, budget)


def extract_segments(body) -> tuple[list[Segment], bool]:
    """The request's text, in order, one segment per string, with the role it came from. Returns (segments, oversize):
    oversize means the scan cap cut some text off. Binary payloads (base64 images/audio) are not text and are skipped."""
    cap = settings.GUARDRAIL_SCAN_CAP_CHARS
    out: list[tuple[str, str]] = []
    budget = [cap, 0]  # [characters left, 1 once anything was cut off]
    _walk(body, "user", out, False, 0, budget)
    return [Segment(role=r, text=t) for r, t in out], bool(budget[1])


# --------------------------------------------------------------------- normalization and verified offsets

_ZERO_WIDTH = dict.fromkeys(map(ord, "​‌‍⁠﻿­᠎"), None)
_BIDI = dict.fromkeys([*range(0x202A, 0x202F), *range(0x2066, 0x206A), 0x200E, 0x200F], None)


def _fold(s: str) -> str:
    """The form phrases and presets are matched in: compatibility-normalized, case-folded, zero-width characters gone."""
    return unicodedata.normalize("NFKC", unicodedata.normalize("NFKC", s).casefold()).translate(_ZERO_WIDTH)


_FOLD_CHUNK = 8_192


def _fold_within(s: str, deadline: float | None) -> str:
    """`_fold` in chunks (cut at whitespace, which never combines with its neighbours) with a deadline check between
    them: folding is the one linear-time step that is not a regex and so cannot time out by itself."""
    if deadline is None or len(s) <= _FOLD_CHUNK:
        return _fold(s)
    out, i, n = [], 0, len(s)
    while i < n:
        if time.perf_counter() > deadline:
            raise _OutOfBudget
        j = min(n, i + _FOLD_CHUNK)
        if j < n:
            k = j
            while k < min(n, j + 2048) and not s[k].isspace():
                k += 1
            j = k if k < n and s[k].isspace() else j
        out.append(_fold(s[i:j]))
        i = j
    return "".join(out)


def _is_extender(c: str) -> bool:
    o = ord(c)
    return bool(unicodedata.combining(c)) or 0xFE00 <= o <= 0xFE0F or 0xE0100 <= o <= 0xE01EF or 0x1F3FB <= o <= 0x1F3FF or o == 0x200D


def _clusters(s: str) -> list[tuple[int, int]]:
    """Split into clusters (a starter plus combining marks, variation selectors, skin tones, and ZWJ joins) so a match
    can only ever start and end on a cluster boundary."""
    out, i, n = [], 0, len(s)
    while i < n:
        j = i + 1
        while j < n:
            c = s[j]
            if c == "‍" and j + 1 < n:
                j += 2
            elif _is_extender(c):
                j += 1
            else:
                break
        out.append((i, j))
        i = j
    return out


def map_span(text: str, norm: str, ns: int, ne: int) -> tuple[int, int] | None:
    """Map a span of the FOLDED text back to the ORIGINAL text, or None if that cannot be done reliably.

    Reliable means both: (1) folding cluster by cluster gives exactly the whole-text fold (otherwise normalization
    crossed cluster boundaries, e.g. Hangul jamo, and offsets cannot be trusted), and (2) re-folding the mapped
    original span gives exactly the matched folded text. Anything else returns None and the caller omits the snippet."""
    if text.isascii():
        return (ns, ne) if text[ns:ne].lower() == norm[ns:ne] else None
    spans, starts, ends, parts = [], [], [], []
    pos = 0
    for o0, o1 in _clusters(text):
        f = _fold(text[o0:o1])
        parts.append(f)
        if f:
            spans.append((o0, o1))
            starts.append(pos)
            pos += len(f)
            ends.append(pos)
    if "".join(parts) != norm:
        return None
    if not (0 <= ns < ne <= len(norm)):
        return None
    a = bisect.bisect_right(starts, ns) - 1
    b = bisect.bisect_left(ends, ne)
    if a < 0 or b >= len(spans):
        return None
    os_, oe = spans[a][0], spans[b][1]
    return (os_, oe) if _fold(text[os_:oe]) == norm[ns:ne] else None


def _clean(s: str) -> str:
    s = s.translate(_BIDI)
    s = "".join(" " if (c.isspace() or unicodedata.category(c).startswith("C")) else c for c in s)
    s = redact(s)
    s = rx.sub(r"\d{8,}", "[digits]", s)
    s = rx.sub(r"[A-Za-z0-9_\-]{20,}", "[token]", s)
    return " ".join(s.split())


def build_snippet(text: str, os_: int, oe: int, matched_norm: str) -> str | None:
    """A few characters either side of the match with the match itself replaced by [matched]. Returns None rather than
    risk showing the match: the context is cleaned and redacted, and if the matched text still appears in it (a
    repeated word next to the match) there is no snippet."""
    n = len(text)
    left = max(0, os_ - 20)
    while 0 < left < n and _is_extender(text[left]):
        left -= 1
    right = min(n, oe + 20)
    while 0 < right < n and _is_extender(text[right]):
        right += 1
    before, after = _clean(text[left:os_])[-50:], _clean(text[oe:right])[:50]
    if matched_norm and matched_norm in _fold(before + " | " + after):
        return None
    out = f"{before}{_MARK}{after}"[:120]
    return out if _MARK in out else None


# --------------------------------------------------------------------------------------------- matching

_PRESET_SECRET = {"card": True, "api_key": True, "private_key": True, "email": True}
_PRESETS: dict[str, list] = {
    "card": [rx.compile(r"(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)")],
    "api_key": [
        rx.compile(p)
        for p in (
            r"\bsk-ant-[a-z0-9_-]{8,}", r"\bsk-[a-z0-9_-]{16,}", r"\bvk_[a-z0-9_-]{8,}", r"\baiza[0-9a-z_-]{20,}",
            r"\bgh[pousr]_[a-z0-9]{20,}", r"\bxox[abprs]-[a-z0-9-]{10,}", r"\bakia[0-9a-z]{16}\b",
            r"\beyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}",
        )
    ],
    "private_key": [rx.compile(r"-----begin [a-z ]*private key-----")],
    "email": [rx.compile(r"[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,255}\.[a-z]{2,24}")],
}


def _luhn(digits: str) -> bool:
    if not 13 <= len(digits) <= 19:
        return False
    total, alt = 0, False
    for ch in reversed(digits):
        d = ord(ch) - 48
        if alt:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        alt = not alt
    return total % 10 == 0


def _is_word(c: str) -> bool:
    return c.isalnum() or c == "_"


class _OutOfBudget(Exception):
    """Raised inside matching when the total evaluation time is used up."""


def _find_phrase(norm: str, needle: str, whole_word: bool) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    i, n, m = 0, len(norm), len(needle)
    while len(out) < _MAX_OCCURRENCES:
        j = norm.find(needle, i)
        if j < 0:
            break
        e = j + m
        if whole_word and ((j > 0 and _is_word(norm[j - 1])) or (e < n and _is_word(norm[e]))):
            i = j + 1
            continue
        out.append((j, e))
        i = e
    return out


def _find_regex(compiled, text: str, timeout: float, post=None) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for m in compiled.finditer(text, timeout=timeout):
        if m.end() == m.start():
            continue
        if post is not None and not post(m.group()):
            continue
        out.append((m.start(), m.end()))
        if len(out) >= _MAX_OCCURRENCES:
            break
    return out


def _scan(rule: Rule, seg: Segment, timeout: float) -> list[tuple[int, int]]:
    """Spans in `seg`: in the FOLDED text for phrases and presets, in the ORIGINAL text for regex rules."""
    if rule.kind == "phrase":
        return _find_phrase(seg.norm, rule.needle or "", rule.whole_word)
    if rule.kind == "regex":
        return _find_regex(rule.regex, seg.text, timeout)
    spans: list[tuple[int, int]] = []
    for compiled in _PRESETS.get(rule.preset or "", []):
        post = (lambda g: _luhn("".join(ch for ch in g if ch.isdigit()))) if rule.preset == "card" else None
        spans.extend(_find_regex(compiled, seg.norm, timeout, post))
    return sorted(set(spans))[:_MAX_OCCURRENCES]


def evaluate(segments: list[Segment], rules: list[Rule], *, oversize: bool = False) -> Decision:
    """Apply every rule to the text. Pure: no database, no ceiling, nothing logged. All rules run (within the limits);
    block rules first. ANY block hit blocks, and a flag hit can never undo that. If the time budget runs out or a
    rule times out, hits found so far still count and the result is marked unchecked."""
    t0 = time.perf_counter()
    deadline = t0 + settings.GUARDRAIL_EVAL_BUDGET_MS / 1000.0
    timeout = settings.GUARDRAIL_REGEX_TIMEOUT_MS / 1000.0
    d = Decision()
    if oversize:
        d.unchecked = True
        d.reasons.append("oversize")
    try:
        for rule in sorted(rules, key=lambda r: r.sort_key):
            if len(d.hits) >= settings.GUARDRAIL_MAX_HITS_PER_REQUEST:
                break
            occurrences, first = 0, None
            for seg in segments:
                if time.perf_counter() > deadline:
                    raise _OutOfBudget
                seg.deadline = deadline
                try:
                    spans = _scan(rule, seg, timeout)
                except TimeoutError:
                    d.unchecked = True
                    if "rule_timeout" not in d.reasons:
                        d.reasons.append("rule_timeout")
                    break
                if spans:
                    occurrences += len(spans)
                    if first is None:
                        first = (seg, spans[0])
            if first is not None:
                seg, (a, b) = first
                d.hits.append(
                    Hit(rule=rule, role=seg.role, occurrences=min(occurrences, _MAX_OCCURRENCES),
                        snippet=_snippet_for(rule, seg, a, b))
                )
    except _OutOfBudget:
        d.unchecked = True
        d.reasons.append("time_budget")
    for i, h in enumerate(d.hits):
        h.ordinal = i
    d.blocked = any(h.rule.action == "block" for h in d.hits)
    d.elapsed_ms = int((time.perf_counter() - t0) * 1000)
    return d


def _snippet_for(rule: Rule, seg: Segment, a: int, b: int) -> str | None:
    """Evidence for one hit, or None. Secret/PII detectors never keep a snippet. Phrase/preset spans are in the
    folded text and are mapped back through `map_span` (verified, else no snippet); regex spans are already exact."""
    if rule.secret:
        return None
    try:
        if rule.kind == "regex":
            return build_snippet(seg.text, a, b, _fold(seg.text[a:b]))
        mapped = map_span(seg.text, seg.norm, a, b)
        return None if mapped is None else build_snippet(seg.text, mapped[0], mapped[1], seg.norm[a:b])
    except Exception:  # noqa: BLE001 - evidence is optional; never let it fail the request
        return None


# ------------------------------------------------------------------------------- rule loading and cache

_CACHE: OrderedDict[int, tuple[int, list[Rule]]] = OrderedDict()
_CACHE_LOCK = threading.Lock()
_CACHE_MAX = 256


def compile_rule(row: GuardrailRule, set_name: str) -> Rule | None:
    """A stored rule as an executable one, or None if it cannot be (an invalid pattern: skipped, never raised)."""
    base = dict(id=row.id, name=row.name, set_name=set_name, kind=row.kind, action=row.action, whole_word=row.whole_word)
    try:
        if row.kind == "phrase":
            needle = _fold((row.pattern or "").strip())
            return Rule(**base, needle=needle) if needle else None
        if row.kind == "regex":
            if not row.pattern or len(row.pattern) > settings.GUARDRAIL_MAX_PATTERN_CHARS:
                return None
            return Rule(**base, regex=rx.compile(row.pattern))
        if row.kind == "preset" and row.preset_id in _PRESETS:
            return Rule(**base, preset=row.preset_id, secret=_PRESET_SECRET.get(row.preset_id, True))
    except Exception:  # noqa: BLE001
        return None
    return None


def load_rules(db: Session, vk: VirtualKey) -> tuple[list[Rule], int]:
    """The key's compiled rules and how many stored rules could not be compiled. The in-process cache is validated
    against workspaces.guardrail_version on EVERY use (one primary-key read), so a rule or attachment change is seen
    by the very next request in any worker: there is no staleness window to reason about."""
    version = db.scalar(select(Workspace.guardrail_version).where(Workspace.id == vk.workspace_id)) or 0
    with _CACHE_LOCK:
        hit = _CACHE.get(vk.id)
        if hit is not None and hit[0] == version:
            _CACHE.move_to_end(vk.id)
            return hit[1], 0
    rows = db.execute(
        select(GuardrailRule, GuardrailRuleSet.name, GuardrailRuleSet.id)
        .join(GuardrailRuleSet, GuardrailRuleSet.id == GuardrailRule.rule_set_id)
        .join(KeyGuardrailSet, KeyGuardrailSet.rule_set_id == GuardrailRuleSet.id)
        .where(
            KeyGuardrailSet.key_id == vk.id,
            GuardrailRuleSet.workspace_id == vk.workspace_id,
            GuardrailRuleSet.enabled.is_(True),
            GuardrailRule.enabled.is_(True),
        )
        .order_by(GuardrailRuleSet.id, GuardrailRule.position, GuardrailRule.id)
    ).all()
    rules: list[Rule] = []
    broken, sets_seen = 0, []
    for rule_row, set_name, set_id in rows:
        if set_id not in sets_seen:
            if len(sets_seen) >= settings.GUARDRAIL_MAX_SETS_PER_KEY:
                continue
            sets_seen.append(set_id)
        if len(rules) >= settings.GUARDRAIL_MAX_RULES_PER_KEY:
            break
        compiled = compile_rule(rule_row, set_name)
        if compiled is None:
            broken += 1
        else:
            rules.append(compiled)
    with _CACHE_LOCK:
        _CACHE[vk.id] = (version, rules)
        _CACHE.move_to_end(vk.id)
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
    return rules, broken


def bump_version(db: Session, workspace_id: int) -> None:
    """Call in the SAME transaction as any change to rules, rule sets or attachments (the caller commits)."""
    db.execute(update(Workspace).where(Workspace.id == workspace_id).values(guardrail_version=Workspace.guardrail_version + 1))


def attach_rule_sets(db: Session, vk: VirtualKey, set_ids: list[int]) -> None:
    """Replace which rule sets apply to a key, keep `has_guardrails` in step, and bump the version (caller commits)."""
    ids = list(dict.fromkeys(set_ids))
    if len(ids) > settings.GUARDRAIL_MAX_SETS_PER_KEY:
        raise ValueError(f"a key can have at most {settings.GUARDRAIL_MAX_SETS_PER_KEY} rule sets")
    if ids:
        owned = set(db.scalars(select(GuardrailRuleSet.id).where(GuardrailRuleSet.workspace_id == vk.workspace_id, GuardrailRuleSet.id.in_(ids))))
        if owned != set(ids):
            raise ValueError("unknown rule set")
    db.execute(delete(KeyGuardrailSet).where(KeyGuardrailSet.key_id == vk.id))
    db.execute(pg_insert(KeyGuardrailSet).values([{"key_id": vk.id, "rule_set_id": i} for i in ids])) if ids else None
    vk.has_guardrails = bool(ids)
    bump_version(db, vk.workspace_id)


# ------------------------------------------------------------------------------ observability (no content)


class _Stats:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.counters: dict[str, int] = {}
        self.last_failure_at: float | None = None
        self.log_state: dict[str, tuple[float, int]] = {}  # reason -> (last logged at, suppressed since)
        self.gaps: dict[int, dict] = {}  # workspace -> evidence that could not be recorded

    def inc(self, name: str, n: int = 1) -> None:
        with self.lock:
            self.counters[name] = self.counters.get(name, 0) + n

    def snapshot(self) -> dict:
        with self.lock:
            return {"counters": dict(self.counters), "last_failure_at": self.last_failure_at}


_STATS = _Stats()
_LOG_EVERY_S = 30.0


def _log(event: str, reason: str, ws: int, key: int, kind: str, exc: BaseException | None) -> None:
    """One throttled line per (event, reason): ids, an enum reason and the exception CLASS name only. Never the prompt,
    the matched text, a pattern, or str(exc): a database error's text can contain the very parameters it failed on."""
    name = f"{event}:{reason}"
    with _STATS.lock:
        last, suppressed = _STATS.log_state.get(name, (0.0, 0))
        now = time.monotonic()
        if now - last < _LOG_EVERY_S:
            _STATS.log_state[name] = (last, suppressed + 1)
            return
        _STATS.log_state[name] = (now, 0)
    logger.warning(
        "%s reason=%s workspace=%s key=%s kind=%s exc=%s suppressed=%d",
        event, reason, ws, key, kind, type(exc).__name__ if exc else "-", suppressed,
    )


def _reason(exc: BaseException) -> str:
    n = type(exc).__name__
    orig = type(getattr(exc, "orig", None)).__name__
    if "Timeout" in n or "Timeout" in orig or "QueryCanceled" in orig or "LockNotAvailable" in orig:
        return "timeout"
    if "Integrity" in n or "Unique" in orig:
        return "integrity"
    if "Operational" in n or "DBAPI" in n or "Database" in n or "Interface" in n:
        return "db_error"
    return "unknown"


def _note_gap(ws: int, reason: str) -> None:
    now = time.time()
    with _STATS.lock:
        g = _STATS.gaps.setdefault(ws, {"count": 0, "first": now, "reasons": set()})
        g["count"] += 1
        g["last"] = now
        g["reasons"].add(reason)
        _STATS.last_failure_at = now


def _flush_gap(db: Session, ws: int) -> None:
    """After a successful write: turn this workspace's in-memory evidence gap into one persistent audit event."""
    with _STATS.lock:
        g = _STATS.gaps.pop(ws, None)
    if g:
        db.add(AuditEvent(
            workspace_id=ws, action="guardrail.evidence_gap", target_type="guardrail",
            detail={
                "count": g["count"], "reasons": sorted(g["reasons"]),
                "from": datetime.fromtimestamp(g["first"], UTC).isoformat(), "to": datetime.fromtimestamp(g["last"], UTC).isoformat(),
            },
        ))


def reset_for_tests() -> None:
    with _CACHE_LOCK:
        _CACHE.clear()
    with _THROTTLE_LOCK:
        _THROTTLED.clear()
    with _STATS.lock:
        _STATS.counters.clear()
        _STATS.log_state.clear()
        _STATS.gaps.clear()
        _STATS.last_failure_at = None
    global _last_sweep
    _last_sweep = time.monotonic()  # no background sweep thread in tests; they call sweep() directly


def status() -> dict:
    """Counters for the admin status endpoint (in-process; the durable record is the audit events and the logs)."""
    return _STATS.snapshot()


# ------------------------------------------------------------------- evidence: ceiling, writing, failures

_THROTTLED: OrderedDict[int, float] = OrderedDict()  # workspace -> epoch seconds when its current hour ends
_THROTTLE_LOCK = threading.Lock()


def _throttled(ws: int) -> bool:
    with _THROTTLE_LOCK:
        until = _THROTTLED.get(ws)
        if until is None:
            return False
        if time.time() >= until:
            del _THROTTLED[ws]
            return False
        return True


def _remember_throttle(ws: int) -> None:
    until = (int(time.time() // 3600) + 1) * 3600
    with _THROTTLE_LOCK:
        _THROTTLED[ws] = float(until)
        _THROTTLED.move_to_end(ws)
        while len(_THROTTLED) > 1024:
            _THROTTLED.popitem(last=False)


_ADMIT = text(
    "INSERT INTO guardrail_recording_counters (workspace_id, bucket, recorded) "
    "VALUES (:ws, date_trunc('hour', now()), 1) "
    "ON CONFLICT (workspace_id, bucket) DO UPDATE SET recorded = guardrail_recording_counters.recorded + 1 "
    "WHERE guardrail_recording_counters.recorded < :ceiling RETURNING recorded"
)
_MARK_THROTTLED = text(
    "UPDATE guardrail_recording_counters SET throttled_at = now() "
    "WHERE workspace_id = :ws AND bucket = date_trunc('hour', now()) AND throttled_at IS NULL"
)


def admit(db: Session, ws: int) -> bool:
    """Take one unit of this workspace's hourly evidence budget. One atomic statement: Postgres serialises the
    competing updates of the single counter row, so exactly `ceiling` callers are admitted however many run at once,
    in any number of workers. Runs inside the caller's transaction, so a failed evidence write also rolls this back."""
    ceiling = settings.GUARDRAIL_RECORDING_CEILING_PER_HOUR
    if ceiling <= 0:
        return False
    if db.execute(_ADMIT, {"ws": ws, "ceiling": ceiling}).first() is not None:
        return True
    db.execute(_MARK_THROTTLED, {"ws": ws})
    _remember_throttle(ws)
    return False


def _hit_rows(vk: VirtualKey, usage_id: int, hits: list[Hit]) -> list[dict]:
    expires = datetime.now(UTC) + timedelta(days=settings.GUARDRAIL_RETENTION_DAYS)
    rows = []
    for h in hits:
        snippet = None
        if h.snippet:
            try:
                snippet = encrypt(h.snippet)
            except Exception:  # noqa: BLE001 - no snippet rather than a failed record
                snippet = None
        rows.append(dict(
            workspace_id=vk.workspace_id, key_id=vk.id, usage_log_id=usage_id, rule_id=h.rule.id, rule_name=h.rule.name,
            rule_set_name=h.rule.set_name, rule_kind=h.rule.kind, action=h.rule.action, ordinal=h.ordinal,
            source_role=h.role[:20], occurrences=h.occurrences, snippet_enc=snippet, expires_at=expires,
        ))
    return rows


def _bounded(db: Session) -> None:
    db.execute(text("SET LOCAL statement_timeout = '2s'"))
    db.execute(text("SET LOCAL lock_timeout = '1s'"))


def write_blocked_evidence(db: Session, vk: VirtualKey, d: Decision, provider: str, model: str, kind: str) -> None:
    """Record a blocked request: one usage row (status 'blocked') plus its hits, in ONE transaction with the ceiling
    counter. Never raises and never changes the outcome: the caller raises the 403 regardless. A single attempt, no
    retry, short statement timeouts; on failure the transaction is rolled back, a content-free line is logged, and the
    gap is remembered so it becomes a persistent audit event once a write succeeds again."""
    ws, key = vk.workspace_id, vk.id
    _STATS.inc("blocked")
    if settings.GUARDRAIL_RECORDING_CEILING_PER_HOUR <= 0 or _throttled(ws):
        _STATS.inc("throttled_blocked")
        return
    try:
        _bounded(db)
        if not admit(db, ws):
            db.commit()  # keeps throttled_at
            _STATS.inc("throttled_blocked")
            return
        row = UsageLog(
            key_id=key, request_id=str(uuid.uuid4()), provider=provider, model=model, prompt_tokens=0,
            completion_tokens=0, total_tokens=0, cost=0.0, cost_source="configured", simulated=False, mode="live",
            latency_ms=d.elapsed_ms, status=BLOCKED, guardrail=GUARDRAIL_BLOCKED,
        )
        db.add(row)
        db.flush()
        db.execute(pg_insert(GuardrailHit).values(_hit_rows(vk, row.id, d.hits)).on_conflict_do_nothing(constraint="uq_guardrail_hit_request_rule"))
        _flush_gap(db, ws)
        db.commit()
        _STATS.inc("blocked_recorded")
    except Exception as exc:  # noqa: BLE001 - the block is still enforced by the caller
        _fail_evidence(db, exc, ws, key, kind)


def write_flag_evidence(db: Session, vk: VirtualKey, usage_row: UsageLog, guard: GuardResult) -> None:
    """Record the hits of a flagged request, inside the usage row's own transaction (called from record_usage before
    its commit) and inside a savepoint: if this fails the usage row still commits, only the hit records are lost."""
    ws, key = vk.workspace_id, vk.id
    if not guard.hits:
        return
    _STATS.inc("flagged")
    if settings.GUARDRAIL_RECORDING_CEILING_PER_HOUR <= 0 or _throttled(ws):
        _STATS.inc("throttled_flagged")
        return
    try:
        with db.begin_nested():
            _bounded(db)
            if not admit(db, ws):
                _STATS.inc("throttled_flagged")
                return
            db.execute(pg_insert(GuardrailHit).values(_hit_rows(vk, usage_row.id, guard.hits)).on_conflict_do_nothing(constraint="uq_guardrail_hit_request_rule"))
            _flush_gap(db, ws)
    except Exception as exc:  # noqa: BLE001 - the usage row must still be written
        _fail_evidence(None, exc, ws, key, "flag")


def _fail_evidence(db: Session | None, exc: Exception, ws: int, key: int, kind: str) -> None:
    if db is not None:
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
    reason = _reason(exc)
    _STATS.inc(f"evidence_failed_{reason}")
    _note_gap(ws, reason)
    _log("guardrail_evidence_failed", reason, ws, key, kind, exc)


# ------------------------------------------------------------------------------------------- the gateway hook


def enforce_guardrails(db: Session, vk: VirtualKey, kind: str, body, provider: str, model: str) -> GuardResult:
    """Called by every gateway route after governance (budget, caps, live key) and before anything is claimed,
    captured or sent: see the order in docs/guardrails.md. Raises 403 `guardrail_blocked` for a block (after recording
    evidence, which can never change that outcome); otherwise returns what the usage row should carry."""
    if not settings.GUARDRAILS_ENABLED or not vk.has_guardrails:
        return NO_GUARD
    maybe_sweep()
    ws, key = vk.workspace_id, vk.id
    try:
        rules, broken = load_rules(db, vk)
        if not rules and not broken:
            return NO_GUARD
        segments, oversize = extract_segments(body)
        decision = evaluate(segments, rules, oversize=oversize)
        if broken:
            decision.unchecked = True
            decision.reasons.append("rule_invalid")
    except Exception as exc:  # noqa: BLE001 - fail open: an engine fault must never take the gateway down
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        _STATS.inc("skipped_engine_error")
        _log("guardrail_skipped", "engine_error", ws, key, kind, exc)
        return GuardResult(unchecked=True)

    _STATS.inc("evaluated")
    for reason in decision.reasons:
        _STATS.inc(f"skipped_{reason}")
        _log("guardrail_skipped", reason, ws, key, kind, None)
    if decision.blocked:
        write_blocked_evidence(db, vk, decision, provider, model, kind)
        raise HTTPException(status_code=403, detail={"message": BLOCK_MESSAGE, "type": "guardrail_blocked", "code": "403"})
    return GuardResult(hits=decision.hits, unchecked=decision.unchecked)


# ------------------------------------------------------------------------------------------- retention

_last_sweep: float | None = None
_sweep_lock = threading.Lock()
_SWEEP_INTERVAL_S = 3600.0
_SWEEP_BATCH = 500
_SWEEP_INLINE = False  # tests only


def _delete_batch(db: Session, model, where, limit: int) -> int | None:
    """Delete up to `limit` rows, locked with FOR UPDATE SKIP LOCKED in the same transaction (two sweepers take different
    rows). Returns the count, or None on failure (rolled back, logged by class only)."""
    try:
        ids = db.scalars(select(model.id).where(where).order_by(model.id).limit(limit).with_for_update(skip_locked=True)).all()
        if not ids:
            return 0
        db.execute(delete(model).where(model.id.in_(ids)))
        db.commit()
        return len(ids)
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.warning("guardrail sweep failed (%s)", type(exc).__name__)
        return None


def sweep(db: Session, limit: int = _SWEEP_BATCH) -> dict:
    """Retention: after GUARDRAIL_RETENTION_DAYS (30) the WHOLE hit record is deleted (snippet included), blocked usage
    rows are deleted, and old recording counters are dropped. A flagged request's ordinary usage row stays. Independent
    of content logging's retention setting."""
    cutoff = datetime.now(UTC) - timedelta(days=settings.GUARDRAIL_RETENTION_DAYS)
    out = {"hits": 0, "blocked_rows": 0, "counters": 0}
    for name, model, where in (
        ("hits", GuardrailHit, GuardrailHit.expires_at <= func.now()),
        ("blocked_rows", UsageLog, (UsageLog.status == BLOCKED) & (UsageLog.ts < cutoff)),
    ):
        while True:
            n = _delete_batch(db, model, where, limit)
            if not n:
                break
            out[name] += n
            if n < limit:
                break
    try:
        res = db.execute(text("DELETE FROM guardrail_recording_counters WHERE bucket < now() - interval '48 hours'"))
        db.commit()
        out["counters"] = res.rowcount or 0
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.warning("guardrail sweep failed (%s)", type(exc).__name__)
    return out


def _run_sweep() -> None:
    try:
        with SessionLocal() as db:
            sweep(db)
    except Exception as exc:  # noqa: BLE001
        logger.warning("guardrail sweep failed (%s)", type(exc).__name__)


def maybe_sweep() -> bool:
    """At most one background sweep per hour, started from the guard itself (so only an app that uses guardrails pays)."""
    global _last_sweep
    with _sweep_lock:
        now = time.monotonic()
        if _last_sweep is not None and now - _last_sweep < _SWEEP_INTERVAL_S:
            return False
        _last_sweep = now
    try:
        if _SWEEP_INLINE:
            _run_sweep()
        else:
            threading.Thread(target=_run_sweep, name="guardrail-sweep", daemon=True).start()
    except Exception as exc:  # noqa: BLE001
        logger.warning("guardrail sweep could not start (%s)", type(exc).__name__)
        return False
    return True


def cleanup_expired_startup() -> None:
    """Sweep once at boot, whether or not guardrails are enabled (data written earlier must still expire)."""
    global _last_sweep
    _last_sweep = time.monotonic()
    _run_sweep()


# --------------------------------------------------------------------- admin-side helpers (used by the API)

PRESETS = {
    "card": ("Payment card numbers", "13-19 digit card numbers that pass the Luhn check. No snippet is stored."),
    "api_key": ("API keys and tokens", "Common provider key shapes (sk-, vk_, ghp_, AKIA, JWT...). No snippet is stored."),
    "private_key": ("Private keys", "PEM private key headers. No snippet is stored."),
    "email": ("Email addresses", "Anything shaped like name@domain.tld. No snippet is stored."),
}
_PROBES = ["a" * 64 + "!", "a " * 40 + "!", "x" * 300, "ab" * 120 + "c", "(" * 40, "a" * 60 + "b", "0" * 200 + "x", " " * 200 + "z"]


def validate_rule_input(kind: str, pattern: str | None, preset_id: str | None) -> tuple[str | None, str | None]:
    """Check a rule an admin is saving. Returns the cleaned (pattern, preset_id) or raises ValueError with a message
    that is safe to show. A regex is compiled and run against adversarial probes under the per-match timeout, so a
    pattern that could stall the gateway is refused at save time, not discovered at request time."""
    limit = settings.GUARDRAIL_MAX_PATTERN_CHARS
    if kind == "preset":
        if preset_id not in PRESETS:
            raise ValueError("unknown built-in detector")
        return None, preset_id
    p = (pattern or "").strip() if kind == "phrase" else (pattern or "")
    if not p:
        raise ValueError("pattern is required")
    if len(p) > limit:
        raise ValueError(f"pattern is too long (max {limit} characters)")
    if kind == "phrase":
        if not _fold(p):
            raise ValueError("pattern has no visible characters")
        return p, None
    try:
        compiled = rx.compile(p)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"invalid regular expression ({type(exc).__name__})") from None
    try:
        if compiled.fullmatch("") is not None or compiled.search("") is not None:
            raise ValueError("pattern matches empty text")
        timeout = settings.GUARDRAIL_REGEX_TIMEOUT_MS / 1000.0
        for probe in _PROBES:
            list(compiled.finditer(probe, timeout=timeout))
    except TimeoutError:
        raise ValueError("pattern is too slow (it could stall requests); simplify it") from None
    return p, None


def audit(db: Session, workspace_id: int, actor_user_id: int | None, action: str, target_type: str,
          target_id: int | str | None, detail: dict | None = None) -> None:
    """Record an administrative change (caller commits). Detail holds ids, names and counts: never prompt text."""
    db.add(AuditEvent(workspace_id=workspace_id, actor_user_id=actor_user_id, action=action, target_type=target_type,
                      target_id=None if target_id is None else str(target_id), detail=detail or {}))


def enabled_rule_counts(db: Session, key_ids: list[int]) -> dict[int, int]:
    """Enabled rules in enabled sets that apply to each key (what the per-key limit is about)."""
    if not key_ids:
        return {}
    rows = db.execute(
        select(KeyGuardrailSet.key_id, func.count(GuardrailRule.id))
        .join(GuardrailRuleSet, GuardrailRuleSet.id == KeyGuardrailSet.rule_set_id)
        .join(GuardrailRule, GuardrailRule.rule_set_id == GuardrailRuleSet.id)
        .where(KeyGuardrailSet.key_id.in_(key_ids), GuardrailRuleSet.enabled.is_(True), GuardrailRule.enabled.is_(True))
        .group_by(KeyGuardrailSet.key_id)
    ).all()
    return {k: n for k, n in rows}


def check_key_rule_limit(db: Session, key_ids: list[int]) -> None:
    for n in enabled_rule_counts(db, key_ids).values():
        if n > settings.GUARDRAIL_MAX_RULES_PER_KEY:
            raise ValueError(f"a key can have at most {settings.GUARDRAIL_MAX_RULES_PER_KEY} active rules (this would make {n})")


def keys_of_set(db: Session, rule_set_id: int) -> list[int]:
    return list(db.scalars(select(KeyGuardrailSet.key_id).where(KeyGuardrailSet.rule_set_id == rule_set_id)))


def resync_key_flags(db: Session, key_ids: list[int]) -> None:
    """Recompute `has_guardrails` for keys whose attachments may have changed (e.g. a rule set was deleted)."""
    for kid in key_ids:
        vk = db.get(VirtualKey, kid)
        if vk is not None:
            vk.has_guardrails = bool(db.scalar(select(func.count()).select_from(KeyGuardrailSet).where(KeyGuardrailSet.key_id == kid)))


def set_key_rule_sets(db: Session, vk: VirtualKey, set_ids: list[int], actor_user_id: int | None) -> bool:
    """Attach exactly these rule sets to a key (validated, audited, version bumped; caller commits). Returns whether
    anything changed. Raises ValueError with a message safe to show."""
    new = sorted(set(set_ids))
    old = sorted(db.scalars(select(KeyGuardrailSet.rule_set_id).where(KeyGuardrailSet.key_id == vk.id)))
    if new == old:
        return False
    attach_rule_sets(db, vk, new)
    db.flush()
    check_key_rule_limit(db, [vk.id])
    added, removed = sorted(set(new) - set(old)), sorted(set(old) - set(new))
    audit(db, vk.workspace_id, actor_user_id, "key.guardrails.attach" if new else "key.guardrails.detach", "key", vk.id,
          {"key": vk.label, "added_set_ids": added, "removed_set_ids": removed})
    return True
