"""Configured token pricing — a hand-maintained price table used to estimate
cost when the provider doesn't report one. Editable in one place, surfaced
read-only at GET /api/models, and extensible at runtime via
MODEL_PRICING_OVERRIDES_PATH (a JSON file of extra entries merged on top at
import time) so a newly released model can be priced without a code deploy.
USD per 1,000,000 tokens.

When a (provider, model) pair isn't registered anywhere, `estimate_cost`
returns None rather than guessing — record that gap honestly
(cost_source="unknown") instead of inventing a number.

The catalog was verified against the vendors' own pages on CATALOG_VERIFIED (CATALOG_SOURCES lists them). Besides
prices it tracks:

* LIFECYCLE: a model that is deprecated (still callable, with a shutdown date and a replacement), a preview, or
  restricted to accounts that already used it. A model whose shutdown date has passed is retired automatically: it
  stays PRICED (old usage rows and existing keys keep an honest estimate) but is no longer offered.
* ALIASES: dated snapshots and short names that resolve to a priced model, because the gateway prices the model
  name the client sent ("gpt-4o-2024-08-06", "claude-opus-4-5-20251101"). Only names the vendor documents as the
  same model are mapped.
* PRICE_CHANGES: a rate the vendor has scheduled for a future date, applied from that date without a deploy.
* UNPRICED: models verified to exist that a flat input/output rate cannot price (image, live audio, per-tool
  fees, ...). They stay unknown on purpose, with the reason recorded.

Where a model has tiers the flat table keeps the standard, short-context rate (OpenAI: up to 272K input tokens;
Anthropic Haiku 5.5: up to 100K; Gemini Pro: up to 200K), and where it bills modalities differently it keeps the
text rate. A real provider-reported charge always wins over these estimates."""

import json
import os
from datetime import UTC, datetime

Pricing = dict[str, float]

CATALOG_VERIFIED = "2026-10-27"
CATALOG_SOURCES: dict[str, tuple[str, ...]] = {
    "openai": (
        "https://developers.openai.com/api/docs/pricing",
        "https://developers.openai.com/api/docs/models",
        "https://developers.openai.com/api/docs/deprecations",
    ),
    "anthropic": (
        "https://platform.claude.com/docs/en/about-claude/pricing",
        "https://platform.claude.com/docs/en/models/overview",
        "https://platform.claude.com/docs/en/about-claude/model-deprecations",
        "https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions",
    ),
    "gemini": (
        "https://ai.google.dev/gemini-api/docs/pricing",
        "https://ai.google.dev/gemini-api/docs/models",
        "https://ai.google.dev/gemini-api/docs/deprecations",
    ),
    "openrouter": ("https://openrouter.ai/api/v1/models",),
}

