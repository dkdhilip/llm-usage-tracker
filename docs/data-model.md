# Data model

- **workspaces** — `id, name, created_at`. The tenant boundary. Deleting one cascades its keys,
  usage, provider credentials, and invites.
- **users** — `id, username (unique), password_hash (scrypt), workspace_id → workspaces
  (nullable, `ON DELETE SET NULL`), workspace_role (`admin` | `member` | NULL), created_at`. A
  user is in at most one workspace. Sessions are a stateless HMAC-signed cookie carrying the
  user id.
- **workspace_invites** — `id, workspace_id → workspaces, code (unique, `secrets.token_urlsafe`),
  label, created_at, expires_at, accepted_by_id → users, accepted_at`. Single-use: `join`
  consumes it with a guarded `UPDATE … WHERE accepted_at IS NULL`. "Open" = not accepted and not
  expired.
- **virtual_keys** — `id, workspace_id → workspaces (`ON DELETE CASCADE`), assigned_user_id →
  users (nullable), label, key_hash, key_prefix, allow_live, default_provider,
  monthly_budget_usd, budget_period, budget_start, budget_end, expires_at (nullable),
  created_at, last_used_at, revoked_at, content_logging_enabled, image_logging_enabled`
  (both `NOT NULL DEFAULT false`: per-key logging switches, see [Per-key logging](content-logging.md#per-key-logging)). `assigned_user_id` NULL = workspace-level (admin-only
  visibility); set = that Team Member sees it. Only the HMAC hash + an 11-char prefix are stored;
  the raw key is shown once. Per-key **budget**: `$X` per `1 day` / `1 week` / `1 month`
  (rolling), or a `custom` fixed `[budget_start, budget_end]` range → `402` when spent.
  `expires_at` NULL = never expires; past it, `require_virtual_key` rejects the key with the same
  generic `401` as a revoked/unknown one (no state leak).
- **allowed_providers** — `(virtual_key_id, provider)`, unique. The per-key provider ACL enforced
  on every proxied request.
- **allowed_models** — `(virtual_key_id, provider, model)`, unique. An explicit per-model
  allow-list layered on top of `allowed_providers`: zero rows for a given `(key, provider)` pair
  means every model of that provider is allowed (the default, unchanged from before this table
  existed); any row present flips that provider to an explicit allow-list, enforced by
  `gateway.authorize_model` (`403 model_not_allowed` on a miss).
- **usage_logs** — `id, key_id, request_id, provider, model, prompt_tokens, completion_tokens,
  total_tokens, duration_seconds (nullable), characters (nullable), cost (nullable), cost_source,
  latency_ms, status, prompt_preview, response_preview, usage_raw (jsonb, nullable), ts` (`mode` /
  `simulated` are legacy columns from the retired simulator — always `live` / `false`).
  `duration_seconds`/`characters` (migration v9) are the non-token billing dimensions — audio
  transcription's real unit for duration-billed models, TTS's input character count; see [Billing
  units aren't always tokens](architecture.md#billing-units-arent-always-tokens). At most one of the three (`prompt_tokens`+`completion_tokens`
  as a pair, `duration_seconds`, `characters`) is ever meaningfully non-zero/non-null for a given
  row. Workspace ownership flows through
  `key_id → virtual_keys.workspace_id`. `cost_source` = `provider` (real charge) | `workspace`
  (this workspace's own `model_pricing` override) | `configured` (built-in/JSON price table) |
  `unknown` (none available — `cost` is `NULL`, never a fabricated number; every `SUM(cost)` in
  the codebase already `coalesce`s, so this is safe). `usage_raw` holds whatever extra usage
  detail a provider's own response exposed (cached/reasoning tokens, prompt-cache reads/writes,
  per-modality token counts, ...) verbatim, provider-shaped — see
  `app/adapters/base.py::UsageInfo`. `status` = `success` or `error` (a failed upstream call
  still records a row). Previews are null unless `LOG_BODIES=true`.
- **provider_credentials** — `(id, workspace_id → workspaces (`ON DELETE CASCADE`), provider,
  ciphertext, last4, monthly_cap_usd, updated_at)`, unique on `(workspace_id, provider)`. The
  workspace's own provider key; its `allow_live` virtual keys call real providers on it, and
  `enforce_workspace_cap` blocks calls on a provider once the calendar month's live spend on it
  hits `monthly_cap_usd` (NULL ⇒ `LIVE_CAP_DEFAULT_USD`). `ciphertext` is a Fernet
  (AES-128-CBC + HMAC) token; the plaintext is never returned by the API. A server env var for
  the same provider always wins.
- **model_pricing** — `(id, workspace_id → workspaces (`ON DELETE CASCADE`), provider, model,
  input_per_1m, output_per_1m, created_at, updated_at)`, unique on `(workspace_id, provider,
  model)`. A workspace's own price override — see [Model pricing registry](#model-pricing-registry) below.
- **idempotency_keys** — `(id, key_id → virtual_keys (`ON DELETE CASCADE`), workspace_id,
  idempotency_key, request_fingerprint, endpoint, provider, model, status (`in_progress` |
  `completed` | `failed`), replayable, response_status, response_content_type,
  response_body_encrypted (Fernet, nullable), usage_log_id → usage_logs (nullable), created_at,
  updated_at, expires_at)`, unique on `(key_id, idempotency_key)`. Backs `Idempotency-Key` replay —
  see [Idempotency](architecture.md#idempotency-appidempotencypy) under Reliability. Scoped to the virtual key, so a key from another key/workspace
  can never retrieve this row; the stored response body is encrypted at rest.

- **usage_content_images** - `(id, content_id -> usage_content (`ON DELETE CASCADE`), workspace_id ->
  workspaces (`ON DELETE CASCADE`), role (`input` | `output`), position, mime (sniffed), byte_size,
  stored_bytes, sha256, data_encrypted (Fernet, BYTEA), created_at, expires_at)`. Opt-in per workspace
  (`workspaces.image_logging_enabled`, default false). See [Image logging](content-logging.md#image-logging) below.
- **usage_content** — `(id, usage_log_id → usage_logs (`ON DELETE CASCADE`, unique), workspace_id →
  workspaces (`ON DELETE CASCADE`), kind, content_encrypted (Fernet), request_truncated,
  response_truncated, request_bytes, response_bytes, created_at, expires_at)`. Opt-in per workspace
  (`workspaces.content_logging_enabled`, default false). See [Prompt & response logging](content-logging.md#prompt--response-logging) below.

## Model pricing registry

A Workspace Admin manages this through the API (`GET`/`PUT`/`DELETE
/api/workspace/pricing`; the Workspace page has no card for it): price a model the workspace actually uses — newly released, a
fine-tune, a correction to the built-in estimate — with no code deploy. It's deliberately
**workspace-scoped, not instance-wide**: this app has no global admin (removed in the v6
migration; see below), so an instance-wide catalog editable by any Workspace Admin would let one
tenant silently change cost numbers for every other tenant, breaking the isolation guarantee
every other piece of workspace config already upholds. `MODEL_PRICING_OVERRIDES_PATH` (a JSON
file) is unchanged and still instance-wide — that one's set by whoever deploys the instance, not
through the app.

Precedence, resolved once in `gateway.record_usage` — the single point every request path (native
adapters + legacy translation, streaming + non-streaming) converges on before writing a
`usage_logs` row: a real provider-reported charge always wins (`cost_source: "provider"`); else
this workspace's own `model_pricing` row if one exists (`"workspace"`); else the built-in table
merged with `MODEL_PRICING_OVERRIDES_PATH` (`"configured"`); else an honest `"unknown"`
(`cost = NULL`). `record_usage` mutates the `CompletionResult` it's given in place, so a
client-facing response field read right after (`/v1/proxy/chat`'s `cost`/`pricing` block, the
legacy `/v1/chat/completions` translation's `x_gateway` envelope) reflects the same number that
gets persisted.

There is no Alembic. `app/bootstrap.py::_migrate` runs guarded `information_schema` checks +
`ALTER TABLE`s on boot. The v6 migration adds the workspace tables/columns, moves each existing
account into a personal workspace as its admin (keys carried over), drops the old global-admin
account and `virtual_keys.user_id`. v7 adds `virtual_keys.expires_at`, the `allowed_models`
table, and `usage_logs.usage_raw`/nullable `cost`. v8 adds the `model_pricing` table. v9 adds
`usage_logs.duration_seconds`/`.characters`. All additive and backward compatible with every
key/row created before them.
