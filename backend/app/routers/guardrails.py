"""Guardrails admin API (Workspace Admin only; a Team Member gets 403 on everything here).

Rule sets and rules (CRUD, validated on save), attaching sets to keys, the hits list that doubles as the notification
feed (grouped, with a workspace-wide read state), a dry-run, a status summary and the activity (audit) list.

Every write bumps `workspaces.guardrail_version` in the SAME transaction (so the gateway sees it on the very next
request) and records an `audit_events` row with ids/names/counts only. Nothing here is enforced unless
GUARDRAILS_ENABLED is on; the API works regardless so rules can be prepared first. See docs/guardrails.md."""

import logging
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import and_, case, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import crypto
from app import guardrails as g
from app.config import settings
from app.db import get_db
from app.models import (
    AuditEvent,
    GuardrailHit,
    GuardrailRecordingCounter,
    GuardrailRule,
    GuardrailRuleSet,
    KeyGuardrailSet,
    UsageLog,
    VirtualKey,
)
from app.scoping import scope_usage
from app.usage_status import BLOCKED, GUARDRAIL_UNCHECKED
from app.workspace import Membership, require_workspace_admin

router = APIRouter(prefix="/api/guardrails", tags=["guardrails"])
logger = logging.getLogger("app.guardrails")

Kind = Literal["phrase", "regex", "preset"]
Action = Literal["flag", "block"]


class SetIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=300)
    enabled: bool = True


class SetPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=300)
    enabled: bool | None = None


class RuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    kind: Kind
    pattern: str | None = None
    preset_id: str | None = None
    action: Action = "flag"
    whole_word: bool = False
    enabled: bool = True


class RulePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    pattern: str | None = None
    preset_id: str | None = None
    action: Action | None = None
    whole_word: bool | None = None
    enabled: bool | None = None


class KeySetsIn(BaseModel):
    rule_set_ids: list[int] = Field(default_factory=list)


class TestIn(BaseModel):
    kind: Kind
    pattern: str | None = None
    preset_id: str | None = None
    whole_word: bool = False
    text: str = Field(max_length=20000)


class ReviewIn(BaseModel):
    up_to_id: int = Field(ge=0)  # the highest hit id the client was showing: later hits stay unread
    key_id: int | None = None
    rule_id: int | None = None
    action: Action | None = None


# ----------------------------------------------------------------------------------------------- helpers


def _set_of(db: Session, set_id: int, m: Membership) -> GuardrailRuleSet:
    rs = db.scalar(select(GuardrailRuleSet).where(GuardrailRuleSet.id == set_id, GuardrailRuleSet.workspace_id == m.workspace_id))
    if rs is None:
        raise HTTPException(404, "rule set not found")
    return rs


def _rule_of(db: Session, rule_id: int, m: Membership) -> tuple[GuardrailRule, GuardrailRuleSet]:
    row = db.execute(
        select(GuardrailRule, GuardrailRuleSet)
        .join(GuardrailRuleSet, GuardrailRuleSet.id == GuardrailRule.rule_set_id)
        .where(GuardrailRule.id == rule_id, GuardrailRuleSet.workspace_id == m.workspace_id)
    ).first()
    if row is None:
        raise HTTPException(404, "rule not found")
    return row[0], row[1]


def _rule_out(r: GuardrailRule) -> dict:
    return {
        "id": r.id, "name": r.name, "kind": r.kind, "pattern": r.pattern, "preset_id": r.preset_id,
        "action": r.action, "whole_word": r.whole_word, "enabled": r.enabled, "position": r.position,
    }


def _set_out(rs: GuardrailRuleSet, rules: list[GuardrailRule], key_ids: list[int]) -> dict:
    return {
        "id": rs.id, "name": rs.name, "description": rs.description, "enabled": rs.enabled,
        "created_at": rs.created_at.isoformat() if rs.created_at else None,
        "updated_at": rs.updated_at.isoformat() if rs.updated_at else None,
        "rules": [_rule_out(r) for r in sorted(rules, key=lambda r: (r.position, r.id))],
        "key_ids": sorted(key_ids),
    }


def _clean_name(name: str) -> str:
    n = " ".join(name.split())
    if not n:
        raise HTTPException(422, "name is required")
    return n