CONFIGURED_PRICING: dict[tuple[str, str], Pricing] = {
    # ---- OpenAI ---- (standard tier, short context; developers.openai.com/api/docs/pricing and the per-model pages,
    # verified 2026-10-27). Deprecated-but-still-callable models are listed after the current ones.
    ("openai", "gpt-6-astra"): {"input": 10.00, "output": 50.00},
    ("openai", "gpt-6.1-sol"): {"input": 2.00, "output": 10.00},
    ("openai", "gpt-6.1-terra"): {"input": 1.00, "output": 5.00},
    ("openai", "gpt-6-sol"): {"input": 2.00, "output": 10.00},
    ("openai", "gpt-6-luna"): {"input": 0.10, "output": 0.50},
    # gpt-5.6-sol is on a promotional rate listed through at least 2026-11-21 (no later rate is published): re-check then.
    ("openai", "gpt-5.6-sol"): {"input": 4.00, "output": 20.00},
    ("openai", "gpt-5.6-terra"): {"input": 2.00, "output": 12.00},
    ("openai", "gpt-5.6-luna"): {"input": 0.20, "output": 1.20},
    # Cyber models are for approved security work (trusted access); gpt-5.5-cyber is on the pricing page only.
    ("openai", "gpt-5.6-cyber"): {"input": 12.50, "output": 75.00},
    ("openai", "gpt-5.5-cyber"): {"input": 12.50, "output": 75.00},
    ("openai", "gpt-5.5"): {"input": 5.00, "output": 30.00},
    ("openai", "gpt-5.5-pro"): {"input": 30.00, "output": 180.00},
    ("openai", "gpt-5.4"): {"input": 2.50, "output": 15.00},
    ("openai", "gpt-5.4-pro"): {"input": 30.00, "output": 180.00},
    ("openai", "gpt-5.4-mini"): {"input": 0.75, "output": 4.50},
    ("openai", "gpt-5.2"): {"input": 1.75, "output": 14.00},
    ("openai", "gpt-5.2-pro"): {"input": 21.00, "output": 168.00},
    ("openai", "chat-latest"): {"input": 5.00, "output": 30.00},
    # on the pricing page only (no model page)
    ("openai", "gpt-5-search-api"): {"input": 1.25, "output": 10.00},
    # life-sciences models for approved organizations; billing for gpt-rosalind-research starts 2026-10-05
    ("openai", "gpt-rosalind-research"): {"input": 5.00, "output": 25.00},
    ("openai", "gpt-rosalind-discovery"): {"input": 5.00, "output": 25.00},
    # deprecated, still callable until the shutdown date in LIFECYCLE
    ("openai", "gpt-4o"): {"input": 2.50, "output": 10.00},
    ("openai", "gpt-4o-mini"): {"input": 0.15, "output": 0.60},
    ("openai", "gpt-4.1"): {"input": 2.00, "output": 8.00},
    ("openai", "gpt-4.1-mini"): {"input": 0.40, "output": 1.60},
    ("openai", "gpt-5.3-codex"): {"input": 1.75, "output": 14.00},
    ("openai", "gpt-5.4-nano"): {"input": 0.20, "output": 1.25},
    ("openai", "gpt-5.1"): {"input": 1.25, "output": 10.00},
    ("openai", "gpt-5"): {"input": 1.25, "output": 10.00},
    ("openai", "gpt-5-mini"): {"input": 0.25, "output": 2.00},
    ("openai", "gpt-5-nano"): {"input": 0.05, "output": 0.40},
    ("openai", "gpt-5-pro"): {"input": 15.00, "output": 120.00},
    ("openai", "o3"): {"input": 2.00, "output": 8.00},
    ("openai", "o3-pro"): {"input": 20.00, "output": 80.00},
    # Transcription and speech models bill tokens: audio in / text out (transcribe), text in / audio out (tts).
    ("openai", "gpt-4o-transcribe"): {"input": 2.50, "output": 10.00},
    ("openai", "gpt-4o-transcribe-diarize"): {"input": 2.50, "output": 10.00},
    ("openai", "gpt-4o-mini-transcribe"): {"input": 1.25, "output": 5.00},
    ("openai", "gpt-4o-mini-tts"): {"input": 0.60, "output": 12.00},
    # Embeddings bill input tokens only - output is always 0. Moderation is free.
    ("openai", "text-embedding-3-small"): {"input": 0.02, "output": 0.0},
    ("openai", "text-embedding-3-large"): {"input": 0.13, "output": 0.0},
    ("openai", "text-embedding-ada-002"): {"input": 0.10, "output": 0.0},
    ("openai", "omni-moderation-latest"): {"input": 0.0, "output": 0.0},
    # ---- Anthropic ---- (platform.claude.com/docs/en/about-claude/pricing, the models overview and the
    # deprecations page, verified 2026-10-27; the IDs are the Claude API IDs). The Haiku 5.5 rate is the <=100k-token
    # tier: above 100k Anthropic charges $0.50 in / $2.50 out and this table is flat. The short names of models before
    # the 4.6 generation ("claude-opus-4-5") are the keys; their dated snapshot IDs are in ALIASES.
    ("anthropic", "claude-fable-5-1"): {"input": 10.00, "output": 50.00},
    ("anthropic", "claude-fable-5"): {"input": 10.00, "output": 50.00},
    # Mythos is limited availability: only organizations verified through Anthropic's programs can call it.
    ("anthropic", "claude-mythos-5-1"): {"input": 10.00, "output": 50.00},
    ("anthropic", "claude-mythos-5"): {"input": 10.00, "output": 50.00},
    ("anthropic", "claude-opus-5-5"): {"input": 4.00, "output": 20.00},
    ("anthropic", "claude-opus-5"): {"input": 5.00, "output": 25.00},
    ("anthropic", "claude-opus-4-8"): {"input": 5.00, "output": 25.00},
    ("anthropic", "claude-opus-4-7"): {"input": 5.00, "output": 25.00},
    ("anthropic", "claude-opus-4-6"): {"input": 5.00, "output": 25.00},
    ("anthropic", "claude-opus-4-5"): {"input": 5.00, "output": 25.00},
    ("anthropic", "claude-sonnet-5-5"): {"input": 2.00, "output": 10.00},
    ("anthropic", "claude-sonnet-5"): {"input": 2.00, "output": 10.00},
    ("anthropic", "claude-sonnet-4-6"): {"input": 3.00, "output": 15.00},
    ("anthropic", "claude-sonnet-4-5"): {"input": 3.00, "output": 15.00},  # deprecated, see LIFECYCLE
    ("anthropic", "claude-haiku-5-5"): {"input": 0.10, "output": 0.50},
    ("anthropic", "claude-haiku-4-5"): {"input": 1.00, "output": 5.00},
    # ---- OpenRouter ---- OpenRouter is itself a gateway; models keep their real vendor-prefixed slugs. Through the
    # OpenAI-compatible endpoint these are addressed as "openrouter/<slug>". List prices from
    # openrouter.ai/api/v1/models on 2026-10-23 (USD per 1M tokens); OpenRouter's price for a slug can differ from
    # the vendor's own and can change, so a real provider-reported charge always wins over this estimate.
    ("openrouter", "openai/gpt-6.1-sol"): {"input": 2.00, "output": 10.00},
    ("openrouter", "openai/gpt-6-luna"): {"input": 0.10, "output": 0.50},
    ("openrouter", "openai/gpt-6-astra"): {"input": 10.00, "output": 50.00},
    ("openrouter", "openai/gpt-5.6-sol"): {"input": 4.00, "output": 20.00},
    ("openrouter", "anthropic/claude-fable-5.1"): {"input": 10.00, "output": 50.00},
    ("openrouter", "anthropic/claude-opus-5.5"): {"input": 4.00, "output": 20.00},
    ("openrouter", "anthropic/claude-sonnet-5.5"): {"input": 2.00, "output": 10.00},
    ("openrouter", "anthropic/claude-haiku-5.5"): {"input": 0.10, "output": 0.50},
    ("openrouter", "google/gemini-4-argon"): {"input": 2.00, "output": 10.00},
    ("openrouter", "google/gemini-3.8-flash"): {"input": 0.825, "output": 4.125},
    ("openrouter", "google/gemini-3.5-flash-lite"): {"input": 0.30, "output": 2.50},
    ("openrouter", "x-ai/grok-4.7"): {"input": 2.00, "output": 6.00},
    ("openrouter", "deepseek/deepseek-v4.1-flash"): {"input": 0.30, "output": 1.20},
    ("openrouter", "deepseek/deepseek-v4-pro-0813"): {"input": 0.66, "output": 1.98},
    ("openrouter", "deepseek/deepseek-chat-v3.1"): {"input": 0.25, "output": 0.95},
    ("openrouter", "qwen/qwen3.8-max-0902"): {"input": 2.00, "output": 6.00},
    ("openrouter", "qwen/qwen3.8-flash"): {"input": 0.15, "output": 0.47},
    ("openrouter", "mistralai/mistral-large-4-0"): {"input": 1.36, "output": 4.18},
    ("openrouter", "meta-llama/llama-4-maverick"): {"input": 0.1875, "output": 0.6525},
    ("openrouter", "meta-llama/llama-3.3-70b-instruct"): {"input": 0.10, "output": 0.32},
    ("openrouter", "google/gemini-2.5-flash-lite"): {"input": 0.10, "output": 0.40},
    # ":free" slugs make a genuine OpenRouter call at $0 (rate-limited).
    ("openrouter", "google/gemma-4-31b-it:free"): {"input": 0.0, "output": 0.0},
    # ---- Google Gemini ---- (addressed natively, or as "gemini/<model>" through the OpenAI-compatible endpoint).
    # Paid-tier list prices from ai.google.dev/gemini-api/docs/pricing (standard tier), verified 2026-10-27. Where a
    # model bills modalities differently this keeps the text rate (audio input is dearer on 3.1 Flash-Lite and
    # 3 Flash). The Pro rate is the <=200k-token tier. Dated rates that change later are in PRICE_CHANGES.
    ("gemini", "gemini-4-argon"): {"input": 2.00, "output": 10.00},
    ("gemini", "gemini-3.8-flash"): {"input": 0.75, "output": 3.75},
    ("gemini", "gemini-3.6-flash"): {"input": 0.75, "output": 3.75},
    ("gemini", "gemini-3.5-flash-lite"): {"input": 0.30, "output": 2.50},
    ("gemini", "gemini-3.1-flash-lite"): {"input": 0.25, "output": 1.50},  # deprecated, see LIFECYCLE
    ("gemini", "gemini-3.1-pro-preview"): {"input": 2.00, "output": 12.00},
    ("gemini", "gemini-3-flash-preview"): {"input": 0.50, "output": 3.00},
    # audio in / text out (transcription) and text in / audio out (speech): a single rate per direction.
    ("gemini", "gemini-3.5-transcribe"): {"input": 2.00, "output": 12.00},
    ("gemini", "gemini-3.8-flash-tts"): {"input": 0.50, "output": 9.00},
    ("gemini", "gemini-3.8-flash-lite-tts"): {"input": 0.50, "output": 6.00},
    ("gemini", "gemini-3.1-flash-tts-preview"): {"input": 1.00, "output": 20.00},
    ("gemini", "gemini-2.5-flash-preview-tts"): {"input": 0.50, "output": 10.00},
    ("gemini", "gemini-2.5-pro-preview-tts"): {"input": 1.00, "output": 20.00},
    # robotics models bill every input modality at one rate
    ("gemini", "gemini-robotics-er-2-preview"): {"input": 1.00, "output": 5.00},
    ("gemini", "gemini-robotics-er-2-streaming-preview"): {"input": 1.00, "output": 5.00},
    # Embeddings bill input tokens only (this is the text rate; image, audio and video inputs cost more).
    ("gemini", "gemini-embedding-2"): {"input": 0.20, "output": 0.0},
}

