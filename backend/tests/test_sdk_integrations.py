"""OpenAI, Anthropic and Gemini SDKs through THIS gateway — the developer experience, executed.

What is real and what is mocked (nothing here touches a real provider or costs money):
  REAL    the gateway code (FastAPI app on a real localhost socket), virtual-key auth, the full
          governance funnel, usage + cost recording, the official SDKs (openai, anthropic, google-genai),
          the shared helper in examples/gateway-sdks, and the copy-ready snippets the dashboard shows
          (app.integration), which are run VERBATIM as separate processes.
  MOCKED  only the provider's HTTP response, at the same seam every adapter test uses
          (app.providers.send_request). The shared HTTP client is replaced with one that FAILS LOUDLY on
          any call that slips past the mock, so these tests cannot reach a provider.

A real end-to-end test against a live provider needs real credentials and costs money; it is
deliberately not part of this suite (see examples/gateway-sdks/README.md).
"""

import importlib.util
import json
import os
import socket
import subprocess
import sys
import threading
import time
import uuid
from importlib import metadata
from pathlib import Path

import httpx
import pytest
from packaging.version import Version

openai = pytest.importorskip("openai")
anthropic = pytest.importorskip("anthropic")
genai = pytest.importorskip("google.genai")
pytest.importorskip("dotenv")

import uvicorn  # noqa: E402
from google.genai import errors as genai_errors  # noqa: E402

from app import integration, providers  # noqa: E402
from app.config import settings  # noqa: E402
from app.main import app as fastapi_app  # noqa: E402

HELPER_DIR = Path(__file__).resolve().parents[2] / "examples" / "gateway-sdks"
pytestmark = pytest.mark.skipif(not (HELPER_DIR / "gateway_client.py").exists(), reason="examples/ directory not available")

ALL = ["openai", "anthropic", "gemini"]
# Every runnable snippet the dashboard shows, as (provider, field of integration.setup_for). OpenAI has two: the
# standard environment-based one (its primary, `client = OpenAI()`) and the explicit alternative. ALL of them stop with
# a clear error before any request when the configuration is missing or wrong.
SNIPPETS = [("openai", "code"), ("anthropic", "code"), ("gemini", "code"), ("openai", "alt_code")]
SNIPPET_IDS = ["openai", "anthropic", "gemini", "openai-explicit"]
OPENAI_SNIPPETS = [("openai", "code"), ("openai", "alt_code")]
OPENAI_IDS = ["openai", "openai-explicit"]
# What the gateway must call upstream, and how it must authenticate there, per provider. The workspace
# credential is the fake one tests/conftest.py attaches — the virtual key must never appear upstream.
UPSTREAM = {
    "openai": ("https://api.openai.com/v1/chat/completions", "Authorization", "Bearer sk-fake-openai-key-000000"),
    "anthropic": ("https://api.anthropic.com/v1/messages", "x-api-key", "sk-fake-anthropic-key-000000"),
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
               "x-goog-api-key", "sk-fake-gemini-key-000000"),
}
# What the dashboard should record for each snippet's model. claude-haiku-4-5 is not in the built-in
# price table, so its cost is honestly "unknown" until the workspace prices it (never a made-up number).
RECORDED = {
    "openai": ("gpt-4o-mini", "configured"),
    "anthropic": ("claude-haiku-4-5-20251001", "unknown"),
    "gemini": ("gemini-3.8-flash", "configured"),
}


