# LLM Usage Tracker

A **multi-tenant LLM gateway**: each organization gets an isolated **Workspace**, issues virtual
API keys with per-provider access control, sends requests through the proxy, and tracks token
usage and cost on a dashboard. OpenAI · Anthropic · OpenRouter · Google Gemini.

## What it does

- **Multi-tenant.** Each organization gets an isolated **Workspace** with a **Workspace Admin** and read-only
  **Team Members**. Isolation is enforced server-side on every query.
- **Virtual keys.** Issue `vk_...` keys with per-provider and per-model allow-lists, budgets, expiry, and
  assignment to a team member. Whoever holds a key needs no account.
- **Real calls only.** Every request hits a real provider. A paused key, a missing provider key, a model
  outside the allow-list or a failed upstream call returns an error, never a fake response.
- **Provider-native endpoints.** Besides the OpenAI-compatible `/v1/chat/completions`, the gateway proxies
  Anthropic Messages, the OpenAI Responses API, Gemini `generateContent`, embeddings, images and audio, so the
  official SDKs work by changing only the `base_url`.
- **Usage and cost.** Tokens, latency and cost per request, by provider, model and key. OpenRouter reports its
  actual charge; OpenAI, Anthropic and Gemini are estimated from a maintained price table, and a model without a
  price is recorded as "unknown", never a guessed number.
- **Opt-in logging.** Prompt/response and image logging is off by default, chosen per key, encrypted at rest and
  deleted after 30 days. Only workspace admins can read it.
- **Guard rails.** Per-key budgets, per-provider monthly spend caps, rate limits and signup limits.

## How it fits together

```
Browser → React (Dashboard — all; Requests · Playground · Workspace — admin only)
   or a real OpenAI / Anthropic SDK, or LangChain/LangGraph, pointed at the gateway
        → FastAPI gateway
            → session + workspace membership  →  role (admin | member)
            → virtual-key auth (+ expiry)  →  per-key provider + model ACL
            → per-key budget  →  workspace cap
            → real provider call, almost-verbatim passthrough   [JSON or SSE stream]
              (402 / 403 / 502 on failure)
        → PostgreSQL (workspaces, workspace_invites, users, virtual_keys, allowed_providers,
                      allowed_models, provider_credentials, usage_logs)
        → dashboard aggregates + request log, scoped to the workspace (member: to assigned keys)
```

## Use it from your code

Point any OpenAI SDK at the gateway:

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8000/v1", api_key="vk_...")
client.chat.completions.create(
    model="openrouter/meta-llama/llama-3.3-70b-instruct",   # <provider>/<slug>
    messages=[{"role": "user", "content": "hi"}],
    stream=True,   # SSE streaming supported
)
```

More setup, other SDKs and every endpoint: [docs/api.md](docs/api.md).

## Run locally

Requires Docker.

```bash
docker compose up --build
```

| Service   | URL                          |
|-----------|------------------------------|
| Frontend  | http://localhost:5173        |
| Backend   | http://localhost:8000        |
| API docs  | http://localhost:8000/docs   |
| Adminer   | `docker compose --profile tools up` → http://localhost:8080 (server `db`, user/pass `llm`) |

On first boot the backend creates the schema. First run:

1. **Create an account** at `/login`, then on **/welcome** choose **Create a workspace** — you
   become its Workspace Admin and land on an empty Dashboard.
2. On **Workspace**, attach a provider key (OpenRouter etc.), **create a virtual key** (allowed
   providers, optional budget, optionally *assign to* a Team Member), copy the `vk_…` string,
   open **Playground**, paste it, and send a request. It calls the real provider and shows on the
   workspace Dashboard and Requests. Without a provider key the request returns `402`.
3. **Invite a Team Member**: Workspace → *Generate invite* → send them the code. They sign up,
   pick **Join a workspace**, paste the code, and get a Dashboard scoped to the keys you assign
   them — nothing else.

Reset everything (wipes the DB):

```bash
docker compose down -v && docker compose up --build
```

More on tests and smoke checks: [docs/development.md](docs/development.md).

## Deploy

One Docker web service (FastAPI serves the built SPA) plus one managed Postgres. It runs on the Render and Neon
free tiers (expect a cold start after idle). Create a Neon project, point Render at this repo (it reads
`render.yaml`), set `DATABASE_URL`, deploy, then open `/healthz`. Full steps, keeping the service warm and drift
monitoring: [docs/deployment.md](docs/deployment.md).

## Configuration

| Variable | Purpose |
|---|---|
| `ENVIRONMENT` | Set to `production` on a deployed host. The app then refuses to start on the dev-default `SECRET_KEY` or without an `ENCRYPTION_KEY`. |
| `DATABASE_URL` | Postgres connection string. |
| `SECRET_KEY` | Signs sessions and hashes virtual keys. Must be overridden when deployed. |
| `ENCRYPTION_KEY` | Fernet key that encrypts stored provider keys and logged content. Required when deployed. |
| `REDIS_URL` | Optional. Distributed rate limiting; empty uses an in-process fallback. |

The full list, with defaults: [docs/configuration.md](docs/configuration.md).

## Documentation

| Topic | File |
|---|---|
| Concepts: workspaces, roles, keys, passthrough, cost | [docs/how-it-works.md](docs/how-it-works.md) |
| Running tests, E2E harness, smoke test | [docs/development.md](docs/development.md) |
| Deploying to Render + Neon | [docs/deployment.md](docs/deployment.md) |
| Environment variables | [docs/configuration.md](docs/configuration.md) |
| HTTP API, connecting an app, SDK examples | [docs/api.md](docs/api.md) |
| Database tables and the model price registry | [docs/data-model.md](docs/data-model.md) |
| Prompt, response, per-key and image logging | [docs/content-logging.md](docs/content-logging.md) |
| Adapters, billing units, reliability, idempotency | [docs/architecture.md](docs/architecture.md) |
| Future improvements | [docs/roadmap.md](docs/roadmap.md) |

## Stack

- **Frontend:** React + Vite + TypeScript + Tailwind + Recharts
- **Backend:** FastAPI + SQLAlchemy 2.0 (sync) + psycopg3
- **Database:** PostgreSQL 16
- **Deploy:** one Docker image plus one managed Postgres
- **CI:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs ruff, pytest (Postgres and Redis services),
  the SDK example tests, tsc + vitest + build and `docker build` on every push and pull request.