# Retired or superseded models. They stay PRICED so old usage rows and existing keys keep an honest cost estimate,
# but they are left out of models_catalog() so the Playground and GET /api/models only offer current models.
LEGACY_PRICING: dict[tuple[str, str], Pricing] = {
    # ---- OpenAI, shut down (developers.openai.com/api/docs/deprecations; prices from each model's page) ----
    ("openai", "o4-mini"): {"input": 1.10, "output": 4.40},
    ("openai", "o3-mini"): {"input": 1.10, "output": 4.40},
    ("openai", "o1"): {"input": 15.00, "output": 60.00},
    ("openai", "o1-pro"): {"input": 150.00, "output": 600.00},
    ("openai", "o1-mini"): {"input": 1.10, "output": 4.40},
    ("openai", "o1-preview"): {"input": 15.00, "output": 60.00},
    ("openai", "gpt-4.1-nano"): {"input": 0.10, "output": 0.40},
    ("openai", "gpt-4-turbo"): {"input": 10.00, "output": 30.00},
    ("openai", "gpt-4-turbo-preview"): {"input": 10.00, "output": 30.00},
    ("openai", "gpt-4"): {"input": 30.00, "output": 60.00},
    ("openai", "gpt-3.5-turbo"): {"input": 0.50, "output": 1.50},
    ("openai", "gpt-4.5-preview"): {"input": 75.00, "output": 150.00},
    ("openai", "chatgpt-4o-latest"): {"input": 5.00, "output": 15.00},
    ("openai", "codex-mini-latest"): {"input": 1.50, "output": 6.00},
    ("openai", "gpt-5-chat-latest"): {"input": 1.25, "output": 10.00},
    ("openai", "gpt-5-codex"): {"input": 1.25, "output": 10.00},
    ("openai", "gpt-5.1-chat-latest"): {"input": 1.25, "output": 10.00},
    ("openai", "gpt-5.1-codex"): {"input": 1.25, "output": 10.00},
    ("openai", "gpt-5.1-codex-mini"): {"input": 0.25, "output": 2.00},
    ("openai", "gpt-5.1-codex-max"): {"input": 1.25, "output": 10.00},
    ("openai", "gpt-5.2-chat-latest"): {"input": 1.75, "output": 14.00},
    ("openai", "gpt-5.2-codex"): {"input": 1.75, "output": 14.00},
    ("openai", "gpt-5.3-chat-latest"): {"input": 1.75, "output": 14.00},
    ("openai", "babbage-002"): {"input": 0.40, "output": 0.40},
    ("openai", "davinci-002"): {"input": 2.00, "output": 2.00},
    # a dated snapshot with its own (older) price, so it is not an alias of gpt-4o
    ("openai", "gpt-4o-2024-05-13"): {"input": 5.00, "output": 15.00},
    # ---- Anthropic, retired (model-deprecations page; prices from the pricing page) ----
    ("anthropic", "claude-opus-4-1"): {"input": 15.00, "output": 75.00},
    ("anthropic", "claude-opus-4"): {"input": 15.00, "output": 75.00},
    ("anthropic", "claude-sonnet-4"): {"input": 3.00, "output": 15.00},
    ("anthropic", "claude-3-5-haiku"): {"input": 0.80, "output": 4.00},
    # Retired and no longer on the pricing page: carried over from the earlier catalog, not re-verifiable now.
    ("anthropic", "claude-3-5-sonnet"): {"input": 3.00, "output": 15.00},
    ("anthropic", "claude-3-7-sonnet"): {"input": 3.00, "output": 15.00},
    # ---- Gemini 2.5: not deprecated, but Google limits access to accounts that already used these models (new
    # accounts get 404 "no longer available to new users"), so they are priced but not offered. ----
    ("gemini", "gemini-2.5-pro"): {"input": 1.25, "output": 10.00},
    ("gemini", "gemini-2.5-flash"): {"input": 0.30, "output": 2.50},
    ("gemini", "gemini-2.5-flash-lite"): {"input": 0.10, "output": 0.40},
}

