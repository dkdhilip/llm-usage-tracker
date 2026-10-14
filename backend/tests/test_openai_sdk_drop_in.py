"""The official OpenAI SDK as a drop-in client of THIS gateway.

The migration under test is environment-only: `OPENAI_API_KEY=vk_...` and
`OPENAI_BASE_URL=https://<gateway>/v1`, application code untouched. These tests drive the real `openai`
SDK (built with no arguments, `openai.OpenAI()`, so it reads those two variables) against the real
gateway code over a real localhost socket, with the provider stood in for at the same seam every other
adapter test uses (app.providers.send_request / stream_request). Nothing here reaches api.openai.com:
the provider stand-in is faithful where the SDK and gateway depend on fidelity, and the shared HTTP
client is replaced with one that FAILS LOUDLY on any call that slipped past the stand-in.

Two kinds of test live here:
  * compatibility that holds today — asserted normally;
  * known incompatibilities — asserted as what they ARE today (so they are documented and a future fix
    shows up as a deliberate test change), or `xfail(strict=True)` where the desired behavior is clear.
The gateway is NOT modified to make any of this pass.

Needs the `openai` package; skips cleanly where it is absent.
"""

import base64
import json
import struct
import threading
import time
import uuid

import httpx
import pytest

openai = pytest.importorskip("openai")

import uvicorn  # noqa: E402

from app import providers  # noqa: E402
from app.main import app as fastapi_app  # noqa: E402

# ----------------------------------------------------------------------------- real server + provider stand-in


