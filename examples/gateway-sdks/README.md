# Use the gateway from OpenAI, Anthropic or Gemini code

For **development and testing environments**. A manager issues you a virtual key (`vk_…`) in the LLM Usage
Tracker dashboard; you point your app at the gateway once; from then on, replacing a key is a one-line edit
and every request shows up centrally in the dashboard.

> **A virtual key does not redirect an SDK by itself.** Your application must be told the gateway URL —
> through environment variables, a client option, or the shared helper below. Nothing here intercepts
> traffic or silently reroutes requests.
>
> **Never put a real provider key (OpenAI / Anthropic / Google) in an application.** Real credentials live in
> the gateway workspace; applications only ever hold a virtual key.

## Quick start (the shared helper)

```bash
pip install -r requirements.txt           # or just the SDK(s) you use + python-dotenv (see SDK versions)
cp .env.example .env                      # git-ignored — put your virtual key in it
python check_connection.py                # authenticates + shows readiness; makes NO provider call (free)
python openai_example.py                  # or anthropic_example.py / gemini_example.py
```

`.env` (the whole configuration):

```bash
LLM_GATEWAY_KEY=vk_...your-virtual-key...
# LLM_GATEWAY_URL=http://127.0.0.1:8000     # optional — omit to use the hosted gateway
```

```python
from gateway_client import openai_client, anthropic_client, gemini_client

client = openai_client()      # likewise anthropic_client() / gemini_client()
```

[`gateway_client.py`](gateway_client.py) is one file — copy it into any project. It holds the gateway URL in
one place (default: the hosted gateway), applies each SDK's different URL form, and passes the key and URL
to the SDK **explicitly**, so a real provider key already set on your machine can never override the virtual
key or be sent to the gateway. No machine-wide variable is needed.