# Lifecycle of a model that is not simply "active". status: "deprecated" (still callable until `shutdown`, then
# retired), "preview", or "restricted" (kept for accounts that already used it). `shutdown` is the vendor's earliest
# announced date (ISO); `replacement` is the vendor's recommended model. Retired models need no entry: a past
# `shutdown` date, or being in LEGACY_PRICING, is enough.
LIFECYCLE: dict[tuple[str, str], dict[str, str]] = {
    # ---- OpenAI ----
    ("openai", "gpt-4o"): {"status": "deprecated", "shutdown": "2027-01-14", "replacement": "gpt-6-luna"},
    ("openai", "gpt-4o-mini"): {"status": "deprecated", "shutdown": "2027-01-14", "replacement": "gpt-6-luna"},
    ("openai", "gpt-4.1"): {"status": "deprecated", "shutdown": "2027-01-14", "replacement": "gpt-6-luna"},
    ("openai", "gpt-4.1-mini"): {"status": "deprecated", "shutdown": "2027-01-14", "replacement": "gpt-6-luna"},
    ("openai", "gpt-5.3-codex"): {"status": "deprecated", "shutdown": "2027-04-01", "replacement": "gpt-6-sol"},
    ("openai", "gpt-5.4-nano"): {"status": "deprecated", "shutdown": "2027-04-01", "replacement": "gpt-6-luna"},
    ("openai", "gpt-5.1"): {"status": "deprecated", "shutdown": "2027-04-01", "replacement": "gpt-6-sol"},
    ("openai", "gpt-5"): {"status": "deprecated", "shutdown": "2026-12-11", "replacement": "gpt-5.6-sol"},
    ("openai", "gpt-5-mini"): {"status": "deprecated", "shutdown": "2026-12-11", "replacement": "gpt-5.6-terra"},
    ("openai", "gpt-5-nano"): {"status": "deprecated", "shutdown": "2026-12-11", "replacement": "gpt-5.6-luna"},
    ("openai", "gpt-5-pro"): {"status": "deprecated", "shutdown": "2026-12-11", "replacement": "gpt-5.6-sol"},
    ("openai", "o3"): {"status": "deprecated", "shutdown": "2026-12-11", "replacement": "gpt-5.6-sol"},
    ("openai", "o3-pro"): {"status": "deprecated", "shutdown": "2026-12-11", "replacement": "gpt-5.6-sol"},
    ("openai", "gpt-4o-mini-tts"): {"status": "deprecated", "shutdown": "2027-01-06", "replacement": "gpt-realtime-2.1-mini"},
    ("openai", "gpt-4o-transcribe"): {"status": "deprecated", "shutdown": "2027-02-26", "replacement": "gpt-transcribe"},
    ("openai", "gpt-4o-transcribe-diarize"): {"status": "deprecated", "shutdown": "2027-02-26", "replacement": "gpt-transcribe"},
    ("openai", "gpt-4o-mini-transcribe"): {"status": "deprecated", "shutdown": "2027-02-26", "replacement": "gpt-transcribe"},
    ("openai", "whisper-1"): {"status": "deprecated", "shutdown": "2027-02-26", "replacement": "gpt-transcribe"},
    ("openai", "tts-1"): {"status": "deprecated", "shutdown": "2027-01-06", "replacement": "gpt-realtime-2.1-mini"},
    ("openai", "tts-1-hd"): {"status": "deprecated", "shutdown": "2027-01-06", "replacement": "gpt-realtime-2.1-mini"},
    # ---- Anthropic ----
    ("anthropic", "claude-sonnet-4-5"): {"status": "deprecated", "shutdown": "2026-11-30", "replacement": "claude-sonnet-5-5"},
    # ---- Gemini ----
    ("gemini", "gemini-3.1-flash-lite"): {"status": "deprecated", "shutdown": "2027-05-07", "replacement": "gemini-3.5-flash-lite"},
    ("gemini", "gemini-3.1-pro-preview"): {"status": "preview"},
    ("gemini", "gemini-3-flash-preview"): {"status": "preview", "replacement": "gemini-3.6-flash"},
    ("gemini", "gemini-3.1-flash-tts-preview"): {"status": "deprecated", "shutdown": "2026-11-17", "replacement": "gemini-3.8-flash-tts"},
    ("gemini", "gemini-2.5-flash-preview-tts"): {"status": "deprecated", "shutdown": "2026-11-17", "replacement": "gemini-3.8-flash-tts"},
    ("gemini", "gemini-2.5-pro-preview-tts"): {"status": "deprecated", "shutdown": "2026-11-17", "replacement": "gemini-3.8-flash-tts"},
    ("gemini", "gemini-robotics-er-2-preview"): {"status": "preview"},
    ("gemini", "gemini-robotics-er-2-streaming-preview"): {"status": "preview"},
    ("gemini", "gemini-2.5-pro"): {"status": "restricted"},
    ("gemini", "gemini-2.5-flash"): {"status": "restricted"},
    ("gemini", "gemini-2.5-flash-lite"): {"status": "restricted"},
}

