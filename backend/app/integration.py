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

_OPENAI = {
    "label": "OpenAI",
    "sdk": "openai (Python)",
    "install": _install("openai"),
    "url_suffix": "/v1",
    "env": [
        ("OPENAI_API_KEY", KEY_PLACEHOLDER, "your gateway VIRTUAL key — never a real OpenAI key"),
        ("OPENAI_BASE_URL", "${root}/v1", "gateway root + /v1"),
    ],
    "endpoint": "POST ${root}/v1/chat/completions",
    "model": "openai/gpt-4o-mini",
    "code": Template(
        '''import os
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

# Only THIS project's .env (the current directory's - never a parent's); it wins over variables
# already set on your machine, so a real OPENAI_API_KEY there is never used.
load_dotenv(Path.cwd() / ".env", override=True)

# Fail closed: with no base URL the SDK would send your key to api.openai.com.
missing = [n for n in ("OPENAI_API_KEY", "OPENAI_BASE_URL") if not os.environ.get(n)]
if missing:
    raise RuntimeError(f"Missing {', '.join(missing)} - add it to .env (step 2) and run from this project's directory.")

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"], base_url=os.environ["OPENAI_BASE_URL"])

response = client.chat.completions.create(
    model="openai/gpt-4o-mini",
    messages=[{"role": "user", "content": "Say hello in five words."}],
    max_tokens=20,
)
print(response.choices[0].message.content)
'''
    ),
    "notes": [
        "The base URL ends in /v1 — the SDK appends /chat/completions.",
        "Use the openai/<model> form (as above) with any key. A key with a single provider has it as its "
        "default provider, and then a bare model name like gpt-4o-mini works too.",
        "The snippet reads only this project's .env (from the directory you run in, never a parent's), lets it "
        "win over variables already set on your machine, and passes the key and base URL to the SDK explicitly — "
        "so a real OPENAI_API_KEY on your machine is never sent to the gateway.",
        "If OPENAI_API_KEY or OPENAI_BASE_URL is missing the snippet stops with an error instead of letting the "
        "SDK fall back to api.openai.com, which would send your virtual key to OpenAI.",
    ],
}

_ANTHROPIC = {
    "label": "Anthropic",
    "sdk": "anthropic (Python)",
    "install": _install("anthropic"),
    "url_suffix": "",
    "env": [
        ("ANTHROPIC_API_KEY", KEY_PLACEHOLDER, "your gateway VIRTUAL key — never a real Anthropic key"),
        ("ANTHROPIC_BASE_URL", "${root}", "gateway ROOT — no /v1: the SDK adds /v1/messages itself"),
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
        ("GEMINI_API_KEY", KEY_PLACEHOLDER, "your gateway VIRTUAL key — never a real Google key"),
        ("GOOGLE_GEMINI_BASE_URL", "${root}", "gateway ROOT — no /v1beta: the SDK adds /v1beta/models/... itself"),
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
        "install": d["install"],
        "gateway_url": root,
        "base_url": root + d["url_suffix"],
        "endpoint": Template(d["endpoint"]).substitute(sub),
        "env_vars": env,
        "env_file": env_file,
        "code": d["code"].substitute(sub),
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
