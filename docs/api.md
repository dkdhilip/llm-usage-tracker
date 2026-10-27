# API

Auth = a valid session cookie (`POST /api/auth/{signup,login}`). "member" = any user in a
workspace; "admin" = the Workspace Admin. Endpoints marked *member* also need workspace
membership (`403` if signed in but not in one).

**CSRF.** The browser UI authenticates with a session cookie, so every *unsafe* request
(`POST`/`PUT`/`PATCH`/`DELETE`) under `/api/*` must also carry an `X-CSRF-Token` header equal to the
`csrf_token` cookie the server sets at signup/login (and re-issues on `GET /api/auth/me`); a missing
or wrong token is `403`. The token is an HMAC of the session cookie, so it is bound to that one
session. `GET`s, `/api/auth/login` + `/signup` (no session yet), and the whole virtual-key API
(`/v1/*`, `/v1beta/*` — header-authenticated, never cookie-authenticated) are not subject to it.
`SameSite=Lax` and `HttpOnly` on the session cookie are unchanged; `csrf_token` is intentionally
script-readable (the SPA echoes it) but is otherwise `Lax`/`Secure` like the session cookie.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/healthz` | — | health / warmup (`{status, version}`) |
| GET | `/api/models` | — | the models on offer with their current price per provider/model, plus `status` (`active`, `preview` or `deprecated`; deprecated ones also carry `shutdown_date` and `replacement`). Retired models stay priced for old usage but are not listed |
| POST | `/api/auth/signup` `\|` `/login` | — | `{username, password}` → `httpOnly` session cookie, `{authenticated, user:{id, username, workspace:{id,name,role}|null}}` |
| POST `\|` GET | `/api/auth/logout` `\|` `/me` | — | clear the cookie / current principal |
| GET `\|` DELETE | `/api/account` | user | `{username, workspace, live_cap_default_usd}` / delete my account (`400` if I'm the sole admin of a non-empty workspace) |
| GET | `/api/workspace` | member | admin: `{id, name, role, members[], invites[], providers[]}`; member: `{id, name, role}` |
| POST `\|` PATCH `\|` DELETE | `/api/workspace` | user / admin | create (`{name}`, `409` if already in one) / rename / delete (`409` unless no other members; cascades keys, usage, credentials, invites) |
| POST | `/api/workspace/join` | user | `{code}` → join as a Team Member. `404` invalid/expired, `409` used/already in a workspace, `429` throttled |
| POST | `/api/workspace/leave` | member | leave (Team Member only) — unassigns your keys |
| POST `\|` DELETE | `/api/workspace/invites[/{id}]` | admin | mint a single-use code (`{label?}` → `{code}`, shown once) / revoke an open one |
| DELETE | `/api/workspace/members/{user_id}` | admin | remove a Team Member — their keys are unassigned, their session loses access |
| GET | `/api/workspace/providers` | admin | `[{provider, configured, source(env\|workspace\|none), last4, monthly_cap_usd, spend_this_month}]` |
| PUT `\|` DELETE | `/api/workspace/providers/{provider}/key` | admin | attach / clear the workspace's encrypted provider key. `409` if a server env var is set |
| PATCH | `/api/workspace/providers/{provider}/cap` | admin | `{monthly_cap_usd}` (`null` → the default). `404` unless a key is attached |
| GET `\|` PUT | `/api/workspace/pricing` | admin | list this workspace's price overrides / upsert one `{provider, model, input_per_1m, output_per_1m}` → `409` past `MAX_MODEL_PRICING_PER_WORKSPACE` |
| DELETE | `/api/workspace/pricing/{id}` | admin | remove an override — `404` if it isn't this workspace's |
| GET | `/api/providers` | admin | `[{provider, env_var, configured_via_env}]` — instance-wide env-var status only |
| GET | `/api/integration?target=hosted\|local` | member | copy-ready, per-provider setup (URLs, env vars, code) for OpenAI / Anthropic / Gemini — placeholder `vk_...` only, never a key |
| POST | `/api/keys` | admin | `{label, allowed_providers[], allow_live?, default_provider?, assigned_user_id?, monthly_budget_usd?, budget_period?(day\|week\|month\|custom), budget_start?, budget_end?, expires_at?, allowed_models?{provider:[model]}, content_logging_enabled?, image_logging_enabled?}` (both logging switches default `false`) → raw key once |
| GET | `/api/keys` | member | admin → every key in the workspace (+ `assigned_username`); member → only keys assigned to them |
| PATCH `\|` DELETE | `/api/keys/{id}` | admin | patch (budget, `allow_live`, `assigned_user_id`/`clear_assignment`, `content_logging_enabled`, `image_logging_enabled`) / revoke |
| GET | `/api/requests` | admin | recent request log (`?limit&cursor&provider&model&key_id&status&start&end`); rows carry `has_content` |
| GET | `/api/requests/{id}/content` | admin | the stored prompt/response of one request (`content_status`: `available` / `expired` / `not_captured` / `unreadable`); `Cache-Control: no-store`; another workspace's id is a 404 |
| PATCH | `/api/workspace/content-logging` | admin | `{enabled}` — turn prompt/response logging on/off for the workspace (default off) |
| DELETE | `/api/workspace/content` | admin | delete all stored prompt/response content **and images** of the workspace now (usage analytics untouched) |
| PATCH | `/api/workspace/image-logging` | admin | `{enabled}` - turn image storage on/off (separate from text logging, default off) |
| GET | `/api/requests/{id}/images/{image_id}` | admin | the bytes of one stored image (type sniffed at store time, `nosniff`, `no-store`, sandbox CSP); another workspace's or an expired image is a 404. Request/list responses carry image metadata only |
| GET | `/api/usage/summary` `\|` `/timeseries` `\|` `/by-key` `\|` `/by-model` | member | dashboard aggregates (`start,end,provider,model,key_id`); admin → whole workspace, member → assigned keys. `summary` adds `latency_p50_ms`, `latency_p95_ms`, `error_rate`, `tokens_per_sec` |
| **POST** | **`/v1/chat/completions`** | Bearer `vk_…` | **OpenAI-compatible.** `{model:"<provider>/<slug>", messages[], stream?}`. For `openai`/`openrouter`: full-fidelity passthrough (tools, tool_choice, response_format, multimodal content — the real provider response, untouched). For `anthropic`/`gemini`: legacy translation (flattened prompt, gateway-built envelope). `402` over budget/cap or no provider key, `403` paused / provider or model not on key, `502` upstream failure. |
| **POST** | **`/v1/messages`** | Bearer `vk_…` | **Anthropic Messages passthrough** (`anthropic` only). `{model, max_tokens, messages[], system?, tools?, stream?, ...}` forwarded almost verbatim → the real Anthropic response. `max_tokens` is required by Anthropic itself — the gateway no longer defaults it. |
| **POST** | **`/v1/responses`** | Bearer `vk_…` | **OpenAI Responses API passthrough** (`openai` only). `{model, input, tools?, stream?, ...}` forwarded almost verbatim → the real OpenAI response. |
| **POST** | **`/v1beta/models/{model}:generateContent`** | `x-goog-api-key: vk_…` | **Gemini native passthrough** (`gemini` only). `{contents[], systemInstruction?, generationConfig?, tools?, toolConfig?, ...}` forwarded almost verbatim → the real Gemini response. `model` comes from the URL path, matching Gemini's own REST shape. |
| **POST** | **`/v1beta/models/{model}:streamGenerateContent`** | `x-goog-api-key: vk_…` | Same, real `alt=sse` streaming passthrough. |
| **POST** | **`/v1/embeddings`** | Bearer `vk_…` | **OpenAI Embeddings passthrough** (`openai` only). `{model, input, dimensions?, encoding_format?, ...}` forwarded almost verbatim → the real OpenAI response. No streaming — the API doesn't support it. |
| **POST** | **`/v1beta/models/{model}:embedContent`** | `x-goog-api-key: vk_…` | **Gemini Embeddings passthrough** (`gemini` only). `{content, taskType?, outputDimensionality?, ...}` forwarded almost verbatim. |
| **POST** | **`/v1beta/models/{model}:batchEmbedContents`** | `x-goog-api-key: vk_…` | Same, batched: `{requests: [{content, ...}, ...]}` → embeds every entry in one call. |
| **POST** | **`/v1/images/generations`** | Bearer `vk_…` | **OpenAI Images passthrough** (`openai` only). `{model, prompt, size?, quality?, n?, ...}` forwarded almost verbatim → the real OpenAI response. Generation only — edits/variations (multipart file upload) aren't proxied, see [What's not proxied](architecture.md#whats-not-proxied-and-why). No streaming. |
| **POST** | **`/v1/audio/transcriptions`** | Bearer `vk_…` | **OpenAI transcription passthrough** (`openai` only). `multipart/form-data`: `file` + `model` (required), `language?`/`prompt?`/`response_format?`/`temperature?` forwarded almost verbatim → the real OpenAI response (JSON, or plain text/srt/vtt if requested). A handful of rarer fields aren't forwarded this pass — see [What's not proxied](architecture.md#whats-not-proxied-and-why). |
| **POST** | **`/v1/audio/speech`** | Bearer `vk_…` | **OpenAI TTS passthrough** (`openai` only). `{model, input, voice, response_format?, speed?, ...}` forwarded almost verbatim → the real OpenAI response, which is raw audio bytes, not JSON. |
| GET | `/v1/proxy/inspect` | Bearer `vk_…` | this key's allowed providers + `{provider, ready}` (ready = a workspace key exists) |
| POST | `/v1/proxy/chat` | Bearer `vk_…` | friendly shape used by the Playground: `{provider, model, prompt}` → completion + usage |

The proxy (`/v1/*`, `/v1beta/*`) requires a `vk_…` key and is workspace-agnostic — the key itself
is the credential, accepted in whichever header a provider's own SDK sends it in by default
(`Authorization: Bearer`, `x-api-key`, or `x-goog-api-key` — all three resolve the same key).
`/v1/messages`, `/v1/responses`, `/v1/embeddings`, `/v1/images/generations`,
`/v1/audio/transcriptions`, `/v1/audio/speech`, and the Gemini native endpoints validate only
`model` server-side; everything else in the request body is the client's own JSON (or multipart
form, for transcription), sent upstream unmodified — the real `anthropic` / `openai` /
`google-genai` SDKs work by pointing `base_url` at the gateway with no other code change (see
[Example integrations](#example-integrations) below).
Anthropic has no embeddings or image-generation API of its own (their docs point integrators at a
third party) — there's nothing to proxy there. Gemini's image generation needs no endpoint of its
own — point it at `/v1beta/models/{image-capable-model}:generateContent` with
`generationConfig.responseModalities` set, exactly like any other `generateContent` call; the
gateway never inspects the response beyond pulling out token counts for logging, so an inline
image part rides through exactly like an inline text part always has.

## Connect an app (developer setup)

**OpenAI — the standard approach is environment-based.** A project that already uses the official OpenAI
SDK switches to the gateway by editing its `.env`, with no change to its model-calling code:

```env
OPENAI_API_KEY=vk_your_virtual_key                                      # REPLACES your existing OPENAI_API_KEY
OPENAI_BASE_URL=https://llm-usage-tracker-97q0.onrender.com/v1          # NEW; local: http://127.0.0.1:8000/v1
```

```python
from openai import OpenAI
client = OpenAI()   # unchanged: reads OPENAI_API_KEY and OPENAI_BASE_URL
```

Things to know:

1. **Both variables are required.** A virtual key alone does not redirect anything; `OPENAI_BASE_URL` is what
   points the SDK at the gateway, and it ends in `/v1` (hosted or local).
2. **The SDK never reads `.env` itself.** Your application (or framework) must load it — for example
   `python-dotenv`'s `load_dotenv()` — or the variables must already be in the process environment (shell,
   container, CI).
3. **Real environment variables win over `.env`** (the usual convention). Use `.env` for local development; in
   Docker, CI and production set `OPENAI_API_KEY` and `OPENAI_BASE_URL` in the platform and do not ship a `.env`
   file.
4. **The dashboard's snippet validates before it builds the client:** `OPENAI_API_KEY` must start with `vk_` and
   `OPENAI_BASE_URL` must be set, otherwise it raises a clear error (never showing the key) before any request is
   made. That catches a real `sk-…` key exported in your shell and a missing base URL, which would otherwise send
   your virtual key to `api.openai.com`. The standard `OpenAI()` client cannot do this by itself, so if you load
   `.env` your own way, keep an equivalent check.
5. **Prefer to configure the client in code?** The explicit variant passes `api_key=` / `base_url=` after the same
   checks; arguments passed in code take precedence over the environment.
6. **Model names.** A bare name such as `gpt-4o-mini` works only if the virtual key has a default provider (the
   `default_provider` field of the key API, set to `openai`). A key created from the dashboard has none, so use
   `openai/gpt-4o-mini`; otherwise the gateway answers `422` before any provider is contacted.

A **virtual key does not redirect an SDK by itself**: the application must be pointed at the gateway
(environment variables, a client option, or a shared helper). Pick the form for your SDK — they differ,
and the wrong one double-prefixes the path (measured against the official SDKs):

| SDK | Key variable | Base-URL variable | Base URL to use | Endpoint it hits |
|---|---|---|---|---|
| OpenAI (`openai`) | `OPENAI_API_KEY` | `OPENAI_BASE_URL` | gateway root **+ `/v1`** | `POST /v1/chat/completions` |
| Anthropic (`anthropic`) | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` | the gateway **root** (no `/v1` — the SDK adds `/v1/messages`) | `POST /v1/messages` |
| Gemini (`google-genai`) | `GEMINI_API_KEY` | `GOOGLE_GEMINI_BASE_URL` | the gateway **root** (no `/v1beta`) | `POST /v1beta/models/<model>:generateContent` |

Hosted gateway root: `https://llm-usage-tracker-97q0.onrender.com` (OpenAI base URL: `…/v1`); local:
`http://127.0.0.1:8000`. The dashboard's **Workspace → Create a virtual key** shows these, with copy-ready
code, right after a key is created, and **Connect** on any live key row reopens them with a readiness
checklist (provider enabled, live on, workspace credential present, not expired). Snippets only ever contain
the placeholder `vk_...` — a key is shown once and never stored.

Never put a real provider key in an application — real credentials belong in the gateway workspace. Mind
the ambient environment (all measured): a real `OPENAI_API_KEY` already set on a machine beats a `.env`; a
bare `load_dotenv(override=True)` walks up parent directories and can load an unrelated parent `.env`; a
missing base URL makes an SDK fall back to the provider's own host (sending your virtual key there); and in
the Gemini SDK `GOOGLE_API_KEY` silently overrides `GEMINI_API_KEY`. The dashboard's snippets therefore load only the project's own `.env`. The Anthropic and Gemini snippets let
that `.env` win, pass the key and base URL explicitly, and raise an error if either is missing. The OpenAI
snippets (standard and explicit) let real environment variables win and refuse a key that does not start with
`vk_` or a missing base URL, as described above. The shared helper in [`examples/gateway-sdks/`](../examples/gateway-sdks/README.md) does the same:
one `LLM_GATEWAY_KEY` in the project's `.env`, rotated by editing that one line, with `LLM_GATEWAY_URL` to
switch between local and hosted. Tested SDK minimums: `openai` 3.29.0, `anthropic` 1.13.0, `google-genai`
2.30.0, `python-dotenv` 1.2.3.

## Example integrations

```python
# OpenAI SDK — Chat Completions or Responses, full fidelity (tools, streaming, etc.)
from openai import OpenAI
client = OpenAI(base_url="https://<host>/v1", api_key="vk_...")
client.chat.completions.create(model="openai/gpt-4o-mini", messages=[...], tools=[...])
client.responses.create(model="gpt-4o-mini", input="...", tools=[...])
client.embeddings.create(model="text-embedding-3-small", input="hello")
client.images.generate(model="gpt-image-1", prompt="a red bicycle", size="1024x1024")
client.audio.speech.create(model="tts-1", voice="alloy", input="hello")
client.audio.transcriptions.create(model="whisper-1", file=open("clip.mp3", "rb"))

# Anthropic SDK — native Messages API
from anthropic import Anthropic
client = Anthropic(base_url="https://<host>", api_key="vk_...")
client.messages.create(model="claude-3-5-sonnet-20241022", max_tokens=1024, messages=[...])

# Google GenAI SDK — native generateContent (text, image gen, embeddings)
from google import genai
client = genai.Client(api_key="vk_...", http_options={"base_url": "https://<host>"})
client.models.generate_content(model="gemini-3.8-flash", contents="hi")
client.models.generate_content(  # image generation — same method, an image-capable model
    model="gemini-2.5-flash-image", contents="a red bicycle",
    config={"response_modalities": ["IMAGE"]},
)
client.models.generate_content(  # native audio output — same again, an audio-capable model
    model="gemini-2.5-flash-preview-tts", contents="say hello",
    config={"response_modalities": ["AUDIO"]},
)
client.models.embed_content(model="gemini-embedding-001", contents="hi")

# LangChain — point it at the gateway like any OpenAI-compatible endpoint
from langchain_openai import ChatOpenAI
llm = ChatOpenAI(base_url="https://<host>/v1", api_key="vk_...", model="openai/gpt-4o-mini")
```

The gateway never executes tool/function calls — it only proxies the LLM turn. A LangGraph/
LangChain agent (or any framework) keeps running its own tools locally and sends the result back
as the next request; the gateway just re-authorizes, re-budgets, and forwards each turn.