# Names that resolve to a priced model. The gateway prices the model name the CLIENT sent, so a dated snapshot or a
# short name must find the price of the model it points to. Only the vendors' documented equivalences are listed.
ALIASES: dict[tuple[str, str], str] = {
    # ---- OpenAI snapshots: each model page lists them as snapshots of that model (the pricing page lists the same
    # rate for the dated ID wherever it prints one) ----
    ("openai", "gpt-5.5-2026-04-23"): "gpt-5.5",
    ("openai", "gpt-5.5-pro-2026-04-23"): "gpt-5.5-pro",
    ("openai", "gpt-5.4-2026-03-05"): "gpt-5.4",
    ("openai", "gpt-5.4-pro-2026-03-05"): "gpt-5.4-pro",
    ("openai", "gpt-5.4-mini-2026-03-17"): "gpt-5.4-mini",
    ("openai", "gpt-5.2-2025-12-11"): "gpt-5.2",
    ("openai", "gpt-5.2-pro-2025-12-11"): "gpt-5.2-pro",
    ("openai", "gpt-4o-2024-11-20"): "gpt-4o",
    ("openai", "gpt-4o-2024-08-06"): "gpt-4o",
    ("openai", "gpt-4o-mini-2024-07-18"): "gpt-4o-mini",
    ("openai", "gpt-4.1-2025-04-14"): "gpt-4.1",
    ("openai", "gpt-4.1-mini-2025-04-14"): "gpt-4.1-mini",
    ("openai", "gpt-5.4-nano-2026-03-17"): "gpt-5.4-nano",
    ("openai", "gpt-5.1-2025-11-13"): "gpt-5.1",
    ("openai", "gpt-5-2025-08-07"): "gpt-5",
    ("openai", "gpt-5-mini-2025-08-07"): "gpt-5-mini",
    ("openai", "gpt-5-nano-2025-08-07"): "gpt-5-nano",
    ("openai", "gpt-5-pro-2025-10-06"): "gpt-5-pro",
    ("openai", "o3-2025-04-16"): "o3",
    ("openai", "o3-pro-2025-06-10"): "o3-pro",
    ("openai", "o4-mini-2025-04-16"): "o4-mini",
    ("openai", "o3-mini-2025-01-31"): "o3-mini",
    ("openai", "o1-2024-12-17"): "o1",
    ("openai", "o1-pro-2025-03-19"): "o1-pro",
    ("openai", "o1-mini-2024-09-12"): "o1-mini",
    ("openai", "o1-preview-2024-09-12"): "o1-preview",
    ("openai", "gpt-4.1-nano-2025-04-14"): "gpt-4.1-nano",
    ("openai", "gpt-4-turbo-2024-04-09"): "gpt-4-turbo",
    ("openai", "gpt-4-0125-preview"): "gpt-4-turbo-preview",
    ("openai", "gpt-4-0613"): "gpt-4",
    ("openai", "gpt-4-0314"): "gpt-4",
    ("openai", "gpt-3.5-turbo-0125"): "gpt-3.5-turbo",
    ("openai", "gpt-3.5-turbo-1106"): "gpt-3.5-turbo",
    ("openai", "gpt-4.5-preview-2025-02-27"): "gpt-4.5-preview",
    # ---- Anthropic: before the 4.6 generation the short name is an alias of the latest dated snapshot, which is
    # the ID the API reports (platform.claude.com/docs/en/about-claude/models/model-ids-and-versions) ----
    ("anthropic", "claude-opus-4-5-20251101"): "claude-opus-4-5",
    ("anthropic", "claude-sonnet-4-5-20250929"): "claude-sonnet-4-5",
    ("anthropic", "claude-haiku-4-5-20251001"): "claude-haiku-4-5",
    ("anthropic", "claude-opus-4-1-20250805"): "claude-opus-4-1",
    ("anthropic", "claude-opus-4-20250514"): "claude-opus-4",
    ("anthropic", "claude-sonnet-4-20250514"): "claude-sonnet-4",
    ("anthropic", "claude-3-5-haiku-20241022"): "claude-3-5-haiku",
    ("anthropic", "claude-3-7-sonnet-20250219"): "claude-3-7-sonnet",
    ("anthropic", "claude-3-5-sonnet-20240620"): "claude-3-5-sonnet",
    ("anthropic", "claude-3-5-sonnet-20241022"): "claude-3-5-sonnet",
    # ---- Gemini ----
    # Google lists both IDs under one pricing table.
    ("gemini", "gemini-3.1-pro-preview-customtools"): "gemini-3.1-pro-preview",
    # ROUTED, not identical: Google says these endpoints "automatically route API requests" to the successor
    # (ai.google.dev/gemini-api/docs/deprecations). The page does not state a rate for the old names, so they are
    # priced as the model that actually serves the request. Remove these two lines if Google bills them differently.
    ("gemini", "gemini-3.5-flash"): "gemini-3.6-flash",
    ("gemini", "gemini-3.7-flash"): "gemini-3.8-flash",
}

