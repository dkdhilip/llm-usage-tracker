"""Developer-integration guide: the exact setup an app needs to talk to this gateway with the
official OpenAI, Anthropic or Gemini Python SDK.

Pure functions, no I/O — the one source of truth behind GET /api/integration (the dashboard's
"Connect your app" panel), and executed verbatim by tests/test_sdk_integrations.py against the
real SDKs and the real gateway code, so the copy-ready text cannot silently drift from what works.

Every URL form and variable name here was measured against the installed SDKs (not assumed):

  OpenAI     base URL = gateway root + /v1     the SDK appends /chat/completions
  Anthropic  base URL = gateway ROOT            the SDK appends /v1/messages itself
  Gemini     base URL = gateway ROOT            the SDK appends /v1beta/models/<m>:generateContent

Handing an SDK the wrong form double-prefixes the path (/v1/v1/messages, /v1beta/v1beta/...), which
is why `normalize_root` strips a pasted /v1 or /v1beta and each provider adds only what it needs.

A virtual key can NOT redirect an SDK on its own: the gateway URL must be configured in the
application (environment variables, a client option, or a shared helper) — nothing here intercepts
traffic. Snippets only ever contain the placeholder `vk_...`, never a real key.
"""

from string import Template
from urllib.parse import urlparse

PROVIDERS = ("openai", "anthropic", "gemini")
KEY_PLACEHOLDER = "vk_..."

# The SDK versions the snippets were actually run against (tests/test_sdk_integrations.py executes
# them verbatim and checks these floors against the installed packages). Older versions are untested.
SDK_FLOORS = {"openai": "3.29.0", "anthropic": "1.13.0", "google-genai": "2.30.0", "python-dotenv": "1.2.3"}


def _install(sdk: str) -> str:
    return f'pip install "{sdk}>={SDK_FLOORS[sdk]}" "python-dotenv>={SDK_FLOORS["python-dotenv"]}"'

_SUFFIXES = ("/v1beta", "/v1")  # longest first


def normalize_root(url: str) -> str:
    """The gateway ROOT from whatever a person pasted: no trailing slash, and a pasted /v1 or
    /v1beta stripped. Rejects anything that is not a plain http(s) URL without credentials."""
    text = (url or "").strip()
    parsed = urlparse(text)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("gateway URL must be a full http(s) URL, e.g. https://host")
    if parsed.username or parsed.password:
        raise ValueError("gateway URL must not contain credentials")
    path = parsed.path.rstrip("/")
    for suffix in _SUFFIXES:
        if path.endswith(suffix):
            path = path[: -len(suffix)]
            break
    return f"{parsed.scheme}://{parsed.netloc}{path}"


# ------------------------------------------------------------------------------ per-provider definitions

_OPENAI_EXPLICIT = Template(
    '''import os
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

# This project's .env only (the current directory's - never a parent's). Real environment variables win over it
# (the usual convention), so a value set by Docker, CI or your platform is never overridden.
load_dotenv(Path.cwd() / ".env")

# Fail closed BEFORE the client is built, so no request can reach a provider. The error never shows the key.
if not os.environ.get("OPENAI_API_KEY", "").startswith("vk_"):
    raise RuntimeError(
        "OPENAI_API_KEY is missing or is not a gateway virtual key (vk_...). Put your virtual key in .env; if a real "
        "OpenAI key is exported in your environment, unset it - real environment variables take precedence over .env."
    )
if not os.environ.get("OPENAI_BASE_URL"):
    raise RuntimeError(
        "OPENAI_BASE_URL is not set - add your gateway URL (ending in /v1) to .env. Without it the SDK would send "
        "your virtual key to api.openai.com."
    )

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"], base_url=os.environ["OPENAI_BASE_URL"])

response = client.chat.completions.create(
    model="openai/gpt-4o-mini",
    messages=[{"role": "user", "content": "Say hello in five words."}],
    max_tokens=20,
)
print(response.choices[0].message.content)
'''
)