def _valid(kind: str, pattern: str | None, preset_id: str | None) -> tuple[str | None, str | None]:
    try:
        return g.validate_rule_input(kind, pattern, preset_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


def _commit(db: Session, conflict: str) -> None:
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, conflict) from None


# ------------------------------------------------------------------------------------------- rule sets


@router.get("/presets")
def presets(_m: Membership = Depends(require_workspace_admin)) -> list[dict]:
    return [{"id": k, "label": v[0], "description": v[1]} for k, v in g.PRESETS.items()]


@router.get("/rule-sets")
def list_rule_sets(db: Session = Depends(get_db), m: Membership = Depends(require_workspace_admin)) -> dict:
    sets = db.scalars(select(GuardrailRuleSet).where(GuardrailRuleSet.workspace_id == m.workspace_id).order_by(GuardrailRuleSet.id)).all()
    ids = [s.id for s in sets]
    rules: dict[int, list[GuardrailRule]] = {i: [] for i in ids}
    keys: dict[int, list[int]] = {i: [] for i in ids}
    if ids:
        for r in db.scalars(select(GuardrailRule).where(GuardrailRule.rule_set_id.in_(ids))):
            rules[r.rule_set_id].append(r)
        for sid, kid in db.execute(
            select(KeyGuardrailSet.rule_set_id, KeyGuardrailSet.key_id)
            .join(VirtualKey, VirtualKey.id == KeyGuardrailSet.key_id)
            .where(KeyGuardrailSet.rule_set_id.in_(ids), VirtualKey.deleted_at.is_(None))
        ):
            keys[sid].append(kid)
    return {
        "enabled": settings.GUARDRAILS_ENABLED,
        "limits": _limits(),
        "items": [_set_out(s, rules[s.id], keys[s.id]) for s in sets],
    }


def _limits() -> dict:
    return {
        "pattern_chars": settings.GUARDRAIL_MAX_PATTERN_CHARS, "rules_per_set": settings.GUARDRAIL_MAX_RULES_PER_SET,
        "sets_per_key": settings.GUARDRAIL_MAX_SETS_PER_KEY, "rules_per_key": settings.GUARDRAIL_MAX_RULES_PER_KEY,
        "sets_per_workspace": settings.GUARDRAIL_MAX_SETS_PER_WORKSPACE,
    }


@router.post("/rule-sets")
def create_rule_set(body: SetIn, db: Session = Depends(get_db), m: Membership = Depends(require_workspace_admin)) -> dict:
    count = db.scalar(select(func.count()).select_from(GuardrailRuleSet).where(GuardrailRuleSet.workspace_id == m.workspace_id)) or 0
    if count >= settings.GUARDRAIL_MAX_SETS_PER_WORKSPACE:
        raise HTTPException(409, f"rule set limit reached ({settings.GUARDRAIL_MAX_SETS_PER_WORKSPACE} per workspace)")
    rs = GuardrailRuleSet(workspace_id=m.workspace_id, name=_clean_name(body.name), description=(body.description or None),
                          enabled=body.enabled, created_by=m.user_id)
    db.add(rs)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "A rule set with that name already exists.") from None
    g.bump_version(db, m.workspace_id)
    g.audit(db, m.workspace_id, m.user_id, "ruleset.create", "rule_set", rs.id, {"name": rs.name})
    _commit(db, "A rule set with that name already exists.")
    db.refresh(rs)
    return _set_out(rs, [], [])


@router.patch("/rule-sets/{set_id}")
def update_rule_set(set_id: int, body: SetPatch, db: Session = Depends(get_db), m: Membership = Depends(require_workspace_admin)) -> dict:
    rs = _set_of(db, set_id, m)
    changes: dict = {}
    if body.name is not None and _clean_name(body.name) != rs.name:
        changes["name"] = [rs.name, _clean_name(body.name)]
        rs.name = _clean_name(body.name)
    if body.description is not None and (body.description or None) != rs.description:
        rs.description = body.description or None
        changes["description"] = True
    if body.enabled is not None and body.enabled != rs.enabled:
        rs.enabled = body.enabled
        changes["enabled"] = body.enabled
    if changes:
        if "enabled" in changes and rs.enabled:
            try:
                db.flush()
                g.check_key_rule_limit(db, g.keys_of_set(db, rs.id))
            except ValueError as exc:
                db.rollback()
                raise HTTPException(422, str(exc)) from None
        g.bump_version(db, m.workspace_id)
        action = "ruleset.update" if set(changes) - {"enabled"} else ("ruleset.enable" if rs.enabled else "ruleset.disable")
        g.audit(db, m.workspace_id, m.user_id, action, "rule_set", rs.id, {"name": rs.name, "changes": sorted(changes)})
        _commit(db, "A rule set with that name already exists.")
    return _full_set(db, rs, m)