- **Rotate a key:** edit `LLM_GATEWAY_KEY` in `.env`. Nothing else changes.
- **Switch local ↔ hosted:** set or remove `LLM_GATEWAY_URL` in `.env`. No code changes.
- Running from another directory? The helper reads `.env` from the directory you run in (never a parent's);
  real environment variables take precedence over the file, so CI can inject the key.

## Without the helper: each SDK's own variables

The URL form **differs per SDK**. The wrong form double-prefixes the path (measured):

| | OpenAI | Anthropic | Gemini |
|---|---|---|---|
| Package | `openai` | `anthropic` | `google-genai` |
| Key variable | `OPENAI_API_KEY` | `ANTHROPIC_API_KEY` | `GEMINI_API_KEY` |
| Base-URL variable | `OPENAI_BASE_URL` | `ANTHROPIC_BASE_URL` | `GOOGLE_GEMINI_BASE_URL` |
| Base URL | gateway root **+ `/v1`** | gateway **root** | gateway **root** |
| Hosted example | `https://llm-usage-tracker-97q0.onrender.com/v1` | `https://llm-usage-tracker-97q0.onrender.com` | `https://llm-usage-tracker-97q0.onrender.com` |
| Local example | `http://127.0.0.1:8000/v1` | `http://127.0.0.1:8000` | `http://127.0.0.1:8000` |
| SDK appends | `/chat/completions` | `/v1/messages` | `/v1beta/models/<model>:generateContent` |
| Key sent as | `Authorization: Bearer` | `x-api-key` | `x-goog-api-key` |
| If you add the wrong suffix | — | `/v1` → posts to `/v1/v1/messages` (404) | `/v1beta` → posts to `/v1beta/v1beta/…` (404) |

Copy-ready, runnable snippets for each (also shown in the dashboard after you create a key). Each one reads
only **this project's** `.env` (the current directory's — never a parent's), lets it win over variables
already set on your machine, passes the key **and** base URL to the SDK explicitly, and **stops with an
error if either is missing** — it never lets the SDK fall back to the provider's own host, which would send
your virtual key there. Run them from the project directory.

```python
# OpenAI — .env: OPENAI_API_KEY=vk_...  OPENAI_BASE_URL=https://<gateway>/v1
import os
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv(Path.cwd() / ".env", override=True)
missing = [n for n in ("OPENAI_API_KEY", "OPENAI_BASE_URL") if not os.environ.get(n)]
if missing:
    raise RuntimeError(f"Missing {', '.join(missing)} - add it to .env (step 2) and run from this project's directory.")

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"], base_url=os.environ["OPENAI_BASE_URL"])
r = client.chat.completions.create(model="openai/gpt-4o-mini", messages=[{"role": "user", "content": "hi"}], max_tokens=20)
print(r.choices[0].message.content)
```

```python
# Anthropic — .env: ANTHROPIC_API_KEY=vk_...  ANTHROPIC_BASE_URL=https://<gateway>     (no /v1)
import os
from pathlib import Path

import anthropic
from dotenv import load_dotenv

load_dotenv(Path.cwd() / ".env", override=True)
missing = [n for n in ("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL") if not os.environ.get(n)]
if missing:
    raise RuntimeError(f"Missing {', '.join(missing)} - add it to .env (step 2) and run from this project's directory.")

client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"], base_url=os.environ["ANTHROPIC_BASE_URL"])
m = client.messages.create(model="claude-haiku-4-5-20251001", max_tokens=64, messages=[{"role": "user", "content": "hi"}])
print(m.content[0].text)
```

```python
# Gemini — .env: GEMINI_API_KEY=vk_...  GOOGLE_GEMINI_BASE_URL=https://<gateway>     (no /v1beta)
import os
from pathlib import Path

from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv(Path.cwd() / ".env", override=True)
missing = [n for n in ("GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL") if not os.environ.get(n)]
if missing:
    raise RuntimeError(f"Missing {', '.join(missing)} - add it to .env (step 2) and run from this project's directory.")

# Key and base URL explicit: GOOGLE_API_KEY on your machine would otherwise win over GEMINI_API_KEY.
client = genai.Client(
    api_key=os.environ["GEMINI_API_KEY"],
    http_options=types.HttpOptions(base_url=os.environ["GOOGLE_GEMINI_BASE_URL"]),
)  # keep a reference to the client
print(client.models.generate_content(model="gemini-2.5-flash", contents="hi").text)
```

### Ambient-environment traps (measured)

A naive client — `OpenAI()`, `anthropic.Anthropic()`, `genai.Client()` with the standard variables — is
easy to misconfigure, which is why the snippets above are explicit:

- `python-dotenv` does **not** override variables that already exist: a real `OPENAI_API_KEY` in your shell
  beats the `.env`. A naive `OpenAI()` / `genai.Client()` with such variables set was shown to send the real
  key to the gateway. The snippets use `override=True` **and** pass the key explicitly.
- A bare `load_dotenv(override=True)` **walks up parent directories** and then overrides: with no `.env` in
  your project, a parent directory's `.env` (for example one holding real provider keys) is loaded over
  your environment. The snippets load `Path.cwd() / ".env"` only.
- If the base URL is missing, the SDK's default is the **provider's real host**, and your virtual key goes
  there. The snippets raise an error before building the client instead.
- In the Gemini SDK, `GOOGLE_API_KEY` **overrides** `GEMINI_API_KEY`: pass `api_key=` explicitly.

## SDK versions

The minimums in `requirements.txt` — `openai` 3.29.0, `anthropic` 1.13.0, `google-genai` 2.30.0,
`python-dotenv` 1.2.3 — are the versions everything here was run against. Older releases are **not
claimed to work**; they were not tested. The dashboard's install lines carry the same minimums.

## What must be true on the gateway side

For a request to succeed, **all** of these must hold (the dashboard's **Connect** panel checks the first
three per key):

1. The provider is **enabled for the virtual key**.
2. **Live calls are on** for the key (a paused key answers `403 key_paused`).
3. The workspace holds a **real credential** for that provider (otherwise `402 provider_not_configured`).
4. The **model is allowed** — a key may carry a model allow-list (`403 model_not_allowed` otherwise).
5. Budgets, caps and rate limits are not exhausted (`402`/`429`).

`python check_connection.py` verifies the key and shows, per provider, whether the workspace holds a
credential — **without any provider call**, so it is free. A revoked or unknown key answers `401`.

OpenAI model names: use `openai/<model>` with any key. A key with a single provider has it as its default
provider, so a bare name such as `gpt-4o-mini` works too (the dashboard sets this when you tick one provider).
Anthropic and Gemini names go as the provider defines them — the endpoint already implies the provider.

## See your usage

Dashboard → **Requests**: find the row by your key's **label**; it shows model, tokens, cost, latency and
status. For OpenAI and Anthropic the examples print an `id:` — the row's **Request ID** is the same value.
Gemini responses carry no id the gateway can reuse, so match those by key label and time.

Cost shows **"unknown"** (never a guessed number) for a model that is not priced. Of the example models,
`gpt-4o-mini` and `gemini-2.5-flash` are priced; `claude-haiku-4-5-20251001` is not — add its price under
**Workspace → Model pricing** to get a cost for it.

## What was verified, and how

| | |
|---|---|
| **Real SDKs, measured** | The request each official SDK actually sends — path, auth header, base-URL forms, which environment variables it reads, and the traps above — recorded from the installed packages: `openai` 3.29.0, `anthropic` 1.13.0, `google-genai` 2.30.0 |
| **Client contract** (`tests/`, 38 tests) | Each example run **unchanged** against a local stand-in: right route and header per SDK; pasted `/v1` / `/v1beta` suffixes corrected; ambient real keys never sent (mutation-checked); rotation and local↔hosted switching with no code change; `.env` handling; the key is never printed |
| **Real gateway, mocked provider** (`backend/tests/test_sdk_integrations.py`, 49 tests) | The dashboard's generated snippets run **verbatim** as separate processes, and the examples and helper, against the real gateway code on a real socket: correct upstream URL and credential per provider (the virtual key never goes upstream), usage and cost recorded, and per provider: not-enabled / paused / no-credential / disallowed-model → 403/403/402/403, revocation → 401. Also: a parent directory's `.env` can neither override nor stand in for the project's (with a control proving the old walk-up pattern would have), and a snippet with a missing base URL stops with an error and opens **no** connection (a local listener behind `HTTP(S)_PROXY` counts connections; a control shows a key-only SDK client does head for the provider's host) |
| **Snippet shape** (`backend/tests/test_integration_guide.py`, 38 tests; no SDKs needed) | Each snippet loads only `Path.cwd() / ".env"`, passes key and URL explicitly, raises before building the client when either is missing, and the install lines carry the tested minimums |
| **UI** (`frontend/`, 18 + 5 tests) | The guide, the readiness checklist (including an expired key), hosted/local switching (no stale snippets while loading or after a failure), copy, and the Workspace wiring — including that a newly created key starts the guide afresh and that the plaintext key appears exactly once on the page |

