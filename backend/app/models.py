from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class Workspace(Base):
    """A tenant boundary. One user creates it and becomes its Workspace Admin;
    others join by single-use invite as Team Members. Every virtual key, provider
    credential, and usage row belongs to exactly one workspace, and no query ever
    crosses that boundary."""

    __tablename__ = "workspaces"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)  # not unique — you join by invite
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # Opt-in prompt/response capture (see app/content_capture.py). OFF by default; only a workspace admin
    # can change it. Who/when is kept because the project has no general audit log.
    content_logging_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    content_logging_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Informational user id, deliberately NOT a foreign key: workspaces <-> users would be a circular FK
    # (users.workspace_id already points the other way), and a dangling id after a user is deleted is harmless.
    content_logging_updated_by: Mapped[int | None] = mapped_column(BigInteger)
    # Separate opt-in for storing the actual images (app/content_images.py). OFF by default and never turned on
    # by content_logging_enabled. Same no-FK reasoning for the user id.
    image_logging_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    image_logging_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    image_logging_updated_by: Mapped[int | None] = mapped_column(BigInteger)
    # Bumped in the same transaction as ANY change to this workspace's guardrail rules or key attachments. The
    # gateway validates its in-process compiled-rule cache against this number on every use, so a change applies
    # to the very next request in any worker (app.guardrails).
    guardrail_version: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")