# A rate the vendor has published for a future date: (effective ISO date, new rate). price_for applies the latest
# entry whose date has arrived, so these take effect without a deploy. The base table holds today's rate.
PRICE_CHANGES: dict[tuple[str, str], list[tuple[str, Pricing]]] = {
    ("gemini", "gemini-4-argon"): [("2026-12-01", {"input": 4.00, "output": 20.00})],
    ("gemini", "gemini-3.8-flash"): [("2027-01-01", {"input": 1.50, "output": 7.50})],
    ("gemini", "gemini-3.6-flash"): [("2027-01-01", {"input": 1.50, "output": 7.50})],
    ("gemini", "gemini-3.8-flash-tts"): [("2027-01-01", {"input": 1.00, "output": 18.00})],
    ("gemini", "gemini-3.8-flash-lite-tts"): [("2027-01-01", {"input": 1.00, "output": 12.00})],
    ("gemini", "gemini-robotics-er-2-preview"): [("2027-01-01", {"input": 2.00, "output": 10.00})],
    ("gemini", "gemini-robotics-er-2-streaming-preview"): [("2027-01-01", {"input": 2.00, "output": 10.00})],
}

# Verified to exist in the vendors' catalogs, but NOT priceable with a flat input/output (or per-minute / per-character)
# rate, so they stay unknown on purpose instead of getting an invented number. reason -> {provider: models}.
_UNPRICED_BY_REASON: dict[str, dict[str, tuple[str, ...]]] = {
    "image generation: text input, image input and image output tokens have different rates": {
        "openai": ("gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-1.5", "gpt-image-1-mini",
                   "gpt-image-1", "chatgpt-image-latest"),
        "gemini": ("gemini-nano-banana-2.1", "gemini-3.1-flash-image", "gemini-3.1-flash-lite-image",
                   "gemini-3-pro-image", "gemini-2.5-flash-image"),
    },
    "audio / realtime / live: text, audio and image tokens have different rates, or billing is per minute": {
        "openai": ("gpt-audio", "gpt-audio-mini", "gpt-audio-1.5", "gpt-realtime", "gpt-realtime-mini",
                   "gpt-realtime-1.5", "gpt-realtime-2", "gpt-realtime-2.1", "gpt-realtime-2.1-mini", "gpt-live-1",
                   "gpt-live-transcribe", "gpt-realtime-translate", "gpt-realtime-whisper", "gpt-4o-audio-preview",
                   "gpt-4o-mini-audio-preview", "gpt-4o-realtime-preview", "gpt-4o-mini-realtime-preview"),
        "gemini": ("gemini-3.8-live", "gemini-3.8-live-extended-thinking", "gemini-3.1-flash-live-preview",
                   "gemini-3.5-live-translate-preview", "gemini-3.5-transcribe-live",
                   "gemini-2.5-flash-native-audio-preview-12-2025"),
    },
    "video and music: billed per second or per song, not per token": {
        "gemini": ("gemini-omni-1.1-flash", "lyria-3.5", "lyria-3-clip-preview", "lyria-3-pro-preview"),
    },
    "billed per tool call on top of tokens, so a token rate would under-count": {
        "openai": ("o3-deep-research", "o4-mini-deep-research", "computer-use-preview", "gpt-4o-search-preview",
                   "gpt-4o-mini-search-preview"),
    },
    "no published API price": {
        "openai": ("gpt-oss-120b", "gpt-oss-20b", "gpt-daybreak-blue-latest", "gpt-daybreak-red-latest"),
        "anthropic": ("claude-mythos-preview", "claude-3-opus", "claude-3-sonnet", "claude-3-haiku", "claude-2.0",
                      "claude-2.1"),
        "gemini": ("gemini-2.5-computer-use-preview-10-2025",),
    },
    # (gemini-flash-lite-latest and gemini-pro-latest are not in the docs pages; they were seen in the live Models API.)
    "a 'latest' alias that Google hot-swaps to a new model, and the page does not say which one is current": {
        "gemini": ("gemini-flash-latest", "gemini-flash-lite-latest", "gemini-pro-latest"),
    },
}
UNPRICED: dict[tuple[str, str], str] = {
    (provider, model): reason
    for reason, by_provider in _UNPRICED_BY_REASON.items()
    for provider, models in by_provider.items()
    for model in models
}