def _load_helper():
    spec = importlib.util.spec_from_file_location("gateway_client_under_test", HELPER_DIR / "gateway_client.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ----------------------------------------------------------------------------- real server + faithful provider mock


@pytest.fixture(scope="module")
def live_server():
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


class FakeProviders:
    """Stands in for api.openai.com, api.anthropic.com and generativelanguage.googleapis.com."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict, dict]] = []

    @staticmethod
    def _words(text) -> int:
        return len(text.split()) if isinstance(text, str) else 0

    def send_request(self, url, headers, json_body, *, timeout=60.0):
        self.calls.append((url, headers, json_body))
        n = len(self.calls)
        if url.endswith("/chat/completions"):
            return {"id": f"chatcmpl-fake-{uuid.uuid4().hex[:10]}", "object": "chat.completion", "created": 1_700_000_000,
                    "model": json_body["model"] + "-2024-07-18",
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hello there, nice to meet you"}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 14, "completion_tokens": 6, "total_tokens": 20}}
        if url.endswith("/v1/messages"):
            return {"id": f"msg_fake_{n}_{uuid.uuid4().hex[:8]}", "type": "message", "role": "assistant", "model": json_body["model"],
                    "content": [{"type": "text", "text": "Hello there, nice to meet you"}], "stop_reason": "end_turn",
                    "stop_sequence": None, "usage": {"input_tokens": 14, "output_tokens": 6}}
        if url.endswith(":generateContent"):
            return {"candidates": [{"content": {"role": "model", "parts": [{"text": "Hello there, nice to meet you"}]},
                                    "finishReason": "STOP", "index": 0}],
                    "usageMetadata": {"promptTokenCount": 14, "candidatesTokenCount": 6, "totalTokenCount": 20},
                    "modelVersion": "gemini-3.8-flash"}
        raise AssertionError(f"unexpected provider URL: {url}")


@pytest.fixture()
def fake_providers(monkeypatch):
    fake = FakeProviders()
    monkeypatch.setattr("app.providers.send_request", fake.send_request)

    def _no_real_network(request: httpx.Request):
        raise AssertionError(f"UNMOCKED outbound HTTP call: {request.method} {request.url}")

    monkeypatch.setattr(providers, "_client", httpx.Client(transport=httpx.MockTransport(_no_real_network)))
    return fake


def _rows(admin_client) -> list[dict]:
    return admin_client.get("/api/requests").json()["items"]


def _clean_env(extra: dict[str, str]) -> dict[str, str]:
    scrub = ("OPENAI_", "ANTHROPIC_", "GOOGLE_", "GEMINI_", "LLM_GATEWAY_", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY")
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(scrub)}
    env["NO_PROXY"] = "127.0.0.1,localhost"
    return {**env, **extra}


# ----------------------------------------------------------------------------- the dashboard's snippets, run verbatim


@pytest.mark.parametrize(("provider", "field"), SNIPPETS, ids=SNIPPET_IDS)
def test_the_dashboards_copy_ready_snippet_works_unchanged_through_the_gateway(
    provider, field, tmp_path, live_server, make_live_key, admin_client, fake_providers
):
    """The exact text a developer would copy: the .env block (key pasted in) and the code, run as a
    separate process. Anthropic's and Gemini's snippets (their .env wins) also face real provider keys in the shell as
    traps; the OpenAI snippets let the real environment win, so their ambient-key cases are tested separately below."""
    label = f"{provider}-{field}-snippet"
    key = make_live_key(allowed_providers=ALL, label=label)["key"]
    setup = integration.setup_for(provider, live_server)  # what GET /api/integration returns for this gateway

    (tmp_path / ".env").write_text(setup["env_file"].replace("vk_...", key) + "\n")
    (tmp_path / "snippet.py").write_text(setup[field])
    traps = {} if provider == "openai" else {"OPENAI_API_KEY": "sk-AMBIENT-REAL-OPENAI-KEY", "ANTHROPIC_API_KEY": "sk-ant-AMBIENT-REAL-KEY",
                                              "GOOGLE_API_KEY": "AIza-AMBIENT-REAL-GOOGLE-KEY"}
    r = subprocess.run([sys.executable, "snippet.py"], cwd=tmp_path, env=_clean_env(traps), capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    assert "Hello there, nice to meet you" in r.stdout

    # the gateway called the RIGHT provider endpoint with the WORKSPACE's credential...
    (url, headers, body), = fake_providers.calls
    expected_url, header, value = UPSTREAM[provider]
    assert url == expected_url and headers[header] == value
    wire = json.dumps([headers, body])
    assert key not in wire and "AMBIENT" not in wire  # ...never the virtual key, never a developer's real key

    # ...and the request is on the dashboard with usage and (when the model is priced) cost.
    (row,) = _rows(admin_client)
    model, cost_source = RECORDED[provider]
    assert (row["key_label"], row["provider"], row["model"], row["status"]) == (label, provider, model, "success")
    assert (row["prompt_tokens"], row["completion_tokens"], row["total_tokens"]) == (14, 6, 20)
    assert row["cost_source"] == cost_source
    assert (row["cost"] is None) == (cost_source == "unknown")


def test_existing_openai_code_works_unchanged_when_only_the_environment_is_set(
    tmp_path, live_server, make_live_key, admin_client, fake_providers
):
    """The headline claim: a project that already calls `client = OpenAI()` and has the two variables in its process
    environment (loaded by its framework, a shell, a container, CI — no dotenv call anywhere) talks to the gateway."""
    key = make_live_key(allowed_providers=ALL, label="existing-openai-app")["key"]
    (tmp_path / "existing_app.py").write_text(
        'from openai import OpenAI\n\nclient = OpenAI()\n'
        'r = client.chat.completions.create(model="openai/gpt-4o-mini", messages=[{"role": "user", "content": "hi"}], max_tokens=20)\n'
        'print(r.choices[0].message.content)\n'
    )
    env = _clean_env({"OPENAI_API_KEY": key, "OPENAI_BASE_URL": integration.setup_for("openai", live_server)["base_url"]})
    r = subprocess.run([sys.executable, "existing_app.py"], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    assert "Hello there, nice to meet you" in r.stdout

    (url, headers, body), = fake_providers.calls
    assert url == UPSTREAM["openai"][0] and headers["Authorization"] == UPSTREAM["openai"][2]
    assert key not in json.dumps([headers, body])  # the virtual key never goes upstream
    (row,) = _rows(admin_client)
    assert (row["key_label"], row["provider"], row["status"]) == ("existing-openai-app", "openai", "success")


# ----------------------------------------------------------------------------- bad or missing configuration stops a snippet before any request; only the project's .env is read


class ConnectionCounter:
    """A local listener standing in for 'the internet'. Pointed to by HTTP(S)_PROXY (or used as a decoy
    gateway URL), any SDK call that would have left for a provider host — or been misrouted — shows up
    here as an accepted connection. It speaks no protocol: it counts and hangs up."""

    def __init__(self) -> None:
        self._sock = socket.socket()
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen(16)
        self._sock.settimeout(0.2)
        self.count = 0
        self._stop = False
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop:
            try:
                conn, _ = self._sock.accept()
            except TimeoutError:
                continue
            except OSError:
                return
            self.count += 1
            conn.close()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._sock.getsockname()[1]}"

    def settled(self) -> int:
        time.sleep(0.4)  # let the listener thread finish counting what the subprocess did
        return self.count

    def close(self) -> None:
        self._stop = True
        self._thread.join(timeout=2)
        self._sock.close()


@pytest.fixture()
def internet():
    counter = ConnectionCounter()
    yield counter
    counter.close()


def _names(provider: str) -> tuple[str, str]:
    key_var, url_var = (e["name"] for e in integration.setup_for(provider, "https://gw.example.com")["env_vars"])
    return key_var, url_var


def _project(directory: Path, provider: str, gateway_url: str | None, key: str | None, field: str = "code") -> None:
    """A project directory holding the dashboard's snippet and (optionally) its .env, filled in."""
    directory.mkdir(parents=True, exist_ok=True)
    key_var, url_var = _names(provider)
    setup = integration.setup_for(provider, gateway_url or "https://unused.example.com")
    lines = []
    if key is not None:
        lines.append(f"{key_var}={key}")
    if gateway_url is not None:
        lines.append(f"{url_var}={setup['base_url'] if provider == 'openai' else setup['gateway_url']}")
    if lines:
        (directory / ".env").write_text("\n".join(lines) + "\n")
    (directory / "snippet.py").write_text(setup[field])


def _run_snippet(directory: Path, env: dict[str, str]) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "snippet.py"], cwd=directory, env=env, capture_output=True, text=True, timeout=120)


