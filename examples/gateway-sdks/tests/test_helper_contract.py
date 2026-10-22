"""Contract tests for the shared helper and the three examples. No real gateway and no provider call:
each example runs UNCHANGED as a subprocess against a local stand-in that speaks the provider's wire
format, so these prove the CLIENT side — the URL form, the auth header, and key hygiene — per SDK.

Mocked/local only. The same snippets are executed against the real gateway code (with the provider
mocked) by backend/tests/test_sdk_integrations.py; neither suite makes a real provider request.
"""

import ast
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

PROJECT = Path(__file__).resolve().parents[1]
HOSTED = "https://llm-usage-tracker-97q0.onrender.com"
SCRIPTS = ("gateway_client.py", "openai_example.py", "anthropic_example.py", "gemini_example.py", "check_connection.py")

OPENAI_BODY = {
    "id": "chatcmpl-contract-1", "object": "chat.completion", "created": 1, "model": "gpt-4o-mini-2024-07-18",
    "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hello there, nice to meet you"}, "finish_reason": "stop"}],
    "usage": {"prompt_tokens": 14, "completion_tokens": 6, "total_tokens": 20},
}
ANTHROPIC_BODY = {
    "id": "msg_contract_1", "type": "message", "role": "assistant", "model": "claude-haiku-4-5-20251001",
    "content": [{"type": "text", "text": "Hello there, nice to meet you"}], "stop_reason": "end_turn", "stop_sequence": None,
    "usage": {"input_tokens": 14, "output_tokens": 6},
}
GEMINI_BODY = {
    "candidates": [{"content": {"role": "model", "parts": [{"text": "Hello there, nice to meet you"}]}, "finishReason": "STOP", "index": 0}],
    "usageMetadata": {"promptTokenCount": 14, "candidatesTokenCount": 6, "totalTokenCount": 20}, "modelVersion": "gemini-3.8-flash",
}
INSPECT_BODY = {"label": "dev-team", "allow_live": True, "providers": [{"provider": "openai", "ready": True}, {"provider": "anthropic", "ready": False}]}