def _full_set(db: Session, rs: GuardrailRuleSet, m: Membership) -> dict:
    db.refresh(rs)
    rules = list(db.scalars(select(GuardrailRule).where(GuardrailRule.rule_set_id == rs.id)))
    return _set_out(rs, rules, g.keys_of_set(db, rs.id))


@router.delete("/rule-sets/{set_id}")
def delete_rule_set(set_id: int, db: Session = Depends(get_db), m: Membership = Depends(require_workspace_admin)) -> dict:
    rs = _set_of(db, set_id, m)
    key_ids = g.keys_of_set(db, rs.id)
    name = rs.name
    db.delete(rs)  # rules and attachments cascade; hits keep their name snapshots (rule_id goes NULL)
    db.flush()
    g.resync_key_flags(db, key_ids)
    g.bump_version(db, m.workspace_id)
    g.audit(db, m.workspace_id, m.user_id, "ruleset.delete", "rule_set", set_id, {"name": name, "detached_keys": len(key_ids)})
    db.commit()
    return {"id": set_id, "deleted": True}


# ------------------------------------------------------------------------------------------------ rules


@router.post("/rule-sets/{set_id}/rules")
def create_rule(set_id: int, body: RuleIn, db: Session = Depends(get_db), m: Membership = Depends(require_workspace_admin)) -> dict:
    rs = _set_of(db, set_id, m)
    existing = db.scalar(select(func.count()).select_from(GuardrailRule).where(GuardrailRule.rule_set_id == rs.id)) or 0
    if existing >= settings.GUARDRAIL_MAX_RULES_PER_SET:
        raise HTTPException(409, f"rule limit reached ({settings.GUARDRAIL_MAX_RULES_PER_SET} per rule set)")
    pattern, preset = _valid(body.kind, body.pattern, body.preset_id)
    nxt = (db.scalar(select(func.max(GuardrailRule.position)).where(GuardrailRule.rule_set_id == rs.id)) or 0) + 1 if existing else 0
    rule = GuardrailRule(rule_set_id=rs.id, name=_clean_name(body.name), kind=body.kind, pattern=pattern, preset_id=preset,
                         action=body.action, whole_word=body.whole_word and body.kind == "phrase", enabled=body.enabled, position=nxt)
    db.add(rule)
    db.flush()
    try:
        g.check_key_rule_limit(db, g.keys_of_set(db, rs.id))
    except ValueError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from None
    g.bump_version(db, m.workspace_id)
    g.audit(db, m.workspace_id, m.user_id, "rule.create", "rule", rule.id,
            {"set": rs.name, "name": rule.name, "kind": rule.kind, "action": rule.action, "pattern": rule.pattern, "preset": rule.preset_id})
    db.commit()
    db.refresh(rule)
    return _rule_out(rule)


@router.patch("/rules/{rule_id}")
def update_rule(rule_id: int, body: RulePatch, db: Session = Depends(get_db), m: Membership = Depends(require_workspace_admin)) -> dict:
    rule, rs = _rule_of(db, rule_id, m)
    if body.pattern is not None or body.preset_id is not None:
        rule.pattern, rule.preset_id = _valid(rule.kind, body.pattern if body.pattern is not None else rule.pattern,
                                              body.preset_id if body.preset_id is not None else rule.preset_id)
    if body.name is not None:
        rule.name = _clean_name(body.name)
    if body.action is not None:
        rule.action = body.action
    if body.whole_word is not None:
        rule.whole_word = body.whole_word and rule.kind == "phrase"
    if body.enabled is not None:
        rule.enabled = body.enabled
    db.flush()
    try:
        g.check_key_rule_limit(db, g.keys_of_set(db, rs.id))
    except ValueError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from None
    g.bump_version(db, m.workspace_id)
    g.audit(db, m.workspace_id, m.user_id, "rule.update", "rule", rule.id,
            {"set": rs.name, "name": rule.name, "kind": rule.kind, "action": rule.action, "enabled": rule.enabled,
             "pattern": rule.pattern, "preset": rule.preset_id})
    db.commit()
    db.refresh(rule)
    return _rule_out(rule)


