"""The app for the UI audit: a throwaway database and every provider mocked (no network, no real keys).

Started by ui_audit_env.py from a temporary COPY of the backend, so nothing is written into the repository.
Environment: UI_AUDIT_BACKEND (path to the copy), DATABASE_URL, PORT.
"""
import base64
import itertools
import os
import struct
import sys
import zlib

sys.path.insert(0, os.environ["UI_AUDIT_BACKEND"])
os.environ.setdefault("SECRET_KEY", "ui-audit-secret")
os.environ.update(
    REDIS_URL="",
    ENVIRONMENT="development",
    OPENAI_API_KEY="", ANTHROPIC_API_KEY="", OPENROUTER_API_KEY="", GEMINI_API_KEY="",
    SIGNUPS_PER_IP_PER_HOUR="1000", JOINS_PER_IP_PER_HOUR="1000",
)


def _png(w, h, rgb):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


GREEN = base64.b64encode(_png(80, 80, (30, 160, 60))).decode()
_n = itertools.count(1)

from app import providers  # noqa: E402

providers.check_key = lambda provider, key: True
providers.check_liveness = lambda provider, **kw: False
providers.warm_cache = lambda *a, **k: None


def _fake_send(url, headers, json_body, *, timeout=60.0):
    i = next(_n)
    if url.endswith("/images/generations"):
        return {"created": i, "data": [{"b64_json": GREEN}], "usage": {"input_tokens": 1, "output_tokens": 1}}
    return {
        "id": f"chat_{i}",
        "choices": [{"message": {"role": "assistant", "content": "I see a red square.",
                                 "images": [{"image_url": {"url": "data:image/png;base64," + GREEN}}]}}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 7, "total_tokens": 12},
    }


providers.send_request = _fake_send

import uvicorn  # noqa: E402
from app.main import app  # noqa: E402

uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "8765")), log_level="warning")
