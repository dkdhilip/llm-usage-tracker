# Development and testing

## Tests

```bash
cd backend && pip install -r requirements-dev.txt
# the provider-SDK tests skip without these; CI installs exactly these versions
pip install "openai==3.29.0" "anthropic==1.13.0" "google-genai==2.30.0" "python-dotenv==1.2.3"
TEST_DATABASE_URL=postgresql+psycopg://llm:llm@localhost:5432/llmtracker_test TEST_REDIS_URL=redis://localhost:6379/1 pytest -rs   # needs the compose db + redis up
ruff check app tests
pytest ../examples/gateway-sdks/tests

cd ../frontend && npm ci && npm run typecheck && npm test
```

The Redis-backed rate-limit tests (`tests/test_ratelimit.py`) run only when a Redis answers at `TEST_REDIS_URL` and
skip otherwise (`-rs` prints why). CI starts a Redis service and sets `REQUIRE_REDIS=1`, so there an unreachable
Redis **fails** the run instead of silently skipping those tests. `.github/workflows/ci.yml` runs all of the above
plus `docker build`.

## E2E agent harness

`tests/test_e2e_langgraph.py` proves the gateway works as the credential layer for a **real
multi-agent app**, not just a raw HTTP client: a genuine `langgraph.prebuilt.create_react_agent`,
driven by the real `langchain-openai` / `langchain-anthropic` / `langchain-google-genai` SDKs
pointed at the gateway via `base_url`, runs a real multi-turn tool-calling loop — the model
requests a tool call, the agent executes it **locally** (proving the gateway never runs a tool
itself), the result goes back as a follow-up turn, the model answers — once per provider. It
spins up a real local `uvicorn` server (all three SDKs need a real socket for `base_url`; only
`langchain-openai` supports a fully custom `httpx` transport, so a real server is the one
mechanism that works identically for all three) and still mocks the actual upstream HTTP call at
`app.providers.send_request` — deterministic and offline, but the response shapes are realistic
enough that each real SDK parses them exactly as it would a live response.

These tests need heavier optional deps not in `requirements-dev.txt` — they skip cleanly
(`pytest.importorskip`) everywhere else, including CI and the production image:

```bash
cd backend && pip install -r requirements-e2e.txt
pytest tests/test_e2e_langgraph.py -v
```

## Smoke test

```bash
BASE=http://localhost:8000
J=/tmp/cj; rm -f $J
curl -s $BASE/healthz
# read endpoints require a session + workspace -> 401 for anon
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/usage/summary
# sign up + create a workspace (cookie jar carries the session)
curl -sc $J -X POST $BASE/api/auth/signup -H 'Content-Type: application/json' \
  -d '{"username":"smoke","password":"pw-abcdefgh"}' >/dev/null
# cookie-authenticated writes under /api must echo the csrf_token cookie (see CSRF in [api.md](api.md))
CSRF=$(awk '$6=="csrf_token"{print $7}' $J)
curl -sb $J -c $J -X POST $BASE/api/workspace -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: $CSRF" -d '{"name":"Smoke Co"}' >/dev/null
# create a key scoped to openai + openrouter (allow_live on)
KEY=$(curl -sb $J -X POST $BASE/api/keys -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: $CSRF" -d '{"label":"smoke","allowed_providers":["openai","openrouter"],"allow_live":true}' \
  | python -c 'import sys,json;print(json.load(sys.stdin)["key"])')
# no provider key attached for openai -> 402 provider_not_configured
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/v1/proxy/chat \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"provider":"openai","model":"gpt-4o-mini","prompt":"hello"}'
# provider not on the key -> 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/v1/proxy/chat \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"provider":"anthropic","model":"claude-3-5-haiku","prompt":"hi"}'
# no key -> 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/v1/proxy/chat \
  -H 'Content-Type: application/json' -d '{"provider":"openai","model":"gpt-4o","prompt":"x"}'
curl -sb $J $BASE/api/usage/summary
```