@router.delete("/rules/{rule_id}")
def delete_rule(rule_id: int, db: Session = Depends(get_db), m: Membership = Depends(require_workspace_admin)) -> dict:
    rule, rs = _rule_of(db, rule_id, m)
    detail = {"set": rs.name, "name": rule.name, "kind": rule.kind, "action": rule.action}
    db.delete(rule)
    g.bump_version(db, m.workspace_id)
    g.audit(db, m.workspace_id, m.user_id, "rule.delete", "rule", rule_id, detail)
    db.commit()
    return {"id": rule_id, "deleted": True}


# ------------------------------------------------------------------------- attach to keys, dry run


@router.put("/keys/{key_id}/rule-sets")
def set_key_rule_sets(key_id: int, body: KeySetsIn, db: Session = Depends(get_db), m: Membership = Depends(require_workspace_admin)) -> dict:
    vk = db.scalar(select(VirtualKey).where(VirtualKey.id == key_id, VirtualKey.workspace_id == m.workspace_id))
    if vk is None:
        raise HTTPException(404, "key not found")
    try:
        g.set_key_rule_sets(db, vk, body.rule_set_ids, m.user_id)
    except ValueError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from None
    db.commit()
    return {"key_id": vk.id, "rule_set_ids": sorted(db.scalars(select(KeyGuardrailSet.rule_set_id).where(KeyGuardrailSet.key_id == vk.id)))}


@router.post("/test")
def dry_run(body: TestIn, response: Response, m: Membership = Depends(require_workspace_admin)) -> dict:
    """Try a rule on some text the admin typed. Nothing is stored or logged. Uses the same validation and engine as
    the gateway, so what matches here matches there."""
    response.headers["Cache-Control"] = "no-store"
    pattern, preset = _valid(body.kind, body.pattern, body.preset_id)
    row = GuardrailRule(id=0, name="test", kind=body.kind, pattern=pattern, preset_id=preset, action="flag", whole_word=body.whole_word)
    rule = g.compile_rule(row, "test")
    if rule is None:
        raise HTTPException(422, "rule could not be compiled")
    segs, _ = g.extract_segments({"messages": [{"role": "user", "content": body.text}]})
    d = g.evaluate(segs, [rule])
    hit = d.hits[0] if d.hits else None
    return {
        "matched": hit is not None, "occurrences": hit.occurrences if hit else 0,
        "snippet": hit.snippet if hit else None, "unchecked": d.unchecked, "elapsed_ms": d.elapsed_ms,
    }


# ------------------------------------------------------------------------- hits (the notification feed)


def _live_hits(m: Membership):
    return and_(GuardrailHit.workspace_id == m.workspace_id, GuardrailHit.expires_at > func.now())


@router.get("/unread-count")
def unread_count(db: Session = Depends(get_db), m: Membership = Depends(require_workspace_admin)) -> dict:
    n = db.scalar(select(func.count()).select_from(GuardrailHit).where(_live_hits(m), GuardrailHit.reviewed_at.is_(None))) or 0
    top = db.scalar(select(func.max(GuardrailHit.id)).where(_live_hits(m))) or 0
    return {"count": n, "latest_hit_id": top}


