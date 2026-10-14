"""The developer-integration guide (app/integration.py + GET /api/integration): URL derivation per SDK,
exact variable names, a single configuration source for the gateway URL, and never a real key.

The *snippets themselves* are executed against the real SDKs and gateway in test_sdk_integrations.py;
these tests pin the generator's contract and the endpoint's behavior."""

import re
from pathlib import Path

import pytest

from app import integration
from app.config import Settings, settings

HOSTED = "https://llm-usage-tracker-97q0.onrender.com"  # the gateway URL the product owner specified
APP_DIR = Path(__file__).resolve().parents[1] / "app"
REAL_LOOKING_KEY = re.compile(r"vk_[A-Za-z0-9_-]{8,}")


# ------------------------------------------------------------------ normalize_root


@pytest.mark.parametrize(
    ("raw", "root"),
    [
        ("https://gw.example.com", "https://gw.example.com"),
        ("https://gw.example.com/", "https://gw.example.com"),
        ("https://gw.example.com/v1", "https://gw.example.com"),  # the OpenAI-style URL a person pastes
        ("https://gw.example.com/v1/", "https://gw.example.com"),
        ("https://gw.example.com/v1beta", "https://gw.example.com"),
        ("  http://127.0.0.1:8000  ", "http://127.0.0.1:8000"),
        ("https://host.example.com/prefix/v1", "https://host.example.com/prefix"),  # path-prefixed mount kept
    ],
)
def test_normalize_root(raw, root):
    assert integration.normalize_root(raw) == root


@pytest.mark.parametrize("bad", ["", "gw.example.com", "ftp://gw.example.com", "https://u:p@gw.example.com", "http://"])
def test_normalize_root_rejects(bad):
    with pytest.raises(ValueError):
        integration.normalize_root(bad)


# ------------------------------------------------------------------ per-provider contract (measured against the real SDKs)


def test_openai_needs_root_plus_v1():
    s = integration.setup_for("openai", "https://gw.example.com")
    assert s["base_url"] == "https://gw.example.com/v1"
    assert [(e["name"], e["value"]) for e in s["env_vars"]] == [
        ("OPENAI_API_KEY", "vk_..."),
        ("OPENAI_BASE_URL", "https://gw.example.com/v1"),
    ]
    assert s["endpoint"] == "POST https://gw.example.com/v1/chat/completions"


def test_anthropic_needs_the_root_without_v1():
    s = integration.setup_for("anthropic", "https://gw.example.com/v1")  # a pasted /v1 must be corrected
    assert s["base_url"] == "https://gw.example.com"
    assert [(e["name"], e["value"]) for e in s["env_vars"]] == [
        ("ANTHROPIC_API_KEY", "vk_..."),
        ("ANTHROPIC_BASE_URL", "https://gw.example.com"),
    ]
    assert s["endpoint"] == "POST https://gw.example.com/v1/messages"
    assert any("/v1/v1/messages" in n for n in s["notes"])  # the documented failure mode
    assert any("max_tokens" in n for n in s["notes"])


def test_gemini_needs_the_root_and_an_explicit_key():
    s = integration.setup_for("gemini", "https://gw.example.com/v1beta")
    assert s["base_url"] == "https://gw.example.com"
    assert [(e["name"], e["value"]) for e in s["env_vars"]] == [
        ("GEMINI_API_KEY", "vk_..."),
        ("GOOGLE_GEMINI_BASE_URL", "https://gw.example.com"),
    ]
    assert s["endpoint"] == "POST https://gw.example.com/v1beta/models/<model>:generateContent"
    assert 'api_key=os.environ["GEMINI_API_KEY"]' in s["code"]  # GOOGLE_API_KEY would otherwise win
    assert any("GOOGLE_API_KEY" in n for n in s["notes"])


@pytest.mark.parametrize("provider", integration.PROVIDERS)
def test_every_setup_is_complete_and_secret_free(provider):
    s = integration.setup_for(provider, "https://gw.example.com")
    for field in ("label", "sdk", "install", "gateway_url", "base_url", "endpoint", "env_file", "code", "model_example"):
        assert s[field], field
    assert "vk_..." in s["env_file"] and s["env_vars"][0]["value"] == "vk_..."
    assert not REAL_LOOKING_KEY.search(s["env_file"] + s["code"] + " ".join(s["notes"]))
    assert "sk-" not in s["env_file"] + s["code"]  # never invites a provider key
    assert len(s["requirements"]) == 4 and provider in s["requirements"][0]
    assert any("never put it in your application" in r for r in s["requirements"])
    assert "load_dotenv" in s["code"] and s["env_vars"][0]["name"] in s["code"] + s["env_file"]


@pytest.mark.parametrize("provider", integration.PROVIDERS)
def test_every_snippet_loads_only_the_project_env_and_passes_key_and_url_explicitly(provider):
    s = integration.setup_for(provider, "https://gw.example.com")
    code = s["code"]
    key_var, url_var = (e["name"] for e in s["env_vars"])
    assert 'load_dotenv(Path.cwd() / ".env", override=True)' in code
    assert "load_dotenv(override=True)" not in code  # the form that walks up parent directories
    assert f'api_key=os.environ["{key_var}"]' in code and f'os.environ["{url_var}"]' in code
    # fails closed, naming the missing variable, BEFORE the SDK client is built (so no provider host is contacted)
    assert f'("{key_var}", "{url_var}")' in code and "raise RuntimeError" in code
    assert code.index("raise RuntimeError") < code.index("client = ")
    assert "Path.cwd()" in " ".join(s["notes"]) or "never a parent" in " ".join(s["notes"])


