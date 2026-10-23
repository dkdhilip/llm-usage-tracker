"""Request log — recent `usage_logs` rows for the Requests tab. Workspace Admin
only (a Team Member's view is the Dashboard, scoped to their assigned keys).

The `prompt_preview`/`response_preview` fields are the LEGACY global LOG_BODIES feature (off by default). The
per-workspace, encrypted, 30-day content log is separate: rows carry `has_content`, and the content itself is
only ever returned by `GET /api/requests/{id}/content` (workspace admin, strict workspace isolation)."""

import logging
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

from app import content_capture, content_images
from app.config import settings
from app.db import get_db
from app.models import UsageContent, UsageContentImage, UsageLog, VirtualKey, Workspace
from app.scoping import Viewer, scope_usage
from app.workspace import require_workspace_admin

router = APIRouter(prefix="/api", tags=["requests"])
logger = logging.getLogger("app.content_capture")
_IMAGE_MIMES = frozenset({"image/png", "image/jpeg", "image/gif", "image/webp"})


@router.get("/requests")
def list_requests(
    limit: int = 50,
    cursor: int | None = None,  # return rows with id < cursor
    provider: str | None = None,
    model: str | None = None,
    key_id: int | None = None,
    status: str | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
    db: Session = Depends(get_db),
    v: Viewer = Depends(require_workspace_admin),
) -> dict:
    limit = max(1, min(limit, 200))
    stmt: Select = scope_usage(
        select(UsageLog, VirtualKey.label, VirtualKey.key_prefix)
        .join(VirtualKey, VirtualKey.id == UsageLog.key_id)
        .order_by(UsageLog.id.desc())
        .limit(limit + 1),
        v,
    )
    if cursor is not None:
        stmt = stmt.where(UsageLog.id < cursor)
    if start is not None:
        stmt = stmt.where(UsageLog.ts >= start)
    if end is not None:
        stmt = stmt.where(UsageLog.ts < end)
    if provider:
        stmt = stmt.where(UsageLog.provider == provider)
    if model:
        stmt = stmt.where(UsageLog.model == model)
    if key_id is not None:
        stmt = stmt.where(UsageLog.key_id == key_id)
    if status:
        stmt = stmt.where(UsageLog.status == status)

    rows = db.execute(stmt).all()
    has_more = len(rows) > limit
    rows = rows[:limit]

    # Which of these rows have LIVE (unexpired) stored content. Expiry is enforced here, at read time, so an
    # expired record is never reported even if the physical sweep has not reached it yet.
    ids = [u.id for u, _label, _prefix in rows]
    with_content = (
        set(
            db.scalars(
                select(UsageContent.usage_log_id).where(
                    UsageContent.usage_log_id.in_(ids),
                    UsageContent.workspace_id == v.workspace_id,
                    UsageContent.expires_at > func.now(),
                )
            )
        )
        if ids
        else set()
    )
    if cursor is None:
        content_capture.cleanup_expired(db)  # opportunistic physical deletion, on first-page loads only

    items = [
        {
            "id": u.id,
            "ts": u.ts.isoformat(),
            "request_id": u.request_id,
            "key_id": u.key_id,
            "key_label": label,
            "key_prefix": prefix,
            "provider": u.provider,
            "model": u.model,
            "prompt_tokens": u.prompt_tokens,
            "completion_tokens": u.completion_tokens,
            "total_tokens": u.total_tokens,
            # non-token billing dimensions (audio) — null for every token-billed row
            "duration_seconds": float(u.duration_seconds) if u.duration_seconds is not None else None,
            "characters": u.characters,
            "cost": float(u.cost) if u.cost is not None else None,
            "cost_source": u.cost_source,
            "latency_ms": u.latency_ms,
            "status": u.status,
            "prompt_preview": u.prompt_preview,
            "response_preview": u.response_preview,
            "has_content": u.id in with_content,
        }
        for u, label, prefix in rows
    ]
    return {
        "items": items,
        "next_cursor": items[-1]["id"] if (items and has_more) else None,
        "bodies_logged": settings.LOG_BODIES,  # legacy global flag
        "content_logging_enabled": bool(
            db.scalar(select(Workspace.content_logging_enabled).where(Workspace.id == v.workspace_id))
        ),
    }