@router.get("/hits")
def list_hit_groups(unread_only: bool = False, limit: int = 100, db: Session = Depends(get_db), m: Membership = Depends(require_workspace_admin)) -> dict:
    """Hits grouped by key + rule + action. The unread counts of the groups always add up to /unread-count."""
    limit = max(1, min(limit, 200))
    name_for_deleted = case((GuardrailHit.rule_id.is_(None), GuardrailHit.rule_name), else_=None)
    stmt = (
        select(
            GuardrailHit.key_id, GuardrailHit.rule_id, name_for_deleted.label("deleted_name"), GuardrailHit.action,
            func.count().label("total"),
            func.count().filter(GuardrailHit.reviewed_at.is_(None)).label("unread"),
            func.max(GuardrailHit.ts).label("last_seen"), func.max(GuardrailHit.id).label("last_id"),
            func.max(GuardrailHit.rule_name).label("rule_name"), func.max(GuardrailHit.rule_set_name).label("rule_set_name"),
            func.max(GuardrailHit.rule_kind).label("rule_kind"),
        )
        .where(_live_hits(m))
        .group_by(GuardrailHit.key_id, GuardrailHit.rule_id, name_for_deleted, GuardrailHit.action)
        .order_by(func.max(GuardrailHit.ts).desc(), GuardrailHit.rule_id.asc().nulls_last())
        .limit(limit)
    )
    if unread_only:
        stmt = stmt.having(func.count().filter(GuardrailHit.reviewed_at.is_(None)) > 0)
    rows = db.execute(stmt).all()
    labels = {k.id: (k.label, k.key_prefix) for k in db.scalars(select(VirtualKey).where(VirtualKey.id.in_({r.key_id for r in rows})))} if rows else {}
    return {
        "items": [
            {
                "key_id": r.key_id, "key_label": labels.get(r.key_id, ("(deleted key)", ""))[0],
                "key_prefix": labels.get(r.key_id, ("", ""))[1], "rule_id": r.rule_id, "rule_name": r.rule_name,
                "rule_set_name": r.rule_set_name, "rule_kind": r.rule_kind, "action": r.action, "total": r.total,
                "unread": r.unread, "last_seen": r.last_seen.isoformat(), "last_hit_id": r.last_id,
            }
            for r in rows
        ],
        "unread_total": db.scalar(select(func.count()).select_from(GuardrailHit).where(_live_hits(m), GuardrailHit.reviewed_at.is_(None))) or 0,
    }


@router.get("/hits/items")
def list_hits(
    response: Response, key_id: int | None = None, rule_id: int | None = None, action: Action | None = None,
    usage_id: int | None = None, limit: int = 50, cursor: int | None = None,
    db: Session = Depends(get_db), m: Membership = Depends(require_workspace_admin),
) -> dict:
    """The individual hits behind a group (or one request), newest first, with the decrypted snippet. The snippet is
    short, redacted request context: read access is logged (who, never what) and the response is never cached."""
    response.headers["Cache-Control"] = "no-store"
    limit = max(1, min(limit, 200))
    stmt = (
        select(GuardrailHit, UsageLog.request_id, UsageLog.provider, UsageLog.model, UsageLog.status, VirtualKey.label)
        .join(UsageLog, UsageLog.id == GuardrailHit.usage_log_id)
        .join(VirtualKey, VirtualKey.id == GuardrailHit.key_id)
        .where(_live_hits(m)).order_by(GuardrailHit.id.desc()).limit(limit + 1)
    )
    if key_id is not None:
        stmt = stmt.where(GuardrailHit.key_id == key_id)
    if rule_id is not None:
        stmt = stmt.where(GuardrailHit.rule_id == rule_id)
    if action:
        stmt = stmt.where(GuardrailHit.action == action)
    if usage_id is not None:
        stmt = stmt.where(GuardrailHit.usage_log_id == usage_id)
    if cursor is not None:
        stmt = stmt.where(GuardrailHit.id < cursor)
    rows = db.execute(stmt).all()
    more = len(rows) > limit
    rows = rows[:limit]
    items = []
    for h, rid, provider, model, status, label in rows:
        snippet = None
        if h.snippet_enc:
            try:
                snippet = crypto.decrypt(h.snippet_enc)
            except Exception:  # noqa: BLE001 - e.g. ENCRYPTION_KEY changed: show "unavailable", never fail the list
                snippet = None
        items.append({
            "id": h.id, "ts": h.ts.isoformat(), "usage_id": h.usage_log_id, "request_id": rid, "key_id": h.key_id,
            "key_label": label, "provider": provider, "model": model, "request_status": status, "rule_id": h.rule_id,
            "rule_name": h.rule_name, "rule_set_name": h.rule_set_name, "rule_kind": h.rule_kind, "action": h.action,
            "source_role": h.source_role, "occurrences": h.occurrences, "snippet": snippet,
            "snippet_available": snippet is not None, "reviewed": h.reviewed_at is not None,
        })
    if items:
        logger.info("guardrail hits read: user=%s count=%s", m.user_id, len(items))  # who looked; never the snippets
    return {"items": items, "next_cursor": items[-1]["id"] if (items and more) else None, "retention_days": settings.GUARDRAIL_RETENTION_DAYS}


