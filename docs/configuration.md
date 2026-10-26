# Environment variables

| Var | Default | Purpose |
|---|---|---|
| `ENVIRONMENT` | `development` | Set to `production` (or `staging`) on a deployed host. The app then **refuses to start** on the dev-default `SECRET_KEY` or without an `ENCRYPTION_KEY`. |
| `DATABASE_URL` | local compose value | Postgres. `postgres://` / `postgresql://` auto-rewritten to the psycopg3 driver. |
| `REDIS_URL` | `""` | Atomic, distributed rate limiting (`app/ratelimit.py`). Empty ⇒ every check uses the in-process fallback directly (a behavioral no-op vs. the pre-migration implementation). See [Reliability](architecture.md#reliability-connection-pooling-circuit-breaker-atomic-rate-limiting) below. |
| `SECRET_KEY` | `dev-secret` | HMAC pepper for virtual-key hashing **and** session-cookie signing. Must be overridden when `ENVIRONMENT` is deployed. |
| `ENCRYPTION_KEY` | `""` | Fernet key (urlsafe-base64, 32 bytes) encrypting each workspace's stored provider keys. **Required when `ENVIRONMENT` is deployed** (`production`/`prod`/`staging`) — startup fails without it, so it can never silently derive from `SECRET_KEY` (rotating that would orphan every stored credential). Empty is allowed only in development/test, where it is derived from `SECRET_KEY`. Generate: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. |
| `SESSION_TTL_HOURS` | `168` | Session-cookie lifetime. |
| `ALLOW_SIGNUP` | `true` | Whether new accounts can be created. |
| `MAX_USERS` | `300` | Signup refused past this many accounts (whole instance). |
| `SIGNUPS_PER_IP_PER_HOUR` | `5` | Signup rate limit per client IP (Redis-backed, atomic — see `REDIS_URL`). |
| `JOINS_PER_IP_PER_HOUR` | `10` | Workspace-join rate limit per client IP (Redis-backed, atomic). |
| `MAX_WORKSPACES` | `200` | Create-workspace refused past this many. |
| `MAX_MEMBERS_PER_WORKSPACE` | `25` | Join refused once a workspace is this full. |
| `MAX_KEYS_PER_WORKSPACE` | `25` | Virtual-key cap per workspace. |
| `MAX_OPEN_INVITES_PER_WORKSPACE` | `50` | Cap on un-consumed, un-expired invites. |
| `INVITE_TTL_DAYS` | `14` | Invite code lifetime. |
| `MAX_USAGE_ROWS_PER_WORKSPACE` | `20000` | The proxy stops recording once a workspace hits this. |
| `PLAYGROUND_REQUESTS_PER_HOUR` | `120` | Per-workspace proxy rate limit (Redis-backed, atomic). |
| `MAX_MODEL_PRICING_PER_WORKSPACE` | `100` | Cap on a workspace's own model-pricing override entries. |
| `ALLOW_LIVE_KEYS` | `true` | Let a Workspace Admin attach the workspace's own provider key. |
| `LIVE_CAP_DEFAULT_USD` | `5` | Default monthly live-spend cap for a provider with no explicit cap. Any non-negative per-provider value, no ceiling. |
| `CORS_ORIGINS` | `""` | Comma-separated origins; local dev only. |
| `GATEWAY_PUBLIC_URL` | `https://llm-usage-tracker-97q0.onrender.com` | The hosted gateway **root** shown in the dashboard's "Connect your app" guide (`GET /api/integration`) — the one place this URL is configured. A trailing `/v1` is tolerated. |
| `GATEWAY_LOCAL_URL` | `http://127.0.0.1:8000` | The local gateway root offered in the same guide. |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `GEMINI_API_KEY` | `""` | Instance-wide provider creds — configure a provider for every workspace. Always win over a workspace's attached key. Never shown in the UI. With none set, a request `402`s until its workspace attaches a key. Gemini uses Google's OpenAI-compatible endpoint. |
| `PROVIDER_CHECK_TTL` | `300` | Seconds to cache a provider liveness check. |
| `RENDER_GIT_COMMIT` | `""` | Deployed commit SHA, **set automatically by Render** at runtime (Docker included). Surfaced at `GET /version` for drift detection; leave unset locally ⇒ `commit: null`. Never set this by hand. |
| `RENDER_GIT_BRANCH` | `""` | Deployed branch, set automatically by Render. Surfaced at `GET /version`; unset locally ⇒ `branch: null`. |
| `LOG_BODIES` | `false` | **Legacy**, instance-wide: store 500-char plaintext prompt/response previews on `usage_logs`. Off by default — bodies can be sensitive. Superseded by the per-workspace [Prompt & response logging](content-logging.md#prompt--response-logging) below, which it does not enable. |
| `CONTENT_RETENTION_DAYS` | `30` | How long stored prompt/response content is kept (1–30; values above 30 are rejected at startup). |
| `CONTENT_MAX_BYTES` | `32768` | Max stored size per side (request / response) of one record; more is truncated and flagged. |
| `CONTENT_MAX_FIELD_CHARS` | `8000` | Max characters kept per message / field. |
| `CONTENT_MAX_ROWS_PER_WORKSPACE` | `2000` | Capture pauses (requests are unaffected) while a workspace holds this many unexpired records. |
| `CONTENT_IMAGE_MAX_BYTES` | `2000000` | Image logging (separate opt-in): largest single image stored (decoded bytes). |
| `CONTENT_IMAGE_MAX_PER_REQUEST` | `4` | Most images stored for one request. |
| `CONTENT_IMAGE_MAX_REQUEST_BYTES` | `6000000` | Most encrypted bytes stored for one request. |
| `CONTENT_IMAGE_MAX_BYTES_PER_WORKSPACE` | `50000000` | Stored image bytes (encrypted size) one workspace may hold; further images are skipped. |
| `CONTENT_IMAGE_MAX_BYTES_TOTAL` | `150000000` | The same ceiling across ALL workspaces, protecting the shared database. |
| `CONTENT_SWEEP_INTERVAL_SECONDS` | `3600` | At most how often an authenticated request (signed-in API call or gateway call with a valid virtual key) also runs one batch of physical deletion of expired content/images, so space is reclaimed even when logging is off or traffic is low. Never on `/healthz`. |
| `MODEL_PRICING_OVERRIDES_PATH` | `""` | Optional path to a JSON file of extra `{provider, model, input, output}` price entries, merged over the built-in table at startup — price a newly released model without a code deploy. A missing/malformed file is silently ignored. |
| `IDEMPOTENCY_TTL_HOURS` | `24` | How long a stored `Idempotency-Key` result is replayable before it expires and an identical request is treated as fresh (`app/idempotency.py`). |
| `IDEMPOTENCY_MAX_REPLAY_BYTES` | `262144` | Max response body stored (encrypted) for replay. A larger response (big base64 image, long audio) is recorded terminal-but-**not** replayable — no double-charge, but a retry gets a 409 rather than a wrong empty body. |
| `IDEMPOTENCY_INFLIGHT_TIMEOUT_SECONDS` | `120` | A claim stuck `in_progress` longer than this (a crashed leader) may be reclaimed. Tied to the max provider call timeout (60s) + margin, deliberately not a short value. |