@pytest.mark.parametrize(("provider", "field"), SNIPPETS, ids=SNIPPET_IDS)
def test_a_parent_directory_env_cannot_override_the_projects_own_configuration(
    provider, field, tmp_path, live_server, make_live_key, fake_providers, internet
):
    key = make_live_key(allowed_providers=ALL)["key"]
    parent, project = tmp_path / "parent", tmp_path / "parent" / "project"
    _project(parent, provider, internet.url, "sk-PARENT-REAL-KEY", field)  # a parent .env that points somewhere else
    _project(project, provider, live_server, key, field)

    r = _run_snippet(project, _clean_env({}))
    assert r.returncode == 0, r.stderr
    (url, headers, body), = fake_providers.calls
    assert url == UPSTREAM[provider][0]
    assert "PARENT" not in json.dumps([headers, body])
    assert internet.settled() == 0  # nothing was sent to the parent's URL


def _message(provider: str, what: str) -> str:
    """The text a snippet raises. OpenAI's (standard and explicit) say what is wrong; Anthropic's and Gemini's name the variable."""
    key_var, url_var = _names(provider)
    if provider == "openai":
        return {"key": f"{key_var} is missing or is not a gateway virtual key", "url": f"{url_var} is not set",
                "both": f"{key_var} is missing or is not a gateway virtual key"}[what]  # the key is checked first
    return {"key": f"Missing {key_var} - add it", "url": f"Missing {url_var} - add it",
            "both": f"Missing {key_var}, {url_var} - add it"}[what]