@pytest.mark.parametrize("provider,sdk", [("openai", "openai"), ("anthropic", "anthropic"), ("gemini", "google-genai")])
def test_install_lines_carry_the_tested_sdk_minimums(provider, sdk):
    install = integration.setup_for(provider, "https://gw.example.com")["install"]
    assert f'"{sdk}>={integration.SDK_FLOORS[sdk]}"' in install
    assert f'"python-dotenv>={integration.SDK_FLOORS["python-dotenv"]}"' in install


def test_unknown_provider_is_rejected():
    with pytest.raises(ValueError):
        integration.setup_for("cohere", "https://gw.example.com")


# ------------------------------------------------------------------ one configuration source


def test_the_hosted_gateway_url_default_is_the_one_the_owner_specified():
    assert Settings.model_fields["GATEWAY_PUBLIC_URL"].default == HOSTED
    s = integration.setup_for("openai", Settings.model_fields["GATEWAY_PUBLIC_URL"].default)
    assert s["base_url"] == HOSTED + "/v1"  # exactly https://llm-usage-tracker-97q0.onrender.com/v1


def test_the_hosted_url_lives_in_exactly_one_backend_file():
    """'Avoid hardcoding it throughout backend application logic': only config.py may name the host."""
    hits = [p.name for p in APP_DIR.rglob("*.py") if "onrender.com" in p.read_text(encoding="utf-8")]
    assert hits == ["config.py"], hits


def test_the_urls_are_configurable_without_code_changes(monkeypatch):
    monkeypatch.setattr(settings, "GATEWAY_PUBLIC_URL", "https://staging.example.com/v1")
    guide = integration.build_guide(settings.GATEWAY_PUBLIC_URL, settings.GATEWAY_LOCAL_URL, "hosted")
    assert guide["gateway_url"] == "https://staging.example.com"
    assert {p["provider"]: p["base_url"] for p in guide["providers"]} == {
        "openai": "https://staging.example.com/v1",
        "anthropic": "https://staging.example.com",
        "gemini": "https://staging.example.com",
    }


def test_local_and_hosted_targets():
    hosted = integration.build_guide(HOSTED, "http://127.0.0.1:8000", "hosted")
    local = integration.build_guide(HOSTED, "http://127.0.0.1:8000", "local")
    assert (hosted["gateway_url"], local["gateway_url"]) == (HOSTED, "http://127.0.0.1:8000")
    assert hosted["targets"] == local["targets"] == {"hosted": HOSTED, "local": "http://127.0.0.1:8000"}
    assert local["providers"][0]["base_url"] == "http://127.0.0.1:8000/v1"
    with pytest.raises(ValueError):
        integration.build_guide(HOSTED, "http://127.0.0.1:8000", "staging")


def test_general_notes_say_what_the_product_requires():
    text = " ".join(integration.build_guide(HOSTED, "http://127.0.0.1:8000")["general_notes"])
    assert "does not redirect an SDK by itself" in text  # no pretending a key reroutes traffic
    assert "shown only once" in text and "never commit" in text.lower()
    assert "real provider credentials belong in the gateway workspace" in text.lower()


# ------------------------------------------------------------------ the endpoint


def test_guide_requires_a_signed_in_workspace_member(client):
    assert client.get("/api/integration").status_code == 401


def test_a_signed_in_user_without_a_workspace_is_refused(signup):
    c, _ = signup()
    assert c.get("/api/integration").status_code == 403


def test_the_endpoint_returns_all_three_providers_for_the_hosted_gateway(admin_client):
    r = admin_client.get("/api/integration")
    assert r.status_code == 200
    body = r.json()
    assert body["target"] == "hosted" and body["gateway_url"] == settings.GATEWAY_PUBLIC_URL
    assert [p["provider"] for p in body["providers"]] == ["openai", "anthropic", "gemini"]
    assert body["providers"][0]["base_url"] == settings.GATEWAY_PUBLIC_URL + "/v1"


def test_the_endpoint_switches_to_the_local_gateway(admin_client):
    body = admin_client.get("/api/integration", params={"target": "local"}).json()
    assert body["target"] == "local" and body["gateway_url"] == settings.GATEWAY_LOCAL_URL
    assert all(p["gateway_url"] == settings.GATEWAY_LOCAL_URL for p in body["providers"])


def test_an_invalid_target_is_rejected(admin_client):
    assert admin_client.get("/api/integration", params={"target": "prod"}).status_code == 422


def test_a_member_can_read_it_too(new_admin, new_member):
    admin_c, _ = new_admin()
    member_c, _ = new_member(admin_c)
    assert member_c.get("/api/integration").status_code == 200


def test_the_response_never_contains_a_real_key(admin_client, make_live_key):
    minted = make_live_key(allowed_providers=["openai", "anthropic", "gemini"])["key"]
    text = admin_client.get("/api/integration").text + admin_client.get("/api/integration?target=local").text
    assert minted not in text
    assert not REAL_LOOKING_KEY.search(text.replace("vk_...", ""))


def test_a_misconfigured_url_is_an_operator_error_not_a_crash(admin_client, monkeypatch):
    monkeypatch.setattr(settings, "GATEWAY_PUBLIC_URL", "not a url")
    r = admin_client.get("/api/integration")
    assert r.status_code == 500 and "gateway URL configuration is invalid" in r.json()["detail"]
