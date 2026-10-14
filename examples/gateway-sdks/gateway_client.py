"""Shared gateway client helper — configure the LLM Usage Tracker gateway ONCE per project.

Copy this single file into a project (or put it on a shared path). Then:

    from gateway_client import openai_client, anthropic_client, gemini_client
    client = openai_client()          # or anthropic_client() / gemini_client()

Configuration lives in the project's own `.env` (git-ignored) — nothing machine-wide:

    LLM_GATEWAY_KEY=vk_...                       # the virtual key. Rotating a key = editing this line.
    LLM_GATEWAY_URL=http://127.0.0.1:8000        # optional: omit to use the hosted gateway

Design rules, each measured against the official SDKs (see README.md):
  * The key and URL are passed to each SDK EXPLICITLY. An SDK's own environment variables
    (OPENAI_API_KEY, GOOGLE_API_KEY, ANTHROPIC_AUTH_TOKEN ...) are therefore never consulted for
    them, so a real provider key already set on a developer's machine can neither override the
    virtual key nor be sent to the gateway.
  * The URL form differs per SDK and the helper applies it: OpenAI wants <root>/v1, while Anthropic
    and Gemini want the bare <root> (their SDKs add /v1/messages and /v1beta/... themselves).
    Pasting a URL that already ends in /v1 or /v1beta is fine — it is normalized.
  * Only a virtual key (vk_...) is accepted. A real provider key is refused, never sent.
"""

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv

# The hosted gateway. The ONE place this repo's examples name it; override per project with LLM_GATEWAY_URL.
DEFAULT_GATEWAY_URL = "https://llm-usage-tracker-97q0.onrender.com"

KEY_VAR = "LLM_GATEWAY_KEY"
URL_VAR = "LLM_GATEWAY_URL"

# Only the project's own .env, in the directory you run from — never a parent directory's. Real
# environment variables win over the file (the usual convention), so CI can inject the key.
load_dotenv(Path.cwd() / ".env")


class GatewayConfigError(RuntimeError):
    """A setup problem with a message a developer can act on. Never contains the key."""


def normalize_root(url: str) -> str:
    """The gateway ROOT: no trailing slash, and a pasted /v1 or /v1beta removed."""
    parsed = urlparse((url or "").strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise GatewayConfigError(f"{URL_VAR} must be a full http(s) URL, e.g. https://host")
    if parsed.username or parsed.password:
        raise GatewayConfigError(f"{URL_VAR} must not contain credentials")
    path = parsed.path.rstrip("/")
    for suffix in ("/v1beta", "/v1"):
        if path.endswith(suffix):
            path = path[: -len(suffix)]
            break
    return f"{parsed.scheme}://{parsed.netloc}{path}"


def gateway_root() -> str:
    return normalize_root(os.environ.get(URL_VAR) or DEFAULT_GATEWAY_URL)


def gateway_key() -> str:
    key = os.environ.get(KEY_VAR, "").strip()
    if not key:
        raise GatewayConfigError(f"{KEY_VAR} is not set — put your virtual key (vk_...) in .env")
    if "..." in key:
        raise GatewayConfigError(f"{KEY_VAR} is still the placeholder from .env.example — put your real virtual key in .env")
    if not key.startswith("vk_"):
        raise GatewayConfigError(
            f"{KEY_VAR} is not a gateway virtual key (those start with vk_). "
            "Never use a real provider key here — real provider credentials belong in the gateway workspace."
        )
    return key


def openai_client(**options):
    """openai.OpenAI pointed at the gateway: key + <root>/v1."""
    from openai import OpenAI

    return OpenAI(api_key=gateway_key(), base_url=gateway_root() + "/v1", **options)


def anthropic_client(**options):
    """anthropic.Anthropic pointed at the gateway: key + the bare root (the SDK adds /v1/messages)."""
    import anthropic

    return anthropic.Anthropic(api_key=gateway_key(), base_url=gateway_root(), **options)


def gemini_client(**options):
    """google.genai.Client pointed at the gateway: key + the bare root (the SDK adds /v1beta/...).
    Keep a reference to the returned client — the SDK closes its HTTP session when it is collected."""
    from google import genai
    from google.genai import types

    return genai.Client(api_key=gateway_key(), http_options=types.HttpOptions(base_url=gateway_root()), **options)


def check_gateway() -> dict:
    """Zero-cost readiness probe: authenticates the key against GET /v1/proxy/inspect and reports its
    label, whether live calls are on, and per provider whether the workspace holds a credential.
    Makes NO provider call, so it costs nothing."""
    request = urllib.request.Request(
        gateway_root() + "/v1/proxy/inspect", headers={"Authorization": f"Bearer {gateway_key()}"}
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:200]
        raise GatewayConfigError(f"the gateway answered HTTP {exc.code}: {detail}") from None
    except urllib.error.URLError as exc:
        raise GatewayConfigError(f"could not reach {gateway_root()}: {exc.reason}") from None
