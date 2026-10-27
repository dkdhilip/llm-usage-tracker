# How it works

The concepts behind the gateway: workspaces and roles, virtual keys, passthrough endpoints, cost tracking and abuse controls.

**Workspaces.** A user **signs up** (username + password, scrypt-hashed), then either
**creates a Workspace** — becoming its **Workspace Admin** — or **joins one** with a
single-use invite code as a **Team Member**. A user belongs to one Workspace at a time.
Isolation is enforced server-side on every query: **a Workspace never reads another
Workspace's keys, usage, requests, members, or provider config.**

**Roles.**
- **Workspace Admin** — workspace-wide usage + request log, all virtual keys, create / revoke
  keys, budgets, assign keys to members, invite / remove members, manage the workspace's
  provider keys and spend caps.
- **Team Member** — a read-only Dashboard scoped to the virtual key(s) **assigned to them**.
  No request log, no Playground, no member list, no provider config, no other members' data.

**Real calls only — no simulator.** Every proxied request hits a real provider. A virtual key
that is paused (`403`), whose workspace has no key for the target provider (`402`), whose
provider/model isn't on its allow-list (`403`), or whose upstream call fails (`502`) returns an
error — never a fake response.

**Provider-native passthrough.** Alongside the OpenAI-compatible `/v1/chat/completions`, the
gateway exposes each provider's own API shape almost verbatim — `/v1/messages` (Anthropic
Messages: system prompt, content blocks, tool use, prompt caching), `/v1/responses` (OpenAI
Responses API), and `/v1beta/models/{model}:generateContent` /
`:streamGenerateContent` (Gemini: `contents`/`parts`, `systemInstruction`, function calling,
built-in tools, multimodal `inline_data`/`file_data`), `/v1/embeddings` /
`:embedContent` / `:batchEmbedContents` (OpenAI and Gemini embeddings — Anthropic has none of
its own), `/v1/images/generations` (OpenAI image generation — Gemini's image generation needs
no endpoint of its own, since it's just an image-capable model on the same `generateContent`),
and `/v1/audio/transcriptions` / `/v1/audio/speech` (OpenAI transcription and TTS — Gemini's
native audio output is, again, just an audio-capable model on `generateContent`, and it has no
dedicated transcription endpoint at all: audio understanding is multimodal input to that same
endpoint). Point the real `openai`/`anthropic`/`google-genai` SDK's `base_url` at the gateway
and it works unmodified: multi-turn history,
tools/function-calling, structured outputs, and multimodal content parts all ride through
untouched — the gateway validates only `model` and never reconstructs the request field-by-field.
Each SDK's own default auth header is honored (`Authorization: Bearer`, `x-api-key`, or
`x-goog-api-key` — all three accepted, same virtual key). Tool/function calls are **proxied, not
executed** — an agent framework (LangGraph, LangChain, ...) still runs its own tools and sends the
result back as the next call. `openai`/`openrouter` also get this full-fidelity treatment on
`/v1/chat/completions` itself; `anthropic`/`gemini` keep the original flattened-prompt
translation there for backward compatibility — use each provider's native endpoint
(`/v1/messages`, `/v1beta/models/{model}:generateContent`) for full fidelity.

**Per-key expiry and per-model allow-list**, alongside the existing per-provider ACL: a key can
carry an `expires_at` (checked the same way as `revoked_at` — an expired key gets the same
generic `401` as a nonexistent one, no state leak) and, per provider, an explicit model
allow-list (`allowed_models`) — empty means every model of that provider is allowed, the
pre-existing default.

**Model pricing registry.** The built-in price table (`backend/app/pricing.py`) lists the current models of
all four providers, with the date and source of each price noted beside it; retired models stay priced
but are not offered in the Playground. A workspace can still override a model's price through the API
(`GET/PUT /api/workspace/pricing`, `DELETE /api/workspace/pricing/{id}`; the Workspace page no longer has a card for it, since the catalog
covers the current models). An override takes precedence over the built-in/JSON
price table for that workspace's own cost calculations only (`cost_source: "workspace"`);
`gateway.record_usage` is the one place every request path resolves this, so it applies
uniformly across every endpoint. See [Model pricing registry](data-model.md#model-pricing-registry) below.

**Workspace live mode.** The Workspace Admin attaches the workspace's **own**
OpenAI/Anthropic/Gemini/OpenRouter key(s) (encrypted at rest, shown back only as `····last4`),
each with its **own monthly spend cap** (`LIVE_CAP_DEFAULT_USD` = $5 until set). The workspace's
virtual keys call real providers billed to that key, blocked once that provider's monthly spend
hits its cap. Each key has an **on/off** flag (`allow_live`) the admin toggles to pause billing
without revoking. The admin hands the raw `vk_…` strings to whoever needs them — **recipients
need no account**. A server env var for a provider configures it for every Workspace and always
wins over an attached key.

**Abuse controls:** `MAX_USERS`, signups & joins per IP/hour, per-workspace caps on keys /
members / open invites / stored usage rows / requests-per-hour, and the server-enforced
per-provider live-spend cap. No password reset yet.

**Cost**: for **OpenRouter** calls it's the provider's *actual* charge (`usage.cost`).
OpenAI/Anthropic/Gemini don't return a per-request cost, so those are **estimated** as
tokens × a hand-maintained price table (extensible at runtime via `MODEL_PRICING_OVERRIDES_PATH`
— no code deploy needed for a newly released model). When a model isn't registered *and* the
provider reports no charge, the row is honestly `cost_source = "unknown"` (`cost = NULL`) —
never a guessed number. Each row also keeps whatever extra usage detail the provider exposed
(cached/reasoning tokens, prompt-cache reads/writes, ...) verbatim in `usage_raw`.