_OPENAI = {
    "label": "OpenAI",
    "sdk": "openai (Python)",
    "intro": (
        "Already using the OpenAI SDK? You normally don't need to change your code. In your project's .env, "
        "replace your existing OPENAI_API_KEY with this virtual key and add OPENAI_BASE_URL — your existing "
        "client = OpenAI() code then talks to the gateway (see the note on model names). A virtual key alone does "
        "not redirect anything: OPENAI_BASE_URL is what points the SDK at the gateway."
    ),
    "install": _install("openai"),
    "url_suffix": "/v1",
    "env": [
        (
            "OPENAI_API_KEY",
            KEY_PLACEHOLDER,
            "REPLACES your existing OPENAI_API_KEY - your gateway VIRTUAL key, never a real OpenAI key",
        ),
        ("OPENAI_BASE_URL", "${root}/v1", "NEW - points the OpenAI SDK at the gateway: gateway root + /v1"),
    ],
    "endpoint": "POST ${root}/v1/chat/completions",
    "model": "openai/gpt-4o-mini",
    "code": Template(
        '''import os
from pathlib import Path

from dotenv import load_dotenv  # only needed if your app does not already load .env
from openai import OpenAI

# The SDK does NOT read .env itself: your app must load it (as here, or with your framework's settings loader),
# or the variables must already be set in the process environment (shell, container, CI, your platform).
# Real environment variables win over .env (the usual convention), so a value set by your platform is never overridden.
load_dotenv(Path.cwd() / ".env")

# Fail closed BEFORE the client exists, so no request can reach a provider. The error never shows the key.
if not os.environ.get("OPENAI_API_KEY", "").startswith("vk_"):
    raise RuntimeError(
        "OPENAI_API_KEY is missing or is not a gateway virtual key (vk_...). Put your virtual key in .env; if a real "
        "OpenAI key is exported in your environment, unset it - real environment variables take precedence over .env."
    )
if not os.environ.get("OPENAI_BASE_URL"):
    raise RuntimeError(
        "OPENAI_BASE_URL is not set - add your gateway URL (ending in /v1) to .env. Without it the SDK would send "
        "your virtual key to api.openai.com."
    )

client = OpenAI()  # reads OPENAI_API_KEY and OPENAI_BASE_URL - your existing code needs no change

response = client.chat.completions.create(
    model="openai/gpt-4o-mini",
    messages=[{"role": "user", "content": "Say hello in five words."}],
    max_tokens=20,
)
print(response.choices[0].message.content)
'''
    ),
    "alt_title": "3b. Alternative: explicit configuration (fails closed)",
    "alt_code": _OPENAI_EXPLICIT,
    "notes": [
        "Both variables are required: the virtual key authenticates you, and OPENAI_BASE_URL is what sends the "
        "request to the gateway. The base URL ends in /v1 — the SDK appends /chat/completions.",
        "Environment files are not magic: the OpenAI SDK never reads .env itself. Your application must load it "
        "(python-dotenv's load_dotenv(), or your framework's settings loader), or the variables must already be "
        "present in the process environment.",
        "Development versus production: real environment variables win over .env (the usual convention — it is "
        "what lets Docker, CI and your hosting platform configure production). Use .env for local development; in "
        "Docker, CI and production set OPENAI_API_KEY and OPENAI_BASE_URL in the platform and do not ship a .env file.",
        "Before creating the client, the snippet checks that OPENAI_API_KEY starts with vk_ and that OPENAI_BASE_URL "
        "is set, and stops with an error otherwise — so a real sk-… key exported in your shell, or a missing base "
        "URL, is caught before any request is made. The error never shows the key. If you load .env your own way, "
        "keep an equivalent check: the standard OpenAI() client cannot do this itself and would default to "
        "api.openai.com.",
        "Prefer to configure the client in code? The explicit alternative below passes api_key= and base_url= after "
        "the same checks; arguments passed in code take precedence over the environment.",
        "Model names: existing code that calls a bare model name such as gpt-4o-mini works only if the virtual key has "
        "a default provider (the default_provider field of the key API, set to openai). A key created from the "
        "dashboard has no default provider, so use the openai/ prefix (as in the examples, openai/gpt-4o-mini); "
        "without it the gateway answers 422 before any provider is contacted.",
    ],
}