def _load_overrides() -> dict[tuple[str, str], Pricing]:
    """Optional extra (provider, model) -> {input, output} entries from a JSON
    file (a list of {"provider", "model", "input", "output"} objects), so an
    operator can price a newly released model without a code deploy. A missing
    or malformed file is silently ignored — it must never break startup."""
    path = os.environ.get("MODEL_PRICING_OVERRIDES_PATH", "").strip()
    if not path or not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
        return {
            (entry["provider"], entry["model"]): {
                "input": float(entry["input"]),
                "output": float(entry["output"]),
            }
            for entry in raw
        }
    except Exception:
        return {}


CONFIGURED_PRICING.update(_load_overrides())
CONFIGURED_PRICING.update({k: v for k, v in LEGACY_PRICING.items() if k not in CONFIGURED_PRICING})

PROVIDERS = ("openai", "anthropic", "openrouter", "gemini")


def _today() -> str:
    """Today's date (UTC, ISO). One place to patch in tests."""
    return datetime.now(UTC).date().isoformat()


def resolve_model(provider: str, model: str) -> str:
    """The name a (provider, model) is priced under: an alias or dated snapshot maps to the model it points to; an
    exact entry always wins, so a snapshot with its own price is never redirected."""
    if (provider, model) in CONFIGURED_PRICING:
        return model
    return ALIASES.get((provider, model), model)