@pytest.mark.parametrize(("provider", "field"), SNIPPETS, ids=SNIPPET_IDS)
def test_without_its_own_env_a_project_never_borrows_a_parent_directorys(
    provider, field, tmp_path, live_server, make_live_key, fake_providers, internet
):
    """The parent holds a COMPLETE, working configuration. A snippet that walked up the tree would succeed
    with it; these must refuse, because the project itself has no .env."""
    key = make_live_key(allowed_providers=ALL)["key"]
    key_var, _ = _names(provider)
    parent, project = tmp_path / "parent", tmp_path / "parent" / "project"
    _project(parent, provider, live_server, key, field)
    _project(project, provider, None, None, field)

    # control: the OLD pattern (bare load_dotenv(override=True)) really does pick up the parent's .env here,
    # so this test would have caught it.
    probe = f"from dotenv import load_dotenv\nimport os\nload_dotenv(override=True)\nprint(os.environ.get({key_var!r}))\n"
    (project / "old_pattern.py").write_text(probe)
    old = subprocess.run([sys.executable, "old_pattern.py"], cwd=project, env=_clean_env({}), capture_output=True, text=True, timeout=60)
    assert old.stdout.strip() == key

    r = _run_snippet(project, _clean_env({}))
    assert r.returncode != 0 and "RuntimeError" in r.stderr and _message(provider, "both") in r.stderr
    assert key not in r.stdout + r.stderr
    assert fake_providers.calls == [] and internet.settled() == 0


NAIVE = {  # what an SDK does when it is only handed the key: it heads for the provider's own host
    "openai": 'import os\nfrom openai import OpenAI\nOpenAI(api_key=os.environ["OPENAI_API_KEY"], max_retries=0).chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": "hi"}])\n',
    "anthropic": 'import os\nimport anthropic\nanthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"], max_retries=0).messages.create(model="claude-haiku-4-5-20251001", max_tokens=8, messages=[{"role": "user", "content": "hi"}])\n',
    "gemini": 'import os\nfrom google import genai\nclient = genai.Client(api_key=os.environ["GEMINI_API_KEY"])\nclient.models.generate_content(model="gemini-3.8-flash", contents="hi")\n',
}


def _proxied(internet) -> dict[str, str]:
    """Every outbound HTTP(S) call from the subprocess goes to `internet`; NO_PROXY is emptied so no provider host is exempt."""
    return {"HTTP_PROXY": internet.url, "HTTPS_PROXY": internet.url, "NO_PROXY": ""}