**Mocked vs real.** In every automated test the **provider's response is mocked**; the shared HTTP client is
replaced so that any call slipping past the mock fails loudly. No test contacts OpenAI, Anthropic or Google or
costs money. A real end-to-end test needs your credentials and spend; do it yourself with the quick start.

### Not verified

- **A successful request to a real provider** (needs credentials and cost), including whether the example
  model names are still served by the providers today.
- **Node/TypeScript, Java or other SDKs, and the older `google-generativeai` package** — nothing here ran them.
  The gateway routes are the same, but the environment-variable names and URL forms were only measured for the
  three Python SDKs above.
- **LangChain** is covered by the repo's separate e2e test (`backend/tests/test_e2e_langgraph.py`), which was
  not run for this change.
- Other SDK versions than those listed. The hosted gateway's own end-to-end behavior was not exercised by the
  automated tests (it is on a free plan, so the first request after a quiet period may be slow).

### Known gateway limitations that affect developers

(Found while testing the OpenAI path; none are changed here.)

- **Streaming without `stream_options={"include_usage": True}` records 0 tokens** for OpenAI chat
  completions, and a stream the client abandons mid-way leaves no usage row. The same streaming code serves
  the other providers, but only the OpenAI behavior was measured.
- **`client.models.list()` is not implemented.** On the hosted gateway it does not 404: the dashboard's
  catch-all answers `200` with HTML, and the OpenAI SDK crashes with an `AttributeError`.
- Gateway-originated errors are `{"detail": …}`, not the provider's `{"error": …}` shape, so an SDK
  exception's `.code`/`.type` are `None` for them (provider errors pass through unchanged).

## Run the tests

```bash
pip install -r requirements-dev.txt && pytest          # client-side contract tests; nothing leaves 127.0.0.1

# gateway-side tests (need the backend test setup: Postgres + Redis, see the root README)
docker compose cp examples backend:/examples
docker compose exec backend pip install openai anthropic google-genai python-dotenv
docker compose exec -e TEST_DATABASE_URL=postgresql+psycopg://llm:llm@db:5432/llmtracker_test \
                    -e TEST_REDIS_URL=redis://redis:6379/1 backend python -m pytest tests/test_sdk_integrations.py
```

Both suites skip cleanly when the SDKs or `examples/` are absent, so they never break the default backend suite.