@router.post("/hits/review")
def review_hits(body: ReviewIn, db: Session = Depends(get_db), m: Membership = Depends(require_workspace_admin)) -> dict:
    """Mark hits as reviewed (workspace-wide: any admin clearing them clears them for everyone). Only hits up to
    `up_to_id` are touched, so a hit that arrived after the list was loaded stays unread. Repeating it is harmless."""
    cond = [GuardrailHit.workspace_id == m.workspace_id, GuardrailHit.reviewed_at.is_(None), GuardrailHit.id <= body.up_to_id]
    if body.key_id is not None:
        cond.append(GuardrailHit.key_id == body.key_id)
    if body.rule_id is not None:
        cond.append(GuardrailHit.rule_id == body.rule_id)
    if body.action is not None:
        cond.append(GuardrailHit.action == body.action)
    res = db.execute(update(GuardrailHit).where(*cond).values(reviewed_at=func.now(), reviewed_by=m.user_id))
    n = res.rowcount or 0
    if n:
        g.audit(db, m.workspace_id, m.user_id, "hits.review", "hits", None,
                {"count": n, "key_id": body.key_id, "rule_id": body.rule_id, "action": body.action})
    db.commit()
    return {"reviewed": n}


# ------------------------------------------------------------------------------ status and activity


@router.get("/status")
def status(db: Session = Depends(get_db), m: Membership = Depends(require_workspace_admin)) -> dict:
    since = datetime.now(UTC) - timedelta(hours=24)
    base = scope_usage(select(UsageLog.guardrail, func.count()).where(UsageLog.ts >= since, UsageLog.guardrail.is_not(None)), m)
    counts = dict(db.execute(base.group_by(UsageLog.guardrail)).all())
    throttled = db.scalar(
        select(func.max(GuardrailRecordingCounter.throttled_at)).where(
            GuardrailRecordingCounter.workspace_id == m.workspace_id, GuardrailRecordingCounter.throttled_at >= since
        )
    )
    gaps = db.scalars(
        select(AuditEvent).where(AuditEvent.workspace_id == m.workspace_id, AuditEvent.action == "guardrail.evidence_gap", AuditEvent.ts >= since)
        .order_by(AuditEvent.id.desc()).limit(5)
    ).all()
    return {
        "enabled": settings.GUARDRAILS_ENABLED,
        "last_24h": {"blocked": counts.get(BLOCKED, 0), "flagged": counts.get("flagged", 0), "unchecked": counts.get(GUARDRAIL_UNCHECKED, 0)},
        "recording": {
            "ceiling_per_hour": settings.GUARDRAIL_RECORDING_CEILING_PER_HOUR,
            "throttled_at": throttled.isoformat() if throttled else None,
        },
        "evidence_gaps": [{"ts": e.ts.isoformat(), **(e.detail or {})} for e in gaps],
        "retention_days": settings.GUARDRAIL_RETENTION_DAYS,
        "limits": _limits(),
    }


@router.get("/activity")
def activity(limit: int = 50, cursor: int | None = None, db: Session = Depends(get_db), m: Membership = Depends(require_workspace_admin)) -> dict:
    limit = max(1, min(limit, 200))
    stmt = select(AuditEvent).where(AuditEvent.workspace_id == m.workspace_id).order_by(AuditEvent.id.desc()).limit(limit + 1)
    if cursor is not None:
        stmt = stmt.where(AuditEvent.id < cursor)
    rows = db.scalars(stmt).all()
    more = len(rows) > limit
    rows = rows[:limit]
    return {
        "items": [
            {"id": e.id, "ts": e.ts.isoformat(), "actor_user_id": e.actor_user_id, "action": e.action,
             "target_type": e.target_type, "target_id": e.target_id, "detail": e.detail or {}}
            for e in rows
        ],
        "next_cursor": rows[-1].id if (rows and more) else None,
    }