_ANTHROPIC = {
    "label": "Anthropic",
    "sdk": "anthropic (Python)",
    "install": _install("anthropic"),
    "url_suffix": "",
    "env": [
        ("ANTHROPIC_API_KEY", KEY_PLACEHOLDER, "your gateway VIRTUAL key - never a real Anthropic key"),
        ("ANTHROPIC_BASE_URL", "${root}", "gateway ROOT - no /v1: the SDK adds /v1/messages itself"),
    ],
    "endpoint": "POST ${root}/v1/messages",
    "model": "claude-haiku-4-5-20251001",
    "code": Template(
        '''import os
from pathlib import Path

import anthropic
from dotenv import load_dotenv

# Only THIS project's .env (the current directory's - never a parent's); it wins over variables
# already set on your machine, so a real ANTHROPIC_API_KEY there is never used.
load_dotenv(Path.cwd() / ".env", override=True)

# Fail closed: with no base URL the SDK would send your key to api.anthropic.com.
missing = [n for n in ("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL") if not os.environ.get(n)]
if missing:
    raise RuntimeError(f"Missing {', '.join(missing)} - add it to .env (step 2) and run from this project's directory.")

client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"], base_url=os.environ["ANTHROPIC_BASE_URL"])

message = client.messages.create(
    model="claude-haiku-4-5-20251001",
    max_tokens=64,  # required by the Anthropic API
    messages=[{"role": "user", "content": "Say hello in five words."}],
)
print(message.content[0].text)
'''
    ),
    "notes": [
        "The base URL is the gateway ROOT. Ending it in /v1 makes the SDK post to /v1/v1/messages (404).",
        "Authentication is the SDK's normal x-api-key header carrying your virtual key; the gateway adds "
        "the real Anthropic key and the anthropic-version header itself.",
        "max_tokens is required by the Anthropic API.",
        "The snippet reads only this project's .env (from the directory you run in, never a parent's) and passes "
        "the key and base URL to the SDK explicitly. If either is missing it stops with an error instead of "
        "letting the SDK fall back to api.anthropic.com, which would send your virtual key to Anthropic.",
    ],
}

_GEMINI = {
    "label": "Gemini",
    "sdk": "google-genai (Python)",
    "install": _install("google-genai"),
    "url_suffix": "",
    "env": [
        ("GEMINI_API_KEY", KEY_PLACEHOLDER, "your gateway VIRTUAL key - never a real Google key"),
        ("GOOGLE_GEMINI_BASE_URL", "${root}", "gateway ROOT - no /v1beta: the SDK adds /v1beta/models/... itself"),
    ],
    "endpoint": "POST ${root}/v1beta/models/<model>:generateContent",
    "model": "gemini-2.5-flash",
    "code": Template(
        '''import os
from pathlib import Path

from dotenv import load_dotenv
from google import genai
from google.genai import types

# Only THIS project's .env (the current directory's - never a parent's); it wins over variables
# already set on your machine.
load_dotenv(Path.cwd() / ".env", override=True)

# Fail closed: with no base URL the SDK would send your key to generativelanguage.googleapis.com.
missing = [n for n in ("GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL") if not os.environ.get(n)]
if missing:
    raise RuntimeError(f"Missing {', '.join(missing)} - add it to .env (step 2) and run from this project's directory.")

# Key AND base URL are passed explicitly: if GOOGLE_API_KEY is set on your machine the SDK PREFERS it
# over GEMINI_API_KEY, and the base URL no longer depends on the SDK reading an environment variable.
client = genai.Client(
    api_key=os.environ["GEMINI_API_KEY"],
    http_options=types.HttpOptions(base_url=os.environ["GOOGLE_GEMINI_BASE_URL"]),
)  # keep a reference to the client

response = client.models.generate_content(model="gemini-2.5-flash", contents="Say hello in five words.")
print(response.text)
'''
    ),
    "notes": [
        "The base URL is the gateway ROOT. Ending it in /v1beta makes the SDK post to /v1beta/v1beta/... (404).",
        "Only the google-genai SDK is covered here. Authentication is its normal x-goog-api-key header "
        "carrying your virtual key.",
        "If GOOGLE_API_KEY is set, it silently overrides GEMINI_API_KEY — hence the explicit api_key in the snippet.",
        "The snippet reads only this project's .env (from the directory you run in, never a parent's) and passes "
        "the base URL explicitly too. If either variable is missing it stops with an error instead of letting the "
        "SDK fall back to generativelanguage.googleapis.com, which would send your virtual key to Google.",
        "Keep a reference to the client: the SDK closes its HTTP session when the client is garbage-collected.",
    ],
}