def price_for(provider: str, model: str) -> Pricing | None:
    """None => this (provider, model) isn't registered. Callers must not guess."""
    model = resolve_model(provider, model)
    p = CONFIGURED_PRICING.get((provider, model))
    if p is None:
        return None
    today = _today()
    for effective, new_rate in sorted(PRICE_CHANGES.get((provider, model), [])):
        if effective <= today:
            p = new_rate
    return p


def lifecycle_for(provider: str, model: str) -> dict[str, str]:
    """{"status": active | preview | deprecated | restricted | retired, "shutdown"?, "replacement"?} for a known
    model (an alias answers for the model it points to); {} for a model that is not in the catalog."""
    model = resolve_model(provider, model)
    key = (provider, model)
    if key not in CONFIGURED_PRICING:
        return {}
    info = dict(LIFECYCLE.get(key, {"status": "active"}))
    shutdown = info.get("shutdown")
    if key in LEGACY_PRICING and info["status"] != "restricted":
        info["status"] = "retired"
    elif shutdown and shutdown <= _today():
        info["status"] = "retired"
    return info


def estimate_cost(
    provider: str, model: str, prompt_tokens: int, completion_tokens: int
) -> float | None:
    """None => the model isn't registered and the provider didn't report a real
    charge either; the caller records cost_source="unknown" rather than a
    fabricated number."""
    p = price_for(provider, model)
    if p is None:
        return None
    cost = prompt_tokens / 1_000_000 * p["input"] + completion_tokens / 1_000_000 * p["output"]
    return round(cost, 6)


# ---- non-token billing dimensions (audio) ----
# Every entry here is a verified, stable, single-rate price — never a blended
# guess. A model whose real pricing doesn't fit a single rate (e.g. gpt-image-1
# mixes text/image tokens at different rates; several newer audio models bill
# by token, not duration/characters, and belong in CONFIGURED_PRICING instead
# if registered at all) is deliberately left unregistered rather than forced
# in here — estimate_duration_cost/estimate_character_cost then honestly
# return None, same "unknown" rule as the token table above.
DurationPricing = dict[str, float]  # {"per_minute": USD}
CharacterPricing = dict[str, float]  # {"per_1m_chars": USD}

CONFIGURED_DURATION_PRICING: dict[tuple[str, str], DurationPricing] = {
    ("openai", "whisper-1"): {"per_minute": 0.006},
    ("openai", "gpt-transcribe"): {"per_minute": 0.0045},
}

CONFIGURED_CHARACTER_PRICING: dict[tuple[str, str], CharacterPricing] = {
    ("openai", "tts-1"): {"per_1m_chars": 15.0},
    ("openai", "tts-1-hd"): {"per_1m_chars": 30.0},
}


def duration_price_for(provider: str, model: str) -> DurationPricing | None:
    return CONFIGURED_DURATION_PRICING.get((provider, model))


def character_price_for(provider: str, model: str) -> CharacterPricing | None:
    return CONFIGURED_CHARACTER_PRICING.get((provider, model))


def estimate_duration_cost(provider: str, model: str, seconds: float) -> float | None:
    p = duration_price_for(provider, model)
    if p is None:
        return None
    return round(seconds / 60 * p["per_minute"], 6)


def estimate_character_cost(provider: str, model: str, characters: int) -> float | None:
    p = character_price_for(provider, model)
    if p is None:
        return None
    return round(characters / 1_000_000 * p["per_1m_chars"], 6)


def models_catalog() -> list[dict]:
    """The models the Playground and GET /api/models offer: every priced model that is not retired, with its
    current rate and lifecycle (status, and shutdown date / replacement where the vendor gave them)."""
    out = []
    for provider, model in CONFIGURED_PRICING:
        life = lifecycle_for(provider, model)
        if life.get("status") in ("retired", "restricted"):
            continue  # retired models stay priced but are not offered
        p = price_for(provider, model) or CONFIGURED_PRICING[(provider, model)]
        entry = {
            "provider": provider,
            "model": model,
            "input_per_1m": p["input"],
            "output_per_1m": p["output"],
            "status": life.get("status", "active"),
        }
        if "shutdown" in life:
            entry["shutdown_date"] = life["shutdown"]
        if "replacement" in life:
            entry["replacement"] = life["replacement"]
        out.append(entry)
    return out