class User(Base):
    """A signed-up account. A user belongs to at most one workspace at a time
    (`workspace_id` / `workspace_role`); a fresh signup belongs to none until it
    creates or joins one."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    username: Mapped[str] = mapped_column(String, nullable=False, unique=True)  # login id
    # "<salt_hex>$<scrypt_hex>". Always set (signup requires a password).
    password_hash: Mapped[str] = mapped_column(String, nullable=False, default="")
    # The one workspace this user is in, or NULL. Role is "admin" | "member".
    workspace_id: Mapped[int | None] = mapped_column(
        BigInteger,
        ForeignKey("workspaces.id", ondelete="SET NULL"),
        index=True,
    )
    workspace_role: Mapped[str | None] = mapped_column(String)  # "admin" | "member"
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class WorkspaceInvite(Base):
    """A single-use code a Workspace Admin mints for one person. Consumed on join;
    revocable; expires. "Open" = accepted_at IS NULL AND expires_at > now()."""

    __tablename__ = "workspace_invites"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    workspace_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    code: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    label: Mapped[str | None] = mapped_column(String)  # e.g. "for Jane"
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    accepted_by_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="SET NULL")
    )
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class VirtualKey(Base):
    __tablename__ = "virtual_keys"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    # Tenancy anchor — every read/write scopes on this.
    workspace_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # The Team Member this key is assigned to. NULL = workspace-level / unassigned
    # (only the Workspace Admin sees it).
    assigned_user_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    label: Mapped[str] = mapped_column(String, nullable=False)
    # HMAC-SHA256(SECRET_KEY, raw_key), hex. The raw key is shown once and never stored.
    key_hash: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    # "vk_" + first 8 chars of the raw key — display only.
    key_prefix: Mapped[str] = mapped_column(String, nullable=False)
    # On/off spend gate. False => requests with this key return 403 "key paused".
    # True => requests hit the real provider (402 if the workspace has no key for it).
    allow_live: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Provider used when an OpenAI-compatible request sends a bare model name (no "provider/" prefix).
    default_provider: Mapped[str | None] = mapped_column(String)
    # Spend cap (USD) per budget window. Null = unlimited. Over budget -> 402 budget_exceeded.
    monthly_budget_usd: Mapped[float | None] = mapped_column(Numeric(12, 6))
    # Budget window: "day" | "week" | "month" (rolling, calendar-aligned) or "custom".
    budget_period: Mapped[str] = mapped_column(String, nullable=False, default="month")
    # For budget_period == "custom": the fixed [start, end) the cap applies to.
    budget_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    budget_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Soft delete: only a REVOKED key can be deleted. The row stays (so its usage history, cost totals and stored
    # content are untouched) but it leaves the keys list for a separate "Deleted keys" view, no longer counts toward
    # MAX_KEYS_PER_WORKSPACE, and cannot be edited. Authentication is unaffected: a deleted key is always revoked.
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Denormalised "this key has at least one guardrail rule set attached". False (the usual case) lets the gateway
    # skip guardrails with no extra query. Maintained whenever attachments change (app.guardrails.sync_key_flag).
    has_guardrails: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    # Null = never expires. Past this instant, require_virtual_key rejects the
    # key with the same generic 401 as a revoked/unknown key (no state leak).
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Per-key content logging (see app/content_capture.py). Both default OFF and are only editable by a workspace
    # admin. A key is captured only if its WORKSPACE master switch is on as well (workspaces.content_logging_enabled /
    # image_logging_enabled): effective = workspace AND key. Images additionally require text capture.
    content_logging_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    image_logging_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    allowed_providers: Mapped[list["AllowedProvider"]] = relationship(
        back_populates="virtual_key",
        cascade="all, delete-orphan",
        lazy="selectin",
    )
    allowed_models: Mapped[list["AllowedModel"]] = relationship(
        back_populates="virtual_key",
        cascade="all, delete-orphan",
        lazy="selectin",
    )

    def provider_names(self) -> list[str]:
        return sorted(ap.provider for ap in self.allowed_providers)

    def models_for(self, provider: str) -> list[str]:
        """Explicit per-model allow-list for one provider. Empty = every model
        of that provider is allowed (the default — matches every key created
        before per-model ACLs existed)."""
        return sorted(am.model for am in self.allowed_models if am.provider == provider)


class AllowedProvider(Base):
    __tablename__ = "allowed_providers"
    __table_args__ = (
        UniqueConstraint("virtual_key_id", "provider", name="uq_allowed_provider"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    virtual_key_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("virtual_keys.id", ondelete="CASCADE"), nullable=False
    )
    provider: Mapped[str] = mapped_column(String, nullable=False)

    virtual_key: Mapped[VirtualKey] = relationship(back_populates="allowed_providers")


class AllowedModel(Base):
    """An explicit per-model allow-list entry for a virtual key. Zero rows for a
    given (virtual_key_id, provider) pair means every model of that provider is
    allowed — the default, fully backward compatible. Any row present for that
    pair flips enforcement (gateway.authorize_model) to an explicit allow-list."""

    __tablename__ = "allowed_models"
    __table_args__ = (
        UniqueConstraint("virtual_key_id", "provider", "model", name="uq_allowed_model"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    virtual_key_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("virtual_keys.id", ondelete="CASCADE"), nullable=False
    )
    provider: Mapped[str] = mapped_column(String, nullable=False)
    model: Mapped[str] = mapped_column(String, nullable=False)

    virtual_key: Mapped[VirtualKey] = relationship(back_populates="allowed_models")


class ProviderCredential(Base):
    """A workspace's provider API key, encrypted at rest. Its live-flagged virtual
    keys call real providers on it, up to `monthly_cap_usd`. A server env var for
    the same provider always wins over this."""

    __tablename__ = "provider_credentials"
    __table_args__ = (
        UniqueConstraint("workspace_id", "provider", name="uq_provcred_ws_provider"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    workspace_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider: Mapped[str] = mapped_column(String, nullable=False)  # openai|anthropic|gemini|openrouter
    ciphertext: Mapped[str] = mapped_column(Text, nullable=False)  # Fernet token
    last4: Mapped[str] = mapped_column(String(8), nullable=False)  # display only
    # Monthly ceiling (USD) on live spend routed through this provider key.
    # NULL => fall back to settings.LIVE_CAP_DEFAULT_USD.
    monthly_cap_usd: Mapped[float | None] = mapped_column(Numeric(12, 6))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class ModelPricing(Base):
    """A workspace's own price override for a (provider, model) pair — lets a
    Workspace Admin price a newly released or custom model, or correct a
    built-in estimate, with no code deploy. Takes precedence over the
    built-in CONFIGURED_PRICING table (and its optional
    MODEL_PRICING_OVERRIDES_PATH file) for this workspace's own cost
    calculations only — see gateway.record_usage."""

    __tablename__ = "model_pricing"
    __table_args__ = (
        UniqueConstraint("workspace_id", "provider", "model", name="uq_model_pricing_ws"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    workspace_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider: Mapped[str] = mapped_column(String, nullable=False)
    model: Mapped[str] = mapped_column(String, nullable=False)
    input_per_1m: Mapped[float] = mapped_column(Numeric(12, 6), nullable=False)
    output_per_1m: Mapped[float] = mapped_column(Numeric(12, 6), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class UsageLog(Base):
    __tablename__ = "usage_logs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    key_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("virtual_keys.id", ondelete="CASCADE"), nullable=False
    )
    request_id: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    provider: Mapped[str] = mapped_column(String, nullable=False)  # openai | anthropic | openrouter
    model: Mapped[str] = mapped_column(String, nullable=False)
    prompt_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    completion_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    total_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    # USD, nullable. When cost_source == "provider" this is the amount the
    # provider actually charged (e.g. OpenRouter's usage.cost); "configured" =
    # tokens x price table; "unknown" = neither is available (cost is NULL —
    # an honest gap, never a fabricated number). Every SUM(cost) aggregate in
    # this codebase already wraps in coalesce(..., 0), so a NULL row is safe.
    cost: Mapped[float | None] = mapped_column(Numeric(12, 6))
    cost_source: Mapped[str] = mapped_column(String, nullable=False, default="configured")
    # Legacy columns from the retired simulator — always written "live" / False now.
    simulated: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    latency_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    # "success" | "error" for a request that reached a provider; "blocked" is reserved for one that was stopped
    # before any provider call (see app.usage_status). Analytics ignore blocked rows (scoping.counted_usage).
    status: Mapped[str] = mapped_column(String, nullable=False, default="success")
    # NULL for an ordinary row; "flagged" | "blocked" | "unchecked" once a content rule applies (app.usage_status).
    guardrail: Mapped[str | None] = mapped_column(String(12))
    mode: Mapped[str] = mapped_column(String, nullable=False, default="live")
    # Truncated request/response text — populated only when LOG_BODIES=true.
    prompt_preview: Mapped[str | None] = mapped_column(Text)
    response_preview: Mapped[str | None] = mapped_column(Text)
    # Whatever extra usage detail the provider's own response exposed (cached
    # tokens, reasoning tokens, cache-write tokens, per-modality breakdown,
    # ...), verbatim and provider-shaped — see adapters/base.py::UsageInfo.raw.
    usage_raw: Mapped[dict | None] = mapped_column(JSONB)
    # Non-token billing dimensions — audio transcription bills by input
    # duration, TTS by input character count. Never forced into
    # prompt_tokens/completion_tokens (which stay 0 for these rows); see
    # adapters/base.py::UsageInfo and gateway.completion_result_from_usage.
    duration_seconds: Mapped[float | None] = mapped_column(Numeric(12, 3))
    characters: Mapped[int | None] = mapped_column(Integer)
    # spec's "timestamp"; named `ts` to dodge the SQL type-name clash.
    ts: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )

    __table_args__ = (
        Index("ix_usage_logs_key_id", "key_id"),
        Index("ix_usage_logs_provider", "provider"),
        Index("ix_usage_logs_model", "model"),
    )


class UsageContent(Base):
    """Opt-in prompt/response content for ONE usage row (1:1), stored Fernet-encrypted.

    Written only when the workspace has content logging on (workspaces.content_logging_enabled), after the
    usage row is committed and in its own transaction, so a failure here can never affect the request, the
    usage row, or any analytics. A missing row is normal: logging was off, the request type is not captured,
    the per-workspace cap was reached, capture failed, or the content expired. Content is never invented.

    `workspace_id` is denormalised (usage_logs has none) for a strict isolation check and a cheap cascade;
    `expires_at` is fixed at insert (created_at + CONTENT_RETENTION_DAYS, max 30) and enforced on every read
    as well as by the sweeps in app.content_capture. Deleting a usage row, key or workspace cascades here."""

    __tablename__ = "usage_content"
    __table_args__ = (
        Index("ix_usage_content_expires_at", "expires_at"),
        Index("ix_usage_content_workspace_id", "workspace_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    usage_log_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("usage_logs.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    workspace_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String, nullable=False)  # chat | responses | messages | gemini | ...
    # Fernet(JSON {"v":1,"kind":...,"request":{...},"response":{...}}) — see app.content_capture.
    content_encrypted: Mapped[str] = mapped_column(Text, nullable=False)
    request_truncated: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    response_truncated: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Sizes of the redacted plaintext before encryption (no content).
    request_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    response_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class UsageContentImage(Base):
    """One stored image (an input the user sent, or one the model generated) of a usage_content record.

    Bytes are verified by magic number (PNG/JPEG/WebP/GIF only) and Fernet-encrypted; `mime` is the SNIFFED type,
    never the declared one. `stored_bytes` is the size as stored (what the caps count). Expiry is copied from the
    parent and enforced on every read; the FKs cascade, so deleting the text record, usage row, key or workspace
    removes the images too. Never returned by list endpoints — only by the image endpoint."""

    __tablename__ = "usage_content_images"
    __table_args__ = (
        Index("ix_usage_content_images_content_id", "content_id"),
        Index("ix_usage_content_images_workspace_id", "workspace_id"),
        Index("ix_usage_content_images_expires_at", "expires_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    content_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("usage_content.id", ondelete="CASCADE"), nullable=False
    )
    workspace_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[str] = mapped_column(String, nullable=False)  # input | output
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    mime: Mapped[str] = mapped_column(String, nullable=False)
    byte_size: Mapped[int] = mapped_column(Integer, nullable=False)  # decoded image bytes
    stored_bytes: Mapped[int] = mapped_column(Integer, nullable=False)  # encrypted bytes as stored
    sha256: Mapped[str] = mapped_column(String, nullable=False)
    data_encrypted: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class IdempotencyRecord(Base):
    """One client-supplied Idempotency-Key, scoped to the virtual key that sent
    it. Lets the gateway replay a previously-completed response instead of
    re-calling (and re-billing) the provider when a client retries the same
    request — see app.idempotency.

    Spend protection, so unlike the fail-OPEN rate limiter this is Postgres-only
    and fails CLOSED: the claim is durable, transactional, and first-writer-wins
    via UNIQUE(key_id, idempotency_key).

    The response body is Fernet-encrypted at rest (never plaintext) and only
    stored up to settings.IDEMPOTENCY_MAX_REPLAY_BYTES. A larger response is
    recorded terminal-but-not-replayable (`replayable=False`, body NULL) so the
    key still can't drive a second billable call, but a later retry gets an
    honest 409 instead of a silently-wrong empty replay."""

    __tablename__ = "idempotency_keys"
    __table_args__ = (
        UniqueConstraint("key_id", "idempotency_key", name="uq_idempotency_key_scope"),
        Index("ix_idempotency_expires_at", "expires_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    # Tenant scope — every lookup filters on this, so a key from another virtual
    # key/workspace can never retrieve this row.
    key_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("virtual_keys.id", ondelete="CASCADE"), nullable=False
    )
    workspace_id: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)
    idempotency_key: Mapped[str] = mapped_column(String(255), nullable=False)
    # SHA-256 hex of the full semantic request — detects same-key/different-body.
    request_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    endpoint: Mapped[str] = mapped_column(String, nullable=False)
    provider: Mapped[str] = mapped_column(String, nullable=False)
    model: Mapped[str] = mapped_column(String, nullable=False)
    # in_progress | completed | failed
    status: Mapped[str] = mapped_column(String, nullable=False, default="in_progress")
    # False until a terminal response within the size cap is stored.
    replayable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    response_status: Mapped[int | None] = mapped_column(Integer)
    response_content_type: Mapped[str | None] = mapped_column(String)
    # Fernet(base64(body)) — see app.idempotency; NULL when not replayable.
    response_body_encrypted: Mapped[str | None] = mapped_column(Text)
    usage_log_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("usage_logs.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class GuardrailRuleSet(Base):
    """A named, reusable group of content rules (e.g. "No secrets"), owned by one workspace and attached to keys."""

    __tablename__ = "guardrail_rule_sets"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    workspace_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str | None] = mapped_column(String)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
    created_by: Mapped[int | None] = mapped_column(BigInteger)  # informational user id, no FK (like updated_by above)

    __table_args__ = (Index("uq_guardrail_set_name", "workspace_id", func.lower(name), unique=True),)


class GuardrailRule(Base):
    """One rule. kind: phrase (case-insensitive text), regex (runs on the ORIGINAL text with the admin's own flags),
    preset (a built-in detector named by preset_id). action: flag (let it through, alert) or block."""

    __tablename__ = "guardrail_rules"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    rule_set_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("guardrail_rule_sets.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String, nullable=False)
    kind: Mapped[str] = mapped_column(String(10), nullable=False)
    pattern: Mapped[str | None] = mapped_column(String)
    preset_id: Mapped[str | None] = mapped_column(String(20))
    action: Mapped[str] = mapped_column(String(5), nullable=False)
    whole_word: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")

    __table_args__ = (
        CheckConstraint("kind IN ('phrase','regex','preset')", name="ck_guardrail_rule_kind"),
        CheckConstraint("action IN ('flag','block')", name="ck_guardrail_rule_action"),
        CheckConstraint("pattern IS NULL OR length(pattern) <= 200", name="ck_guardrail_rule_pattern_len"),
        Index("ix_guardrail_rules_set", "rule_set_id"),
    )


class KeyGuardrailSet(Base):
    """Which rule sets apply to which virtual key (many-to-many)."""

    __tablename__ = "key_guardrail_sets"

    key_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("virtual_keys.id", ondelete="CASCADE"), primary_key=True
    )
    rule_set_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("guardrail_rule_sets.id", ondelete="CASCADE"), primary_key=True
    )


class GuardrailHit(Base):
    """A rule that matched one request. Doubles as the admin's notification (unread = reviewed_at IS NULL).
    Names are snapshots (the rule may later be edited or deleted). The snippet is a short redacted context, encrypted,
    and may be absent; only for a plain word/phrase rule does it also hold the matched words. The whole row is deleted
    once expires_at passes."""

    __tablename__ = "guardrail_hits"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    workspace_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    key_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("virtual_keys.id", ondelete="CASCADE"), nullable=False)
    usage_log_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("usage_logs.id", ondelete="CASCADE"), nullable=False
    )
    rule_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("guardrail_rules.id", ondelete="SET NULL"))
    rule_name: Mapped[str] = mapped_column(String, nullable=False)
    rule_set_name: Mapped[str] = mapped_column(String, nullable=False)
    rule_kind: Mapped[str] = mapped_column(String(10), nullable=False)
    action: Mapped[str] = mapped_column(String(5), nullable=False)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    source_role: Mapped[str | None] = mapped_column(String(20))
    occurrences: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    snippet_enc: Mapped[str | None] = mapped_column(Text)  # Fernet; None when no safe snippet exists
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reviewed_by: Mapped[int | None] = mapped_column(BigInteger)  # informational user id, no FK
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("usage_log_id", "rule_id", name="uq_guardrail_hit_request_rule"),
        Index("ix_guardrail_hits_unreviewed", "workspace_id", "id", postgresql_where=reviewed_at.is_(None)),
        Index("ix_guardrail_hits_key_ts", "key_id", "ts"),
        Index("ix_guardrail_hits_expires", "expires_at"),
    )


class GuardrailRecordingCounter(Base):
    """How many evidence records a workspace has written in one clock hour (database clock). One atomic upsert per
    admission keeps the hourly recording ceiling exact under any concurrency (app.guardrails.admit)."""

    __tablename__ = "guardrail_recording_counters"

    workspace_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True
    )
    bucket: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    recorded: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    throttled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AuditEvent(Base):
    """A small, generic record of an administrative or operational event in a workspace. The detail holds ids, names
    and counts only: never prompt text, matched text or secrets."""

    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    workspace_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    actor_user_id: Mapped[int | None] = mapped_column(BigInteger)
    action: Mapped[str] = mapped_column(String, nullable=False)
    target_type: Mapped[str | None] = mapped_column(String)
    target_id: Mapped[str | None] = mapped_column(String)
    detail: Mapped[dict | None] = mapped_column(JSONB)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (Index("ix_audit_events_workspace_ts", "workspace_id", "ts"),)
