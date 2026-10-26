# Architecture notes

## Adapter architecture

`app/adapters/` holds one module per provider (`openai_adapter.py` covers both OpenAI and
OpenRouter, which share the Chat Completions wire format, plus the Responses API and
Embeddings; `anthropic_adapter.py` covers Anthropic's Messages API; `gemini_adapter.py` covers
Gemini's `generateContent`/`streamGenerateContent` and `embedContent`/`batchEmbedContents`).
Each adapter owns its own request construction and response parsing — the governance layer
above it (`app/gateway.py`: auth, provider/model ACL, budgets, workspace caps) and the HTTP layer
below it (`app/providers.py::send_request`/`stream_request`, the single outbound-HTTP chokepoint
every adapter and the legacy `call_provider`/`stream_openai_compatible` functions funnel through)
are shared; the provider-specific shape in between is deliberately **not** collapsed into one
common format. A non-streaming native call returns the provider's raw JSON to the client,
untouched; `app/adapters/base.py::UsageInfo` is only what governance/logging need, pulled out of
that real response. Gemini's `usageMetadata` is cumulative per streamed chunk (unlike
Anthropic's two split SSE events), so `GeminiStreamUsageAccumulator` just keeps the latest values
rather than summing deltas. Embeddings and image generation never stream on the OpenAI side (no
streaming attempted this pass; embeddings never report output tokens either — both honestly report
`completion_tokens=0` rather than guess). OpenAI Images has a real complication worth naming: only
`gpt-image-1` reports usage at all (dall-e-2/3 report none), and what it reports mixes text tokens
and image tokens at different per-1M rates — the built-in price table's single input/output rate
can't represent that honestly, so it's deliberately left unregistered (`cost_source: "unknown"`,
never a guessed blended number) while the real text/image token split still lands in `usage_raw`
for a workspace's own pricing (see [Model pricing registry](data-model.md#model-pricing-registry)).

## Billing units aren't always tokens

Audio is where "everything is `prompt_tokens`/`completion_tokens`" stops being true, and the
schema says so explicitly rather than forcing a fit:

| Operation | Real billing unit | Where it lands |
|---|---|---|
| Chat, Responses, embeddings, most image gen | tokens | `usage_logs.prompt_tokens` / `.completion_tokens` |
| Transcription — `whisper-1` | **audio duration** (seconds) | `usage_logs.duration_seconds` |
| Transcription — `gpt-4o(-mini)-transcribe` | tokens (OpenAI's own choice, verified per-model, not assumed) | `usage_logs.prompt_tokens` / `.completion_tokens` |
| TTS — any model | **input character count** | `usage_logs.characters` |

`duration_seconds` and `characters` (migration v9) are dedicated nullable columns, not a token
count standing in for something else — a duration- or character-billed row always has
`prompt_tokens = completion_tokens = 0`, never an approximation. `app/adapters/base.py::UsageInfo`
carries the same two optional fields from the adapter, and
`gateway.completion_result_from_usage`/`_cost_and_source_for_usage` picks whichever one a given
response actually set before ever falling back to the token path — see there for the exact
precedence (a real provider-reported charge still wins over everything, same as elsewhere).

Cost follows the same real-unit logic, in `pricing.py`'s `CONFIGURED_DURATION_PRICING` /
`CONFIGURED_CHARACTER_PRICING` tables (parallel to the token table, same "never fabricate" rule):
`whisper-1` ($0.006/minute) and `tts-1` ($15/1M characters) are registered — both stable,
long-standing, verified rates — so those get a real `cost_source: "configured"` value. Anything
unregistered (`gpt-4o-transcribe`'s token rate, `tts-1-hd`, `gpt-4o-mini-tts`, ...) honestly reports
`"unknown"` rather than a guess, exactly like the token table already does. TTS's response carries
no usage information at all (it's pure audio bytes, nothing else) — its character count comes from
counting the request's own `input` field, not from anything the provider sent back; that's
recording a real, exact quantity, not fabricating one.

One more consistency guard worth naming: the model pricing registry (a workspace's own price
overrides) is token-rate only — `input_per_1m`/`output_per_1m`, no duration/character equivalent
yet. `gateway.record_usage` explicitly skips applying a workspace override to any row that set
`duration_seconds` or `characters`, specifically because a token-rate override applied to a row
whose token counts are always 0 would silently compute a wrong near-zero cost — worse than the
honest built-in duration/character rate that row should keep using instead. Extending the registry
itself to cover non-token billing is real future work, not something this phase forces in.

## Reliability: connection pooling, circuit breaker, atomic rate limiting

Phase 4 (production reliability, started after Phase 3's provider-feature surface was judged
essentially complete).

**Connection pooling.** `app/providers.py`'s `send_request`/`send_request_binary`/`send_multipart`/
`stream_request`/`check_key`/`check_liveness` — the one chokepoint every adapter and the legacy
`call_provider`/`stream_openai_compatible` path funnels through — used to each construct their own
`httpx.Client`/call `httpx.post` directly: a fresh TCP+TLS handshake per outbound call, even to the
same provider host repeatedly. They now share one process-lifetime `httpx.Client`
(`providers.get_client()`, closed from `main.py`'s `lifespan` shutdown via
`providers.close_client()`), so keep-alive connection reuse actually applies across calls, not just
within one.

**Circuit breaker.** `providers.breaker_allows`/`breaker_record_success`/`breaker_record_failure`
track consecutive failures per provider (`_BREAKER_THRESHOLD = 5`); once tripped, the breaker opens
for `_BREAKER_COOLDOWN_SECONDS = 30`, and `gateway.require_live_ready` fails fast with `503
provider_unavailable` instead of attempting (and paying the full timeout for) a call that's likely
to fail again. Only an "upstream fault" counts against the breaker — a transport failure (never
reached the provider) or the provider's own 5xx — reusing the exact same distinction the H1 error-
passthrough work already draws at every call site; a 4xx (bad request, bad key, rate limit — this
request's fault, not the provider being down) never counts. A success resets the count; after the
cooldown, one trial call is let through (half-open) and either closes the breaker again or reopens
it. Observable via `GET /api/providers` (`breaker_open`/`breaker_failures` per provider). Still
process-local state — correct for today's single-instance deployment, not yet shared across
multiple instances (see the rate limiter below for what that migration looks like when it's this
one's turn).

**Atomic, distributed rate limiting (`app/ratelimit.py`).** The audit's H2. Three previously
separate in-process `dict[key, deque[float]]` sliding-window logs — signups/hour per IP
(`routers/auth.py`), workspace joins/hour per IP (`routers/workspace.py`), and Playground/proxy
requests/hour per workspace (`gateway.enforce_workspace_quota`'s rate-limit half) — are now one
shared module backed by Redis, atomic via a Lua script (`EVAL`): `ZREMRANGEBYSCORE` to evict hits
older than the window, `ZCARD` to count what's left, and a conditional `ZADD` — all inside one
script, so nothing else can execute between the read and the write. That closes a real race the
prior implementation had once traffic is ever split across more than one process (today's single
`uvicorn`, no `--workers` deployment doesn't hit it, in the same way the circuit breaker above
doesn't yet either — this is the first of that class of state to actually make the move). It's a
genuine sliding-window log, not a fixed/bucketed counter, so it can't be gamed by a burst
straddling a window boundary — same semantics as the prior deque implementation, just made atomic
and shared. Every call site passes its own fully-qualified, isolated key (`"signup:1.2.3.4"`,
`"join:1.2.3.4"`, `"playground:workspace:42"`) — one Redis sorted set per identity, no cross-tenant
aggregation.

This module is deliberately **not** a general-purpose "limiter" merged with spend control. A rate
limit answers "how many requests can this identity make in a window" (abuse/DoS protection); a
budget answers "how much money can this key/workspace spend." `gateway.enforce_budget` (a per-key
`$` cap) and `gateway.enforce_workspace_cap` (a per-workspace-per-provider `$` cap) stay exactly as
they are — Postgres-backed, SUM-based, already durable and already correct regardless of Redis —
and `enforce_workspace_quota`'s *other* half (`MAX_USAGE_ROWS_PER_WORKSPACE`, a permanent all-time
row-count cap, no time window at all) stays a Postgres `COUNT` too. None of the three dollar/count
concepts moved; only the actual request-rate checks did.

**The failure-mode decision this module exists to make explicit**, rather than leaving implicit:
Redis unreachable → **fail open, with the exact prior in-process sliding-window log engaged as a
same-shape fallback** (never "skip the check entirely", and never fail closed). The reasoning:
these three limiters protect against abuse, not against uncontrolled spend — spend is entirely
Postgres-backed and completely unaffected by Redis's availability, so a Redis outage can *never*
let a workspace spend past its cap. That makes fail-open the safe choice here; it would not be if
this module gated spend. Fail-closed would instead turn an optional scaling dependency into a hard
availability dependency for signup / workspace-join / the Playground — a worse outage than the one
being guarded against. The fallback engaging is logged (rate-limited to one warning per 30s so a
sustained outage doesn't spam logs), and a short backoff (`_REDIS_RETRY_COOLDOWN_SECONDS = 5`) keeps
a bad Redis from being re-attempted on every single call — worth calling out concretely: a DNS-level
failure (an unresolvable host) isn't bounded by the client's own socket-connect timeout the way a
refused-connection is (measured at ~2s in this environment vs. the configured 200ms), so without the
backoff, every request during that kind of outage would individually pay that penalty rather than
falling back instantly after the first one discovers it.

`REDIS_URL` is empty by default, which routes every check straight to the in-process fallback with
no connection attempted at all — i.e. deploying this code with no Redis configured is a behavioral
no-op, identical to the pre-migration implementation. `docker-compose.yml` runs a local `redis:7-
alpine` service for development; production needs `REDIS_URL` pointing at a real (or
Render-managed Key Value) instance to actually get the distributed, atomic behavior instead of the
single-instance fallback.

## Idempotency (`app/idempotency.py`)

A client sends `Idempotency-Key: <token>` on a billable POST. The gateway remembers, **per virtual
key**, the (key → completed response) mapping, so a retried request replays the stored response
instead of calling — and re-billing — the provider again. Every non-streaming billable endpoint
supports it: `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/embeddings`,
`/v1/images/generations`, `/v1/audio/transcriptions`, `/v1/audio/speech`, Gemini's
`generateContent` / `embedContent` / `batchEmbedContents`, and the Playground's `/v1/proxy/chat`.
No header ⇒ behavior is exactly as before (opt-in per request).

**Postgres, not Redis — and fail *closed*.** This is spend protection, the opposite of the rate
limiter's fail-open Redis. The claim is durable, is written in the same Postgres the `usage_logs`
row goes to, and elects a single leader via `UNIQUE(key_id, idempotency_key)` (`ON CONFLICT DO
NOTHING`). Redis would be the wrong tool: the provisioned Key Value has persistence off and the
limiter deliberately fails *open* — both fine for abuse throttling, both wrong for "don't charge
twice."

**Claim placement** (why it isn't just "first thing in the request"): after authenticating the key
and authorizing provider/model (which also defines the request's fingerprint), a **read** checks for
a stored result *before* the quota/budget/cap gates — a free replay must not be blocked by a
since-exhausted budget. The **write** (the claim) happens *after* all those gates, immediately
before the provider call — so a request rejected by governance never leaves a claim that would block
a genuine later retry. Two identical requests both pass governance cheaply (DB reads), then race the
insert; one reaches the provider, the other gets `409`.

**Fingerprint.** SHA-256 over endpoint + provider + model + canonical body (multipart audio also
hashes the raw file bytes). Same key + a *different* body ⇒ `422`; only a hash is stored, never the
raw request.

**Response body is encrypted at rest** (Fernet, same key infrastructure as provider creds) and
stored only up to `IDEMPOTENCY_MAX_REPLAY_BYTES`. A larger response is recorded terminal-but-**not**
replayable (`replayable=false`, body `NULL`): the key still can't drive a second billable call, but
a retry gets an explicit `409 idempotency_not_replayable` rather than a silently-wrong empty body.

**Failure semantics** (a transient failure must never poison a key): a deterministic provider `4xx`
is cached terminal and replayed; a transient `429`/`5xx`/transport failure **releases** the claim so
a genuine retry can run. A claim stuck `in_progress` past `IDEMPOTENCY_INFLIGHT_TIMEOUT_SECONDS`
(e.g. a crashed leader) is reclaimed by the next request; expired rows are swept opportunistically
and at startup.

**Streaming is a concurrency guard only** (no replay): a second identical stream while one is in
flight gets `409`; completed streams are never buffered or replayed. The lock is released when the
stream ends.

**The one window it can't fully close:** gateway-side idempotency closes the *client → gateway*
retry window completely. It cannot by itself resolve an ambiguous *gateway → provider* **transport**
failure — when no response comes back, the gateway can't know whether the provider billed, so it
releases and allows a retry, accepting that a retry could double-charge in that one narrow case.
Forwarding the key upstream to providers that honor it (unverified for Anthropic/Gemini) is a
deliberately deferred later slice.

## What's not proxied (and why)

- **OpenAI Realtime / a future Gemini Live API** — WebSocket, not request/response. The whole
  governance funnel (budget check → call → one `usage_logs` row) assumes one HTTP request is one
  billable unit; a persistent socket has no such boundary.
- **OpenAI Files / Batches / (deprecated) Assistants, Anthropic's Files API** — multipart
  upload + reference-by-id + poll/webhook lifecycles are a different protocol shape than
  synchronous chat, and imply tracking an object that outlives any single request — no such
  concept exists in the schema today.
- **OpenAI image edits/variations** — unlike generation, these take a file upload
  (`multipart/form-data`), a genuinely different request shape than every other endpoint here (all
  JSON bodies) — deliberately out of scope for now; generation (`/v1/images/generations`, text ->
  image) is proxied.
- **Audio translations** (`/v1/audio/translations`) — same request/response shape as
  transcription, always outputs English; not added this pass (transcription and TTS cover the
  named scope; translations are a cheap, natural follow-up).
- **A handful of transcription's rarer fields** (`timestamp_granularities`,
  `chunking_strategy`, `keywords`, speaker diarization) — the transcription route is deliberately
  a sync route with named `Form(...)` fields (`model`, `language`, `prompt`, `response_format`,
  `temperature`), not a fully generic multipart pass-through (which would need `async def` +
  `await request.form()`, a shape no other route here uses). This is a scope choice, not a
  concurrency workaround: every sync route already runs off FastAPI/Starlette's event loop, in
  AnyIO's worker threadpool (default cap 40 threads per process) — it was never at risk of
  stalling the event loop. The real, pre-existing constraint a long-running sync route shares with
  every other endpoint here is threadpool + DB-connection-pool exhaustion under enough concurrent
  slow requests (SQLAlchemy's default pool is 5 + 10 overflow, held for a request's full
  lifecycle); Audio's ~sync multipart handling doesn't introduce that exposure, it just continues
  it. Documented, not silently dropped.
- **Anthropic embeddings** — Anthropic has no embeddings API of its own; their docs point
  integrators at a third party (Voyage AI). Nothing to proxy.
- **Gemini's Interactions API, and its stateful/background modes in particular** (`store:true`
  server-side history, `background:true` async execution) — the gateway targets the simpler,
  stateless `generateContent`/`streamGenerateContent` surface (Google's own recommendation for
  stable integrations, and what its official SDKs default to). The Interactions API's stateful
  mode raises a real question — does a workspace consent to a provider retaining conversation
  state server-side? — that needs an explicit answer before it's wired in, not a silent default.
