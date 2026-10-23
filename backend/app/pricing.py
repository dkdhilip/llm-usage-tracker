"""Configured token pricing — a hand-maintained price table used to estimate
cost when the provider doesn't report one. Editable in one place, surfaced
read-only at GET /api/models, and extensible at runtime via
MODEL_PRICING_OVERRIDES_PATH (a JSON file of extra entries merged on top at
import time) so a newly released model can be priced without a code deploy.
USD per 1,000,000 tokens.

When a (provider, model) pair isn't registered anywhere, `estimate_cost`
returns None rather than guessing — record that gap honestly
(cost_source="unknown") instead of inventing a number."""

import json
import os

Pricing = dict[str, float]

CONFIGURED_PRICING: dict[tuple[str, str], Pricing] = {
    # ---- OpenAI ---- (standard tier, short context; developers.openai.com/api/docs/pricing, checked 2026-10-23)
    ("openai", "gpt-6-astra"): {"input": 10.00, "output": 50.00},
    ("openai", "gpt-6.1-sol"): {"input": 2.00, "output": 10.00},
    ("openai", "gpt-6-sol"): {"input": 2.00, "output": 10.00},
    ("openai", "gpt-6-luna"): {"input": 0.10, "output": 0.50},
    # gpt-5.6-sol is on a promotional rate listed through at least 2026-11-21: re-check then.
    ("openai", "gpt-5.6-sol"): {"input": 4.00, "output": 20.00},
    ("openai", "gpt-5.6-terra"): {"input": 2.00, "output": 12.00},
    ("openai", "gpt-5.6-luna"): {"input": 0.20, "output": 1.20},
    ("openai", "gpt-5.5"): {"input": 5.00, "output": 30.00},
    ("openai", "gpt-5.5-pro"): {"input": 30.00, "output": 180.00},
    ("openai", "gpt-5.4"): {"input": 2.50, "output": 15.00},
    ("openai", "gpt-5.4-mini"): {"input": 0.75, "output": 4.50},
    ("openai", "gpt-5.4-nano"): {"input": 0.20, "output": 1.25},
    ("openai", "gpt-5.2"): {"input": 1.75, "output": 14.00},
    ("openai", "gpt-5.1"): {"input": 1.25, "output": 10.00},
    ("openai", "gpt-5"): {"input": 1.25, "output": 10.00},
    ("openai", "gpt-5-mini"): {"input": 0.25, "output": 2.00},
    ("openai", "gpt-5-nano"): {"input": 0.05, "output": 0.40},
    ("openai", "o3"): {"input": 2.00, "output": 8.00},
    ("openai", "o4-mini"): {"input": 1.10, "output": 4.40},
    ("openai", "gpt-4.1"): {"input": 2.00, "output": 8.00},
    ("openai", "gpt-4.1-mini"): {"input": 0.40, "output": 1.60},
    ("openai", "gpt-4.1-nano"): {"input": 0.10, "output": 0.40},
    ("openai", "gpt-4o"): {"input": 2.50, "output": 10.00},
    ("openai", "gpt-4o-mini"): {"input": 0.15, "output": 0.60},
    # ---- Anthropic ---- (platform.claude.com/docs/en/about-claude/pricing and the models overview, checked
    # 2026-10-23; the IDs are the Claude API IDs). The Haiku 5.5 rate is the <=100k-token tier: above 100k Anthropic
    # charges $0.50 in / $2.50 out and this table is flat.
    ("anthropic", "claude-fable-5-1"): {"input": 10.00, "output": 50.00},
    ("anthropic", "claude-opus-5-5"): {"input": 4.00, "output": 20.00},
    ("anthropic", "claude-sonnet-5-5"): {"input": 2.00, "output": 10.00},
    ("anthropic", "claude-haiku-5-5"): {"input": 0.10, "output": 0.50},
    # still-available earlier models
    ("anthropic", "claude-fable-5"): {"input": 10.00, "output": 50.00},
    ("anthropic", "claude-opus-5"): {"input": 5.00, "output": 25.00},
    ("anthropic", "claude-opus-4-8"): {"input": 5.00, "output": 25.00},
    ("anthropic", "claude-opus-4-7"): {"input": 5.00, "output": 25.00},
    ("anthropic", "claude-opus-4-6"): {"input": 5.00, "output": 25.00},
    ("anthropic", "claude-opus-4-5"): {"input": 5.00, "output": 25.00},
    ("anthropic", "claude-sonnet-5"): {"input": 2.00, "output": 10.00},
    ("anthropic", "claude-sonnet-4-6"): {"input": 3.00, "output": 15.00},
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
    # Paid-tier list prices from ai.google.dev/gemini-api/docs/pricing, checked 2026-10-23, for the models Google
    # serves to NEW accounts (the 2.5 family answers 404 "no longer available to new users", so it is left out).
    # Dated rates to update when they pass: gemini-4-argon is $2/$10 until 2026-11-30 and $4/$20 from 2026-12-01;
    # gemini-3.8-flash and gemini-3.6-flash are $0.75/$3.75 until 2026-12-31 and $1.50/$7.50 from 2027-01-01.
    # The Pro rate is the <=200k-token tier (above that Google charges more; this table is flat).
    ("gemini", "gemini-4-argon"): {"input": 2.00, "output": 10.00},
    ("gemini", "gemini-3.8-flash"): {"input": 0.75, "output": 3.75},
    ("gemini", "gemini-3.6-flash"): {"input": 0.75, "output": 3.75},
    ("gemini", "gemini-3.5-flash-lite"): {"input": 0.30, "output": 2.50},
    ("gemini", "gemini-3.1-flash-lite"): {"input": 0.25, "output": 1.50},
    ("gemini", "gemini-3.1-pro-preview"): {"input": 2.00, "output": 12.00},
    ("gemini", "gemini-3-flash-preview"): {"input": 0.50, "output": 3.00},
    # Embeddings bill input tokens only - output is always 0.
    ("openai", "text-embedding-3-small"): {"input": 0.02, "output": 0.0},
    ("openai", "text-embedding-3-large"): {"input": 0.13, "output": 0.0},
    ("openai", "text-embedding-ada-002"): {"input": 0.10, "output": 0.0},
    ("gemini", "gemini-embedding-2"): {"input": 0.20, "output": 0.0},
}

# Retired or superseded models. They stay PRICED so old usage rows and existing keys keep an honest cost estimate,
# but they are left out of models_catalog() so the Playground and GET /api/models only offer current models.
LEGACY_PRICING: dict[tuple[str, str], Pricing] = {
    ("anthropic", "claude-3-5-haiku"): {"input": 0.80, "output": 4.00},
    ("anthropic", "claude-3-5-sonnet"): {"input": 3.00, "output": 15.00},
    ("anthropic", "claude-3-7-sonnet"): {"input": 3.00, "output": 15.00},
    ("openai", "o3-mini"): {"input": 1.10, "output": 4.40},
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


def price_for(provider: str, model: str) -> Pricing | None:
    """None => this (provider, model) isn't registered. Callers must not guess."""
    return CONFIGURED_PRICING.get((provider, model))


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
}

CONFIGURED_CHARACTER_PRICING: dict[tuple[str, str], CharacterPricing] = {
    ("openai", "tts-1"): {"per_1m_chars": 15.0},
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
    return [
        {
            "provider": provider,
            "model": model,
            "input_per_1m": p["input"],
            "output_per_1m": p["output"],
        }
        for (provider, model), p in CONFIGURED_PRICING.items()
        if (provider, model) not in LEGACY_PRICING  # retired models stay priced but are not offered
    ]