@router.get("/requests/{usage_id}/content")
def get_request_content(
    usage_id: int,
    response: Response,
    db: Session = Depends(get_db),
    v: Viewer = Depends(require_workspace_admin),
) -> dict:
    """The stored prompt/response of ONE request. Workspace admins only; a request from another workspace (or
    one that does not exist) is a plain 404. Content past its retention is never returned, whether or not the
    physical sweep has deleted it yet."""
    usage = db.scalar(scope_usage(select(UsageLog).where(UsageLog.id == usage_id), v))
    if usage is None:
        raise HTTPException(404, "request not found")
    response.headers["Cache-Control"] = "no-store"
    retention = settings.CONTENT_RETENTION_DAYS
    now = datetime.now(UTC)
    row = db.scalar(
        select(UsageContent).where(UsageContent.usage_log_id == usage_id, UsageContent.workspace_id == v.workspace_id)
    )
    base = {"usage_id": usage_id, "retention_days": retention, "content": None}
    if row is None:
        # Nothing was stored (logging was off then, an unsupported request type, the workspace cap, or a capture
        # failure — the reason is not recorded) or it has already been deleted after expiring.
        aged_out = usage.ts <= now - timedelta(days=retention)
        return {**base, "content_status": "expired" if aged_out else "not_captured"}
    if row.expires_at <= now:
        return {**base, "content_status": "expired"}
    payload = content_capture.load(row)
    if payload is None:
        return {**base, "content_status": "unreadable"}  # e.g. ENCRYPTION_KEY changed since it was stored
    logger.info("content read: user=%s usage=%s", v.user_id, usage_id)  # who looked; never the content
    images = db.execute(
        select(UsageContentImage)
        .where(
            UsageContentImage.content_id == row.id,
            UsageContentImage.workspace_id == v.workspace_id,
            UsageContentImage.expires_at > func.now(),
        )
        .order_by(UsageContentImage.role.desc(), UsageContentImage.position)  # inputs first
    ).scalars()
    return {
        # metadata only: the bytes are served by the image endpoint below, never inlined here
        "images": [
            {"id": i.id, "role": i.role, "position": i.position, "mime": i.mime, "bytes": i.byte_size}
            for i in images
        ],
        **base,
        "content_status": "available",
        "content": payload,
        "kind": row.kind,
        "created_at": row.created_at.isoformat(),
        "expires_at": row.expires_at.isoformat(),
        "request_truncated": row.request_truncated,
        "response_truncated": row.response_truncated,
    }


@router.get("/requests/{usage_id}/images/{image_id}")
def get_request_image(
    usage_id: int,
    image_id: int,
    db: Session = Depends(get_db),
    v: Viewer = Depends(require_workspace_admin),
) -> Response:
    """The bytes of ONE stored image. Workspace admins only, scoped to the viewer's workspace through both the
    usage row and the image row; a foreign, unknown or EXPIRED image is a plain 404 (expiry is enforced here, not
    only by the physical sweep). The type served is the one sniffed from the bytes when stored, from a fixed
    allowlist, and the response cannot execute or be embedded as anything else."""
    usage = db.scalar(scope_usage(select(UsageLog).where(UsageLog.id == usage_id), v))
    if usage is None:
        raise HTTPException(404, "image not found")
    row = db.scalar(
        select(UsageContentImage)
        .join(UsageContent, UsageContent.id == UsageContentImage.content_id)
        .where(
            UsageContentImage.id == image_id,
            UsageContent.usage_log_id == usage_id,
            UsageContentImage.workspace_id == v.workspace_id,
            UsageContent.workspace_id == v.workspace_id,
            UsageContentImage.expires_at > func.now(),
            UsageContent.expires_at > func.now(),
        )
    )
    data = content_images.load_bytes(row) if row is not None else None
    if row is None or data is None or row.mime not in _IMAGE_MIMES:
        raise HTTPException(404, "image not found")
    logger.info("image read: user=%s usage=%s image=%s", v.user_id, usage_id, image_id)  # never the bytes
    return Response(
        content=data,
        media_type=row.mime,
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Content-Disposition": "inline",
            "Cross-Origin-Resource-Policy": "same-origin",
        },
    )