@pytest.mark.parametrize(("provider", "field"), SNIPPETS, ids=SNIPPET_IDS)
def test_a_missing_base_url_stops_every_snippet_and_never_sends_the_virtual_key_to_a_provider_host(
    provider, field, tmp_path, make_live_key, internet
):
    key = make_live_key(allowed_providers=ALL)["key"]
    key_var, _ = _names(provider)
    proxied = _proxied(internet)

    # control: handed only the key, the SDK DOES head for the provider — the listener sees it
    (tmp_path / "naive.py").write_text(NAIVE[provider])
    subprocess.run([sys.executable, "naive.py"], cwd=tmp_path, env=_clean_env({**proxied, key_var: key}),
                   capture_output=True, text=True, timeout=120)
    assert internet.settled() > 0, "control failed: the listener cannot see provider-bound traffic"
    before = internet.count

    # the dashboard snippet, with a .env that has the key but NOT the URL
    project = tmp_path / "project"
    _project(project, provider, None, key, field)
    r = _run_snippet(project, _clean_env(proxied))
    assert r.returncode != 0 and "RuntimeError" in r.stderr
    assert _message(provider, "url") in r.stderr  # names exactly what is missing
    assert key not in r.stdout + r.stderr
    assert internet.settled() == before  # no connection attempted at all


@pytest.mark.parametrize(("provider", "field"), SNIPPETS, ids=SNIPPET_IDS)
def test_a_missing_key_also_stops_the_snippet(provider, field, tmp_path, live_server):
    _project(tmp_path, provider, live_server, None, field)
    r = _run_snippet(tmp_path, _clean_env({}))
    assert r.returncode != 0 and "RuntimeError" in r.stderr and _message(provider, "key") in r.stderr


@pytest.mark.parametrize(("provider", "field"), OPENAI_SNIPPETS, ids=OPENAI_IDS)
def test_real_environment_variables_win_over_dotenv_values(
    provider, field, tmp_path, live_server, make_live_key, admin_client, fake_providers
):
    """What a platform-injected configuration relies on: the .env holds a different key and a dead URL, the real
    environment holds the working ones — and the real environment is what is used."""
    key = make_live_key(allowed_providers=ALL, label="platform-injected")["key"]
    project = tmp_path / "project"
    _project(project, "openai", "http://127.0.0.1:1", "vk_FROM_DOTENV_FILE_UNUSED", field)  # dead port 1: unusable
    env = _clean_env({"OPENAI_API_KEY": key, "OPENAI_BASE_URL": integration.setup_for("openai", live_server)["base_url"]})
    r = _run_snippet(project, env)
    assert r.returncode == 0, r.stderr
    (row,) = _rows(admin_client)
    assert (row["key_label"], row["provider"], row["status"]) == ("platform-injected", "openai", "success")
    (url, headers, body), = fake_providers.calls
    assert key not in json.dumps([headers, body]) and "FROM_DOTENV" not in json.dumps([headers, body])


@pytest.mark.parametrize(("provider", "field"), OPENAI_SNIPPETS, ids=OPENAI_IDS)
@pytest.mark.parametrize("where", ["environment", "dotenv"])
def test_a_real_looking_provider_key_is_refused_before_any_request_and_never_echoed(
    provider, field, where, tmp_path, live_server, make_live_key, fake_providers, internet
):
    """The point of the guard: an sk-... key — exported in the shell (it wins over .env) or written into .env —
    can never be sent to the gateway. Dummy values only."""
    good = make_live_key(allowed_providers=ALL)["key"]
    real_looking = "sk-AMBIENT-REAL-OPENAI-KEY-0123456789"
    project = tmp_path / "project"
    _project(project, "openai", live_server, real_looking if where == "dotenv" else good, field)
    extra = {"OPENAI_API_KEY": real_looking} if where == "environment" else {}

    r = _run_snippet(project, _clean_env({**_proxied(internet), **extra}))
    assert r.returncode != 0 and "RuntimeError" in r.stderr
    assert "is not a gateway virtual key" in r.stderr and "unset it" in r.stderr  # actionable
    assert real_looking not in r.stdout + r.stderr and good not in r.stdout + r.stderr  # never printed
    assert fake_providers.calls == []  # the gateway was never reached...
    assert internet.settled() == 0  # ...and neither was any other host