@pytest.fixture(scope="module")
def live_server():
    """The real FastAPI app on a real localhost socket (same pattern as test_e2e_langgraph.py)."""
    server = uvicorn.Server(uvicorn.Config(fastapi_app, host="127.0.0.1", port=0, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(500):
        if server.started:
            break
        time.sleep(0.02)
    else:
        raise RuntimeError("uvicorn test server did not start in time")
    yield f"http://127.0.0.1:{server.servers[0].sockets[0].getsockname()[1]}"
    server.should_exit = True
    thread.join(timeout=5)


class FakeOpenAIProvider:
    """Stands in for api.openai.com. Faithful where it matters to the SDK and the gateway: a unique
    response id, the dated model name, `usage` derived from the request, base64 embeddings when the SDK
    asks for them, and — crucially — a streamed `usage` chunk ONLY when the request set
    stream_options.include_usage (the real API's behavior)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict, dict]] = []  # (url, headers, json_body)
        self.fail_with: tuple[int, dict] | Exception | None = None

    @staticmethod
    def _words(text) -> int:
        return len(text.split()) if isinstance(text, str) else 0

    def _usage(self, body: dict, completion_tokens: int) -> dict:
        prompt = 3 + sum(self._words(m.get("content")) for m in body.get("messages", []))
        return {"prompt_tokens": prompt, "completion_tokens": completion_tokens, "total_tokens": prompt + completion_tokens}

    def _fail_if_asked(self) -> None:
        f = self.fail_with
        if f is None:
            return
        if isinstance(f, Exception):
            raise f
        status, body = f
        request = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")
        response = httpx.Response(status, json=body, request=request)
        raise httpx.HTTPStatusError(f"HTTP {status}", request=request, response=response)

    def _chat(self, body: dict) -> dict:
        messages = body.get("messages", [])
        tools = body.get("tools")
        if tools and not any(m.get("role") == "tool" for m in messages):
            call = {"id": "call_fake_1", "type": "function",
                    "function": {"name": tools[0]["function"]["name"], "arguments": json.dumps({"city": "Denver"})}}
            choices = [{"index": 0, "message": {"role": "assistant", "content": None, "tool_calls": [call]},
                        "finish_reason": "tool_calls"}]
            completion_tokens = 4
        else:
            if (body.get("response_format") or {}).get("type") == "json_object":
                text = json.dumps({"ok": True})
            else:
                last = next((m["content"] for m in reversed(messages)
                             if m.get("role") in ("user", "tool") and isinstance(m.get("content"), str)), "")
                text = f"echo: {last}"
            n = body.get("n", 1)
            choices = [{"index": i, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}
                       for i in range(n)]
            completion_tokens = self._words(text) * n
        return {
            "id": f"chatcmpl-fake-{uuid.uuid4().hex[:12]}", "object": "chat.completion", "created": 1_700_000_000,
            "model": body["model"] + "-2024-07-18", "choices": choices,
            "usage": self._usage(body, completion_tokens), "system_fingerprint": "fp_fake",
        }

    def _embeddings(self, body: dict) -> dict:
        inputs = body["input"] if isinstance(body["input"], list) else [body["input"]]
        vector = [0.25, 0.5, 0.75]
        embedding = (base64.b64encode(struct.pack("<3f", *vector)).decode()
                     if body.get("encoding_format") == "base64" else vector)
        tokens = sum(self._words(x) for x in inputs)
        return {"object": "list", "model": body["model"],
                "data": [{"object": "embedding", "index": i, "embedding": embedding} for i in range(len(inputs))],
                "usage": {"prompt_tokens": tokens, "total_tokens": tokens}}

    def send_request(self, url, headers, json_body, *, timeout=60.0):
        self.calls.append((url, headers, json_body))
        self._fail_if_asked()
        if url.endswith("/chat/completions"):
            return self._chat(json_body)
        if url.endswith("/embeddings"):
            return self._embeddings(json_body)
        raise AssertionError(f"unexpected provider URL: {url}")

    def stream_request(self, url, headers, json_body, *, timeout=60.0):
        self.calls.append((url, headers, json_body))
        self._fail_if_asked()
        cid, model = f"chatcmpl-fake-{uuid.uuid4().hex[:12]}", json_body["model"] + "-2024-07-18"
        base = {"id": cid, "object": "chat.completion.chunk", "created": 1_700_000_000, "model": model}
        last = next((m["content"] for m in reversed(json_body["messages"]) if m.get("role") == "user"), "")
        words = f"echo: {last}".split()

        def event(delta: dict, finish=None) -> str:
            return "data: " + json.dumps({**base, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})

        yield event({"role": "assistant", "content": ""})
        yield ""
        for i, w in enumerate(words):
            yield event({"content": w + (" " if i < len(words) - 1 else "")})
            yield ""
        yield event({}, "stop")
        yield ""
        if (json_body.get("stream_options") or {}).get("include_usage"):
            yield "data: " + json.dumps({**base, "choices": [], "usage": self._usage(json_body, len(words))})
            yield ""
        yield "data: [DONE]"
        yield ""


@pytest.fixture()
def openai_provider(monkeypatch):
    fake = FakeOpenAIProvider()
    monkeypatch.setattr("app.providers.send_request", fake.send_request)
    monkeypatch.setattr("app.providers.stream_request", fake.stream_request)

    def _no_real_network(request: httpx.Request):
        raise AssertionError(f"UNMOCKED outbound HTTP call: {request.method} {request.url}")

    monkeypatch.setattr(providers, "_client", httpx.Client(transport=httpx.MockTransport(_no_real_network)))
    return fake


@pytest.fixture()
def sdk(live_server, monkeypatch):
    """Builds the client the way the example app does: `openai.OpenAI()`, configured only by the two
    environment variables. `test_knobs` (e.g. max_retries=0) exist only to keep error tests fast."""
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")

    def make(virtual_key: str, base_url: str | None = None, **test_knobs):
        monkeypatch.setenv("OPENAI_API_KEY", virtual_key)
        monkeypatch.setenv("OPENAI_BASE_URL", base_url or f"{live_server}/v1")
        return openai.OpenAI(**test_knobs)

    return make


def _rows(admin_client) -> list[dict]:
    """The dashboard's Requests API, newest first."""
    return admin_client.get("/api/requests").json()["items"]


def _wait_for_rows(admin_client, n: int = 1, seconds: float = 4.0) -> list[dict]:
    """A streamed call's usage row is written by the gateway AFTER its last chunk is sent, and the SDK
    stops reading at `[DONE]` — so the row lands a moment after the client returns."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        rows = _rows(admin_client)
        if len(rows) >= n:
            return rows
        time.sleep(0.05)
    return _rows(admin_client)


def _hello(model: str = "gpt-4o-mini", **kw) -> dict:
    return {"model": model, "messages": [{"role": "user", "content": "hello gateway"}], **kw}


# ----------------------------------------------------------------------------- the migration itself


def test_the_sdk_reaches_the_gateways_chat_route_only_when_the_base_url_ends_in_v1(sdk, make_live_key):
    key = make_live_key(allowed_providers=["openai"], default_provider="openai")
    base = sdk(key["key"]).base_url  # http://127.0.0.1:<port>/v1/
    without_v1 = sdk(key["key"], base_url=str(base).removesuffix("/v1/"), max_retries=0)
    with pytest.raises(openai.NotFoundError):  # POST /chat/completions — the route lives under /v1
        without_v1.chat.completions.create(**_hello())


# ----------------------------------------------------------------------------- model names (a real migration requirement)


def test_unprefixed_model_names_work_only_when_the_key_has_a_default_provider(sdk, make_live_key, openai_provider):
    """`model="gpt-4o-mini"` in existing code needs NO change — but only if the virtual key was created
    with default_provider. Without one the gateway can't tell which provider an unprefixed name means."""
    no_default = sdk(make_live_key(allowed_providers=["openai"])["key"], max_retries=0)
    with pytest.raises(openai.UnprocessableEntityError) as exc:
        no_default.chat.completions.create(**_hello())
    assert "default_provider" in exc.value.message
    assert openai_provider.calls == []  # rejected before any provider call

    # the provider-prefixed form always works, and the gateway strips the prefix before forwarding
    no_default.chat.completions.create(**_hello("openai/gpt-4o-mini"))
    assert openai_provider.calls[-1][2]["model"] == "gpt-4o-mini"

    with_default = sdk(make_live_key(allowed_providers=["openai"], default_provider="openai")["key"])
    assert with_default.chat.completions.create(**_hello()).model == "gpt-4o-mini-2024-07-18"


# ----------------------------------------------------------------------------- chat.completions fidelity


def test_a_plain_completion_round_trips_and_is_recorded(sdk, make_live_key, admin_client, openai_provider):
    client = sdk(make_live_key(allowed_providers=["openai"], default_provider="openai")["key"])  # openai.OpenAI(), env only
    completion = client.chat.completions.create(**_hello())

    assert completion.choices[0].message.content == "echo: hello gateway"
    assert completion.choices[0].finish_reason == "stop"
    assert completion.model == "gpt-4o-mini-2024-07-18"  # the provider's own model string, untouched
    (row,) = _rows(admin_client)
    assert row["request_id"] == completion.id
    assert row["total_tokens"] == completion.usage.total_tokens > 0


def test_roles_history_and_request_parameters_reach_the_provider_untouched(sdk, make_live_key, openai_provider):
    client = sdk(make_live_key(allowed_providers=["openai"], default_provider="openai")["key"])
    messages = [
        {"role": "system", "content": "You are terse."},
        {"role": "user", "content": "first question"},
        {"role": "assistant", "content": "first answer"},
        {"role": "user", "content": "second question"},
    ]
    client.chat.completions.create(
        model="gpt-4o-mini", messages=messages, temperature=0.2, top_p=0.9, seed=7, user="u-1",
        max_completion_tokens=50, stop=["END"], presence_penalty=0.1,
    )
    sent = openai_provider.calls[-1][2]
    assert sent["messages"] == messages  # multi-turn history + system prompt preserved verbatim
    assert {k: sent[k] for k in ("temperature", "top_p", "seed", "user", "max_completion_tokens", "stop", "presence_penalty")} == {
        "temperature": 0.2, "top_p": 0.9, "seed": 7, "user": "u-1", "max_completion_tokens": 50,
        "stop": ["END"], "presence_penalty": 0.1}


def test_tool_calling_round_trips(sdk, make_live_key, openai_provider):
    client = sdk(make_live_key(allowed_providers=["openai"], default_provider="openai")["key"])
    tools = [{"type": "function", "function": {"name": "get_weather", "description": "weather",
                                               "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}}}]
    first = client.chat.completions.create(**_hello(tools=tools))
    call = first.choices[0].message.tool_calls[0]
    assert first.choices[0].finish_reason == "tool_calls"
    assert (call.function.name, json.loads(call.function.arguments)) == ("get_weather", {"city": "Denver"})

    followup = [*_hello()["messages"], first.choices[0].message.model_dump(exclude_none=True),
                {"role": "tool", "tool_call_id": call.id, "content": "sunny, 68F"}]
    final = client.chat.completions.create(model="gpt-4o-mini", messages=followup, tools=tools)
    assert final.choices[0].message.content == "echo: sunny, 68F"
    assert openai_provider.calls[-1][2]["messages"][-1]["role"] == "tool"


def test_json_mode_and_multiple_choices(sdk, make_live_key, openai_provider):
    client = sdk(make_live_key(allowed_providers=["openai"], default_provider="openai")["key"])
    j = client.chat.completions.create(**_hello(response_format={"type": "json_object"}))
    assert json.loads(j.choices[0].message.content) == {"ok": True}
    assert len(client.chat.completions.create(**_hello(n=3)).choices) == 3


def test_embeddings_with_the_sdks_default_base64_encoding(sdk, make_live_key, admin_client, openai_provider):
    client = sdk(make_live_key(allowed_providers=["openai"])["key"])
    result = client.embeddings.create(model="text-embedding-3-small", input="hello embeddings world")
    assert result.data[0].embedding == [0.25, 0.5, 0.75]  # the SDK asked for base64 and decoded it
    assert openai_provider.calls[-1][2]["encoding_format"] == "base64"
    (row,) = _rows(admin_client)
    assert (row["provider"], row["model"], row["prompt_tokens"]) == ("openai", "text-embedding-3-small", 3)


# ----------------------------------------------------------------------------- streaming


def test_streaming_with_include_usage_is_forwarded_and_recorded(sdk, make_live_key, admin_client, openai_provider):
    client = sdk(make_live_key(allowed_providers=["openai"], default_provider="openai")["key"])
    stream = client.chat.completions.create(**_hello(stream=True, stream_options={"include_usage": True}))
    chunks = list(stream)

    text = "".join(c.choices[0].delta.content or "" for c in chunks if c.choices)
    assert text == "echo: hello gateway"
    final = chunks[-1]
    assert final.choices == [] and final.usage.total_tokens > 0  # the usage chunk has NO choices
    (row,) = _wait_for_rows(admin_client)
    assert row["total_tokens"] == final.usage.total_tokens
    assert row["status"] == "success"


@pytest.mark.xfail(
    strict=True,
    reason="KNOWN GAP (gateway not modified): the OpenAI SDK's default stream=True sends no "
    "stream_options.include_usage, the gateway's /v1/chat/completions streaming path does not add it "
    "(only the legacy /v1/proxy/chat path does — providers.py), so OpenAI sends no usage chunk and the "
    "dashboard records 0 tokens / $0 for the call. Remove this marker when the gateway injects it.",
)
def test_streaming_without_include_usage_should_still_record_tokens(sdk, make_live_key, admin_client, openai_provider):
    client = sdk(make_live_key(allowed_providers=["openai"], default_provider="openai")["key"])
    assert "".join(c.choices[0].delta.content or "" for c in client.chat.completions.create(**_hello(stream=True))
                   if c.choices) == "echo: hello gateway"  # the stream itself works fine
    assert "stream_options" not in openai_provider.calls[-1][2]  # the gateway added nothing
    (row,) = _wait_for_rows(admin_client)  # a row IS written...
    assert row["total_tokens"] > 0  # <- ...but desired is real tokens; today it is 0


@pytest.mark.xfail(
    strict=True,
    reason="KNOWN GAP (gateway not modified): usage is recorded by code that runs AFTER the stream's last "
    "chunk, so a client that abandons a stream midway (a Stop button, a client timeout) leaves NO usage row "
    "at all, although the provider still bills for what was generated. Measured: 0 rows after 6s. Remove "
    "this marker when abandoned streams are recorded.",
)
def test_an_abandoned_stream_should_still_leave_a_usage_row(sdk, make_live_key, admin_client, openai_provider):
    client = sdk(make_live_key(allowed_providers=["openai"], default_provider="openai")["key"])
    stream = client.chat.completions.create(**_hello(stream=True, stream_options={"include_usage": True}))
    next(iter(stream))  # read one chunk, then walk away
    stream.close()
    assert len(_wait_for_rows(admin_client, seconds=3.0)) == 1  # <- desired; today there is none


# ----------------------------------------------------------------------------- errors, as the SDK's callers see them


def test_a_provider_error_passes_through_in_openai_shape(sdk, make_live_key, openai_provider):
    """The case apps depend on: provider 4xx/5xx arrive with the provider's own status AND body, so the
    SDK's exception carries the real .code/.type/.message — fully OpenAI-compatible."""
    client = sdk(make_live_key(allowed_providers=["openai"], default_provider="openai")["key"], max_retries=0)
    openai_provider.fail_with = (400, {"error": {"message": "context length exceeded", "type": "invalid_request_error",
                                                 "code": "context_length_exceeded", "param": "messages"}})
    with pytest.raises(openai.BadRequestError) as exc:
        client.chat.completions.create(**_hello())
    assert (exc.value.status_code, exc.value.code, exc.value.type, exc.value.param) == (
        400, "context_length_exceeded", "invalid_request_error", "messages")

    openai_provider.fail_with = (429, {"error": {"message": "slow down", "type": "requests", "code": "rate_limit_exceeded"}})
    with pytest.raises(openai.RateLimitError) as rl:
        client.chat.completions.create(**_hello())
    assert rl.value.code == "rate_limit_exceeded"


def test_gateway_originated_errors_are_not_openai_shaped(sdk, make_live_key, admin_client, openai_provider):
    """Honest incompatibility: errors the GATEWAY raises use FastAPI's {"detail": ...}, not OpenAI's
    {"error": {message, type, code}}. The SDK still maps the HTTP status to the right exception class,
    but .code / .type / .param are None and the useful text is in .body["detail"]."""
    # 401 — unknown virtual key
    with pytest.raises(openai.AuthenticationError) as bad:
        sdk("vk_does_not_exist", max_retries=0).chat.completions.create(**_hello())
    assert bad.value.status_code == 401
    assert bad.value.body == {"detail": "invalid or revoked virtual key"}
    assert (bad.value.code, bad.value.type) == (None, None)

    # 403 — key paused
    paused = sdk(make_live_key(allowed_providers=["openai"], default_provider="openai", allow_live=False)["key"], max_retries=0)
    with pytest.raises(openai.PermissionDeniedError) as p:
        paused.chat.completions.create(**_hello())
    assert p.value.body["detail"]["type"] == "key_paused" and p.value.code is None

    # 403 — model not on the key's allow-list
    limited = sdk(make_live_key(allowed_providers=["openai"], default_provider="openai",
                                allowed_models={"openai": ["gpt-4o-mini"]})["key"], max_retries=0)
    with pytest.raises(openai.PermissionDeniedError) as m:
        limited.chat.completions.create(**_hello("gpt-4o"))
    assert m.value.body["detail"]["type"] == "model_not_allowed"

    assert openai_provider.calls == []  # none of the above reached the provider


def test_a_402_has_no_sdk_exception_class_of_its_own(sdk, make_live_key, admin_client, openai_provider):
    """Budget and missing-provider-key failures are HTTP 402. The OpenAI SDK has no 402 class, so callers
    get the generic APIStatusError and must read .status_code / .body (not catch a specific subclass)."""
    over_budget = sdk(make_live_key(allowed_providers=["openai"], default_provider="openai",
                                    monthly_budget_usd=0.000001)["key"], max_retries=0)
    over_budget.chat.completions.create(**_hello())  # the first call is allowed (spend is still 0)
    with pytest.raises(openai.APIStatusError) as b:
        over_budget.chat.completions.create(**_hello())
    assert type(b.value) is openai.APIStatusError  # not a RateLimitError / PermissionDeniedError / ...
    assert (b.value.status_code, b.value.body["detail"]["type"]) == (402, "budget_exceeded")

    # Mint the key FIRST: a key created while its provider has no credential is born paused (403
    # key_paused), so the 402 only arises when the provider key is removed from a live key afterwards.
    no_key = sdk(make_live_key(allowed_providers=["openai"], default_provider="openai")["key"], max_retries=0)
    admin_client.delete("/api/workspace/providers/openai/key")  # the workspace now has no OpenAI key
    with pytest.raises(openai.APIStatusError) as n:
        no_key.chat.completions.create(**_hello())
    assert (n.value.status_code, n.value.body["detail"]["type"]) == (402, "provider_not_configured")


def test_provider_unreachable_surfaces_as_a_502_server_error(sdk, make_live_key, openai_provider):
    client = sdk(make_live_key(allowed_providers=["openai"], default_provider="openai")["key"], max_retries=0)
    openai_provider.fail_with = httpx.ConnectError("connection refused")
    with pytest.raises(openai.InternalServerError) as exc:
        client.chat.completions.create(**_hello())
    assert (exc.value.status_code, exc.value.body["detail"]["type"]) == (502, "upstream_error")


# ----------------------------------------------------------------------------- known incompatibilities


def test_provider_response_metadata_headers_are_not_forwarded(sdk, make_live_key, openai_provider):
    """Honest incompatibility: only the JSON body is relayed. Provider headers apps sometimes log —
    x-request-id, openai-processing-ms, x-ratelimit-* — are absent, so completion._request_id is None."""
    client = sdk(make_live_key(allowed_providers=["openai"], default_provider="openai")["key"])
    raw = client.chat.completions.with_raw_response.create(**_hello())
    assert "x-request-id" not in raw.headers and "openai-processing-ms" not in raw.headers
    assert not any(h.startswith("x-ratelimit") for h in raw.headers)
    assert raw.parse()._request_id is None


@pytest.mark.parametrize(
    "call",
    [
        pytest.param(lambda c: c.moderations.create(input="x"), id="moderations"),
        pytest.param(lambda c: c.completions.create(model="gpt-3.5-turbo-instruct", prompt="x"), id="legacy-completions"),
        pytest.param(lambda c: c.files.list(), id="files"),
        pytest.param(lambda c: c.batches.list(), id="batches"),
        pytest.param(lambda c: c.models.list(), id="models.list"),
    ],
)
def test_openai_surfaces_the_gateway_does_not_implement_return_404_in_dev(sdk, make_live_key, call):
    """The gateway has no /v1/models, /v1/moderations, /v1/completions, /v1/files or /v1/batches (see the
    README's compatibility table). Here — no SPA bundle mounted — they are a clean 404.

    NOTE: in PRODUCTION the dashboard's SPA catch-all answers any unmatched GET with 200 text/html, so
    `models.list()` does not 404 there: it makes the SDK crash with an AttributeError. Verified against the
    deployed gateway and recorded in the README; it can't be reproduced here because the SPA is only mounted
    when a built bundle exists."""
    client = sdk(make_live_key(allowed_providers=["openai"], default_provider="openai")["key"], max_retries=0)
    with pytest.raises(openai.NotFoundError):
        call(client)