class FakeGateway:
    """A local stand-in that answers each provider's route with a valid response and records requests."""

    def __init__(self, inspect_status: int = 200) -> None:
        self.requests: list[dict] = []
        self.inspect_status = inspect_status
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _record(self, body=None):
                outer.requests.append({"method": self.command, "path": self.path,
                                       "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})

            def do_GET(self):
                self._record()
                if self.path == "/v1/proxy/inspect":
                    self._send(outer.inspect_status, INSPECT_BODY if outer.inspect_status == 200 else {"detail": "invalid or revoked virtual key"})
                else:
                    self._send(404, {"detail": "Not Found"})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
                self._record(body)
                if self.path == "/v1/chat/completions":
                    self._send(200, OPENAI_BODY)
                elif self.path == "/v1/messages":
                    self._send(200, ANTHROPIC_BODY)
                elif self.path.endswith(":generateContent"):
                    self._send(200, GEMINI_BODY)
                else:
                    self._send(404, {"detail": "Not Found"})

        self.httpd = HTTPServer(("127.0.0.1", 0), Handler)

    @property
    def root(self) -> str:
        return f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def __enter__(self):
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()


_SCRUB = ("OPENAI_", "ANTHROPIC_", "GOOGLE_", "GEMINI_", "LLM_GATEWAY_", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY")


def workdir(tmp: Path) -> Path:
    tmp.mkdir(parents=True, exist_ok=True)
    for name in SCRIPTS:
        shutil.copy(PROJECT / name, tmp / name)
    return tmp


def run(script: str, env: dict[str, str], cwd: Path) -> subprocess.CompletedProcess:
    """Run a script from `cwd` with a CLEAN provider/gateway environment plus exactly `env`."""
    base = {k: v for k, v in os.environ.items() if not k.upper().startswith(_SCRUB)}
    base["NO_PROXY"] = "127.0.0.1,localhost"
    return subprocess.run([sys.executable, str(cwd / script)], env={**base, **env}, cwd=cwd,
                          capture_output=True, text=True, timeout=120, check=False)  # callers assert on returncode


def load_helper():
    spec = importlib.util.spec_from_file_location("gateway_client_under_test", PROJECT / "gateway_client.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


KEY = "vk_contract_test_key_0001"


# ------------------------------------------------------------------ each SDK's wire format, via the helper

CASES = [
    # script, path the SDK must hit, header carrying the key, header value, how a pasted URL may end
    ("openai_example.py", "/v1/chat/completions", "authorization", f"Bearer {KEY}"),
    ("anthropic_example.py", "/v1/messages", "x-api-key", KEY),
    ("gemini_example.py", "/v1beta/models/gemini-3.8-flash:generateContent", "x-goog-api-key", KEY),
]


@pytest.mark.parametrize(("script", "path", "header", "value"), CASES)
def test_each_example_hits_its_providers_route_with_its_providers_auth_header(tmp_path, script, path, header, value):
    with FakeGateway() as gw:
        r = run(script, {"LLM_GATEWAY_KEY": KEY, "LLM_GATEWAY_URL": gw.root}, workdir(tmp_path))
    assert r.returncode == 0, r.stderr
    assert len(gw.requests) == 1
    req = gw.requests[0]
    assert (req["method"], req["path"]) == ("POST", path)
    assert req["headers"][header] == value
    assert "reply:   Hello there, nice to meet you" in r.stdout
    assert "tokens:  20" in r.stdout


def test_anthropic_sends_its_required_headers_and_max_tokens(tmp_path):
    with FakeGateway() as gw:
        run("anthropic_example.py", {"LLM_GATEWAY_KEY": KEY, "LLM_GATEWAY_URL": gw.root}, workdir(tmp_path))
    req = gw.requests[0]
    assert req["headers"]["anthropic-version"] and req["body"]["max_tokens"] == 64


@pytest.mark.parametrize("suffix", ["", "/", "/v1", "/v1/", "/v1beta"])
@pytest.mark.parametrize(("script", "path", "header", "value"), CASES)
def test_a_pasted_v1_or_v1beta_suffix_is_corrected_per_sdk(tmp_path, script, path, header, value, suffix):
    """The raw SDKs double-prefix these (/v1/v1/messages, /v1beta/v1beta/...) — the helper must not."""
    with FakeGateway() as gw:
        r = run(script, {"LLM_GATEWAY_KEY": KEY, "LLM_GATEWAY_URL": gw.root + suffix}, workdir(tmp_path))
    assert r.returncode == 0, r.stderr
    assert gw.requests[0]["path"] == path


# ------------------------------------------------------------------ key hygiene


AMBIENT = {
    "OPENAI_API_KEY": "sk-AMBIENT-REAL-OPENAI-KEY", "OPENAI_BASE_URL": "http://127.0.0.1:1/v1",
    "ANTHROPIC_API_KEY": "sk-ant-AMBIENT-REAL-KEY", "ANTHROPIC_BASE_URL": "http://127.0.0.1:1",
    "GOOGLE_API_KEY": "AIza-AMBIENT-REAL-GOOGLE-KEY", "GEMINI_API_KEY": "AIza-AMBIENT-REAL-GEMINI-KEY",
    "GOOGLE_GEMINI_BASE_URL": "http://127.0.0.1:1",
}


@pytest.mark.parametrize(("script", "path", "header", "value"), CASES)
def test_ambient_provider_keys_on_the_machine_never_reach_the_gateway(tmp_path, script, path, header, value):
    """The failure the explicit-argument design exists to prevent: a developer already has a REAL
    provider key (and even a base URL) in their shell. The helper must ignore all of it."""
    with FakeGateway() as gw:
        r = run(script, {**AMBIENT, "LLM_GATEWAY_KEY": KEY, "LLM_GATEWAY_URL": gw.root}, workdir(tmp_path))
    assert r.returncode == 0, r.stderr
    assert len(gw.requests) == 1 and gw.requests[0]["path"] == path
    assert gw.requests[0]["headers"][header] == value  # the virtual key won
    wire = json.dumps(gw.requests[0])
    assert "AMBIENT" not in wire  # no ambient secret anywhere in the request the gateway received


def test_an_ambient_anthropic_auth_token_is_not_sent_either(tmp_path):
    """anthropic also reads ANTHROPIC_AUTH_TOKEN (sent as `Authorization: Bearer`), which the gateway would
    read BEFORE x-api-key. Verified separately because it is a second ambient credential path."""
    with FakeGateway() as gw:
        r = run("anthropic_example.py", {"ANTHROPIC_AUTH_TOKEN": "AMBIENT-AUTH-TOKEN",
                                         "LLM_GATEWAY_KEY": KEY, "LLM_GATEWAY_URL": gw.root}, workdir(tmp_path))
    assert r.returncode == 0, r.stderr
    sent = gw.requests[0]["headers"]
    assert "AMBIENT" not in json.dumps(sent)
    assert sent["x-api-key"] == KEY


@pytest.mark.parametrize(
    ("key_line", "expected"),
    [
        ("", "LLM_GATEWAY_KEY is not set"),
        ("LLM_GATEWAY_KEY=vk_...your-virtual-key...", "placeholder"),
        ("LLM_GATEWAY_KEY=sk-FAKE-PROVIDER-VALUE-0123456789", "not a gateway virtual key"),
        ("LLM_GATEWAY_KEY=AIzaFAKE-GOOGLE-VALUE-0123456789", "not a gateway virtual key"),
    ],
)
def test_anything_but_a_virtual_key_is_refused_and_never_echoed(tmp_path, key_line, expected):
    d = workdir(tmp_path)
    (d / ".env").write_text(key_line + "\n")
    r = run("openai_example.py", {}, d)
    assert r.returncode != 0
    assert expected in r.stderr
    assert "FAKE-PROVIDER-VALUE" not in r.stdout + r.stderr and "FAKE-GOOGLE-VALUE" not in r.stdout + r.stderr


# ------------------------------------------------------------------ rotate a key / switch gateways with no code change


def test_rotating_the_key_is_a_one_line_change(tmp_path):
    d = workdir(tmp_path)
    with FakeGateway() as gw:
        (d / ".env").write_text(f"LLM_GATEWAY_KEY=vk_old_key_00000001\nLLM_GATEWAY_URL={gw.root}\n")
        assert run("openai_example.py", {}, d).returncode == 0
        (d / ".env").write_text(f"LLM_GATEWAY_KEY=vk_new_key_00000002\nLLM_GATEWAY_URL={gw.root}\n")  # the only edit
        assert run("openai_example.py", {}, d).returncode == 0
    assert [r["headers"]["authorization"] for r in gw.requests] == ["Bearer vk_old_key_00000001", "Bearer vk_new_key_00000002"]


@pytest.mark.parametrize(("script", "path", "header", "value"), CASES)
def test_switching_between_local_and_hosted_needs_no_code_change(tmp_path, script, path, header, value):
    d = workdir(tmp_path)
    before = hashlib.sha256((d / script).read_bytes()).hexdigest()
    with FakeGateway() as hosted_standin, FakeGateway() as local:
        assert run(script, {"LLM_GATEWAY_KEY": KEY, "LLM_GATEWAY_URL": hosted_standin.root}, d).returncode == 0
        assert run(script, {"LLM_GATEWAY_KEY": KEY, "LLM_GATEWAY_URL": local.root}, d).returncode == 0
    assert len(hosted_standin.requests) == 1 and len(local.requests) == 1
    assert hosted_standin.requests[0]["path"] == local.requests[0]["path"] == path
    assert hashlib.sha256((d / script).read_bytes()).hexdigest() == before  # the script itself never changed


def test_the_hosted_gateway_is_the_default_and_local_is_one_variable_away(monkeypatch):
    helper = load_helper()
    monkeypatch.delenv("LLM_GATEWAY_URL", raising=False)
    assert helper.DEFAULT_GATEWAY_URL == HOSTED
    assert helper.gateway_root() == HOSTED
    monkeypatch.setenv("LLM_GATEWAY_URL", "http://127.0.0.1:8000/v1")
    assert helper.gateway_root() == "http://127.0.0.1:8000"
    for bad in ("not a url", "ftp://x", "https://u:p@host"):
        monkeypatch.setenv("LLM_GATEWAY_URL", bad)
        with pytest.raises(helper.GatewayConfigError):
            helper.gateway_root()


# ------------------------------------------------------------------ .env handling


def test_dotenv_in_the_working_directory_is_used_and_the_real_environment_wins(tmp_path):
    d = workdir(tmp_path)
    with FakeGateway() as from_file, FakeGateway() as from_env:
        (d / ".env").write_text(f"LLM_GATEWAY_KEY={KEY}\nLLM_GATEWAY_URL={from_file.root}\n")
        assert run("openai_example.py", {}, d).returncode == 0
        assert run("openai_example.py", {"LLM_GATEWAY_URL": from_env.root}, d).returncode == 0
    assert len(from_file.requests) == 1 and len(from_env.requests) == 1


def test_a_parent_directorys_dotenv_is_never_read(tmp_path):
    with FakeGateway() as target:
        (tmp_path / ".env").write_text(f"LLM_GATEWAY_KEY={KEY}\nLLM_GATEWAY_URL={target.root}\n")
        r = run("openai_example.py", {}, workdir(tmp_path / "child"))
    assert r.returncode != 0 and "LLM_GATEWAY_KEY is not set" in r.stderr
    assert target.requests == []


# ------------------------------------------------------------------ zero-cost readiness check


def test_check_connection_reports_readiness_without_printing_the_key(tmp_path):
    with FakeGateway() as gw:
        r = run("check_connection.py", {"LLM_GATEWAY_KEY": KEY, "LLM_GATEWAY_URL": gw.root}, workdir(tmp_path))
    assert r.returncode == 0, r.stderr
    assert "'dev-team'" in r.stdout and "live calls: ON" in r.stdout
    assert "openai" in r.stdout and "ready" in r.stdout and "NO real credential" in r.stdout  # anthropic not ready
    assert KEY not in r.stdout + r.stderr
    assert [(q["method"], q["path"]) for q in gw.requests] == [("GET", "/v1/proxy/inspect")]  # no provider route touched


def test_check_connection_failure_is_clear_and_secret_free(tmp_path):
    with FakeGateway(inspect_status=401) as gw:
        r = run("check_connection.py", {"LLM_GATEWAY_KEY": KEY, "LLM_GATEWAY_URL": gw.root}, workdir(tmp_path))
    assert r.returncode == 1
    assert "HTTP 401" in r.stderr and "invalid or revoked virtual key" in r.stderr
    assert KEY not in r.stdout + r.stderr


# ------------------------------------------------------------------ the examples contain no configuration


def test_examples_hold_no_url_key_or_client_option():
    for name in ("openai_example.py", "anthropic_example.py", "gemini_example.py"):
        tree = ast.parse((PROJECT / name).read_text(encoding="utf-8"))
        doc = tree.body[0].value if isinstance(tree.body[0], ast.Expr) else None
        for n in ast.walk(tree):
            if isinstance(n, ast.Constant) and isinstance(n.value, str) and n is not doc:
                assert not any(bad in n.value.lower() for bad in ("http://", "https://", "vk_", "sk-")), (name, n.value)
            if isinstance(n, ast.Call):
                assert not {k.arg for k in n.keywords} & {"base_url", "api_key", "http_options", "default_headers"}, name


def test_the_helper_names_the_hosted_url_exactly_once():
    text = (PROJECT / "gateway_client.py").read_text(encoding="utf-8")
    assert text.count("onrender.com") == 1