def test_the_declared_sdk_minimums_are_versions_this_suite_actually_ran():
    """The floors in requirements.txt and the dashboard's install lines are tested versions, not guesses:
    the installed packages (which every test in this module just used) must satisfy them."""
    declared = {}
    for line in (HELPER_DIR / "requirements.txt").read_text().splitlines():
        if line.strip() and not line.startswith("#"):
            name, _, floor = line.strip().partition(">=")
            declared[name] = floor
    assert declared == integration.SDK_FLOORS
    for name, floor in declared.items():
        assert Version(metadata.version(name)) >= Version(floor), f"{name} {metadata.version(name)} < declared {floor}"
    for provider, sdk in (("openai", "openai"), ("anthropic", "anthropic"), ("gemini", "google-genai")):
        install = integration.setup_for(provider, "https://gw.example.com")["install"]
        assert f'"{sdk}>={integration.SDK_FLOORS[sdk]}"' in install


@pytest.mark.parametrize("provider", ALL)
def test_the_shared_helper_examples_run_unchanged_and_the_request_id_matches_where_the_provider_has_one(
    provider, tmp_path, live_server, make_live_key, admin_client, fake_providers
):
    key = make_live_key(allowed_providers=ALL)["key"]
    script = f"{provider}_example.py"
    r = subprocess.run([sys.executable, str(HELPER_DIR / script)], cwd=tmp_path, capture_output=True, text=True, timeout=120,
                       env=_clean_env({"LLM_GATEWAY_KEY": key, "LLM_GATEWAY_URL": live_server}))
    assert r.returncode == 0, r.stderr
    assert "reply:   Hello there, nice to meet you" in r.stdout and "tokens:  20" in r.stdout
    (row,) = _rows(admin_client)
    if provider != "gemini":  # Gemini responses carry no id the gateway can reuse
        printed_id = next(line.split(":", 1)[1].strip() for line in r.stdout.splitlines() if line.startswith("id:"))
        assert row["request_id"] == printed_id


@pytest.mark.parametrize("suffix", ["", "/", "/v1", "/v1beta"])
@pytest.mark.parametrize("provider", ALL)
def test_a_pasted_url_suffix_still_reaches_the_right_route_on_the_real_gateway(
    provider, suffix, live_server, make_live_key, fake_providers, monkeypatch
):
    helper = _load_helper()
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    monkeypatch.setenv("LLM_GATEWAY_KEY", make_live_key(allowed_providers=ALL)["key"])
    monkeypatch.setenv("LLM_GATEWAY_URL", live_server + suffix)
    _call(provider, helper)
    assert fake_providers.calls[-1][0] == UPSTREAM[provider][0]


def _call(provider: str, helper, **options):
    """One minimal request via the helper's client for `provider`."""
    if provider == "openai":
        return helper.openai_client(**options).chat.completions.create(
            model="openai/gpt-4o-mini", messages=[{"role": "user", "content": "hi"}], max_tokens=5)
    if provider == "anthropic":
        return helper.anthropic_client(**options).messages.create(
            model="claude-haiku-4-5-20251001", max_tokens=5, messages=[{"role": "user", "content": "hi"}])
    client = helper.gemini_client(**options)  # keep the reference
    return client.models.generate_content(model="gemini-3.8-flash", contents="hi")


def _status(exc: Exception) -> int:
    return exc.code if isinstance(exc, genai_errors.APIError) else exc.status_code


def _detail_type(exc: Exception):
    """The gateway's own error type (key_paused, model_not_allowed, ...) from whichever SDK exception."""
    body = exc.details if isinstance(exc, genai_errors.APIError) else exc.body
    detail = body.get("detail") if isinstance(body, dict) else None
    return detail.get("type") if isinstance(detail, dict) else detail


# ----------------------------------------------------------------------------- permissions + revocation, unchanged


@pytest.fixture()
def gw(live_server, monkeypatch, fake_providers):
    """The helper pointed at the real gateway; each test supplies the virtual key."""
    helper = _load_helper()
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    monkeypatch.setenv("LLM_GATEWAY_URL", live_server)

    def use(key: str):
        monkeypatch.setenv("LLM_GATEWAY_KEY", key)
        return helper

    return use