_DEFS = {"openai": _OPENAI, "anthropic": _ANTHROPIC, "gemini": _GEMINI}

_REQUIREMENTS = [
    "The provider ({provider}) is enabled for this virtual key.",
    "Live calls are on for the key (a paused key answers 403).",
    "The workspace has a real {label} credential (Workspace → Provider keys). It stays in the gateway — "
    "never put it in your application.",
    "The model is allowed: a key can carry a model allow-list, and a model outside it answers 403.",
]


def setup_for(provider: str, gateway_root: str) -> dict:
    """The complete, copy-ready setup for one provider against one gateway root."""
    if provider not in _DEFS:
        raise ValueError(f"unsupported provider {provider!r}; expected one of {PROVIDERS}")
    d = _DEFS[provider]
    root = normalize_root(gateway_root)
    sub = {"root": root}
    env = [
        {"name": n, "value": Template(v).substitute(sub), "comment": c} for n, v, c in d["env"]
    ]
    env_file = "\n".join(f"# {e['comment']}\n{e['name']}={e['value']}" for e in env)
    return {
        "provider": provider,
        "label": d["label"],
        "sdk": d["sdk"],
        "intro": d.get("intro", ""),
        "install": d["install"],
        "gateway_url": root,
        "base_url": root + d["url_suffix"],
        "endpoint": Template(d["endpoint"]).substitute(sub),
        "env_vars": env,
        "env_file": env_file,
        "code": d["code"].substitute(sub),
        "alt_title": d.get("alt_title", ""),
        "alt_code": d["alt_code"].substitute(sub) if "alt_code" in d else "",
        "model_example": d["model"],
        "notes": list(d["notes"]),
        "requirements": [r.format(provider=provider, label=d["label"]) for r in _REQUIREMENTS],
    }


_GENERAL_NOTES = [
    "A virtual key does not redirect an SDK by itself: your app must be configured with the gateway "
    "URL (the environment variables below, a client option, or a shared helper).",
    "A virtual key is shown only once, when it is created. These snippets use the placeholder "
    f"{KEY_PLACEHOLDER} — paste your key into your own .env.",
    "Add .env to .gitignore and never commit a key. Never put a real provider key in a client "
    "application — real provider credentials belong in the gateway workspace.",
]


def build_guide(public_url: str, local_url: str, target: str = "hosted") -> dict:
    """The payload behind GET /api/integration for the chosen target ("hosted" or "local")."""
    if target not in ("hosted", "local"):
        raise ValueError("target must be 'hosted' or 'local'")
    roots = {"hosted": normalize_root(public_url), "local": normalize_root(local_url)}
    root = roots[target]
    return {
        "target": target,
        "gateway_url": root,
        "targets": roots,
        "general_notes": list(_GENERAL_NOTES),
        "providers": [setup_for(p, root) for p in PROVIDERS],
    }