def _expect(provider, helper, status, detail_type=None):
    with pytest.raises((openai.APIStatusError, anthropic.APIStatusError, genai_errors.APIError)) as exc:
        _call(provider, helper, **({"max_retries": 0} if provider != "gemini" else {}))
    assert _status(exc.value) == status, str(exc.value)[:200]
    if detail_type:
        assert _detail_type(exc.value) == detail_type, str(exc.value)[:200]


@pytest.mark.parametrize("provider", ALL)
def test_a_key_only_works_for_its_enabled_providers(provider, gw, make_live_key, fake_providers):
    others = [p for p in ALL if p != provider]
    key = make_live_key(allowed_providers=others)["key"]  # everything EXCEPT this provider
    _expect(provider, gw(key), 403)
    assert fake_providers.calls == []  # rejected before any provider call


@pytest.mark.parametrize("provider", ALL)
def test_a_paused_key_is_refused(provider, gw, make_live_key, fake_providers):
    key = make_live_key(allowed_providers=ALL, allow_live=False)["key"]
    _expect(provider, gw(key), 403, "key_paused")
    assert fake_providers.calls == []


@pytest.mark.parametrize("provider", ALL)
def test_a_missing_workspace_credential_is_a_402(provider, gw, make_live_key, admin_client, fake_providers):
    key = make_live_key(allowed_providers=ALL)["key"]  # minted while the credential exists (else it is born paused)
    admin_client.delete(f"/api/workspace/providers/{provider}/key")
    _expect(provider, gw(key), 402, "provider_not_configured")
    assert fake_providers.calls == []


@pytest.mark.parametrize("provider", ALL)
def test_a_model_outside_the_keys_allow_list_is_refused(provider, gw, make_live_key, fake_providers):
    key = make_live_key(allowed_providers=ALL, allowed_models={provider: ["some-other-model"]})["key"]
    _expect(provider, gw(key), 403, "model_not_allowed")
    assert fake_providers.calls == []


@pytest.mark.parametrize("provider", ALL)
def test_revoking_a_key_stops_it_immediately(provider, gw, make_live_key, admin_client, fake_providers):
    minted = make_live_key(allowed_providers=ALL)
    helper = gw(minted["key"])
    _call(provider, helper)  # works while the key is live
    assert len(fake_providers.calls) == 1
    assert admin_client.delete(f"/api/keys/{minted['id']}").status_code == 200
    _expect(provider, helper, 401)
    assert len(fake_providers.calls) == 1  # the revoked key reached no provider


def test_an_unknown_key_is_a_401_for_every_sdk(gw, fake_providers):
    helper = gw("vk_this_key_was_never_issued")
    for provider in ALL:
        _expect(provider, helper, 401)
    assert fake_providers.calls == []


# ----------------------------------------------------------------------------- the zero-cost readiness check


def test_check_gateway_reports_per_provider_readiness_without_a_provider_call(gw, make_live_key, admin_client, fake_providers):
    key = make_live_key(allowed_providers=["openai", "anthropic"])["key"]
    admin_client.delete("/api/workspace/providers/anthropic/key")  # the workspace loses its Anthropic credential
    info = gw(key).check_gateway()
    assert info["allow_live"] is True
    assert {p["provider"]: p["ready"] for p in info["providers"]} == {"openai": True, "anthropic": False}
    assert fake_providers.calls == []  # it only authenticated: no provider call, no cost
    assert _rows(admin_client) == []


# ----------------------------------------------------------------------------- the default URLs


def test_the_helper_and_the_backend_agree_on_the_hosted_url_and_on_url_normalization():
    helper = _load_helper()
    assert helper.DEFAULT_GATEWAY_URL == settings.GATEWAY_PUBLIC_URL
    for raw in ("https://gw.example.com", "https://gw.example.com/v1/", "http://127.0.0.1:8000/v1beta", "https://h.example.com/p/v1"):
        assert helper.normalize_root(raw) == integration.normalize_root(raw)
