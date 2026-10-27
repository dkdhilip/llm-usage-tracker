"""The built-in model catalog/price table: current models of the four providers, sane entries, and retired
models that stay priced (so old usage keeps an honest estimate) without being offered."""

import re

from app import pricing

CURRENT = {
    ("openai", "gpt-6.1-sol"): (2.00, 10.00),
    ("openai", "gpt-6-luna"): (0.10, 0.50),
    ("openai", "gpt-5.4-mini"): (0.75, 4.50),
    ("openai", "gpt-4.1"): (2.00, 8.00),
    ("anthropic", "claude-fable-5-1"): (10.00, 50.00),
    ("anthropic", "claude-opus-5-5"): (4.00, 20.00),
    ("anthropic", "claude-sonnet-5-5"): (2.00, 10.00),
    ("anthropic", "claude-haiku-5-5"): (0.10, 0.50),
    ("gemini", "gemini-4-argon"): (2.00, 10.00),
    ("gemini", "gemini-3.8-flash"): (0.75, 3.75),
    ("openrouter", "anthropic/claude-opus-5.5"): (4.00, 20.00),
    ("openrouter", "google/gemini-4-argon"): (2.00, 10.00),
}


def _listed() -> set[tuple[str, str]]:
    return {(m["provider"], m["model"]) for m in pricing.models_catalog()}


def test_current_models_of_all_four_providers_are_offered_with_their_listed_prices():
    listed = _listed()
    for key, (inp, out) in CURRENT.items():
        assert key in listed, key
        p = pricing.price_for(*key)
        assert (p["input"], p["output"]) == (inp, out), key
    assert {p for p, _ in listed} == set(pricing.PROVIDERS)


def test_every_entry_is_well_formed_and_there_are_no_duplicates():
    seen = set()
    for m in pricing.models_catalog():
        key = (m["provider"], m["model"])
        assert key not in seen
        seen.add(key)
        assert m["provider"] in pricing.PROVIDERS
        assert m["input_per_1m"] >= 0 and m["output_per_1m"] >= 0
        assert m["model"] == m["model"].strip() and " " not in m["model"]
        if m["provider"] == "openrouter":
            assert "/" in m["model"]  # a vendor-prefixed OpenRouter slug
        if m["provider"] == "anthropic":
            assert re.fullmatch(r"claude-[a-z]+-[0-9]+(-[0-9]+)?", m["model"]), m["model"]  # a Claude API id, not a display name
        if m["provider"] == "gemini" and "embedding" not in m["model"]:
            assert m["model"].startswith("gemini-")


def test_retired_models_stay_priced_but_are_not_offered():
    for key in [("anthropic", "claude-3-5-haiku"), ("anthropic", "claude-3-5-sonnet"), ("anthropic", "claude-3-7-sonnet"), ("openai", "o3-mini")]:
        assert pricing.price_for(*key) is not None  # old usage rows still get an estimate
        assert key not in _listed()  # but the Playground / GET /api/models do not offer them
    assert pricing.estimate_cost("anthropic", "claude-3-5-haiku", 1_000_000, 1_000_000) == 4.8


def test_models_google_no_longer_serves_to_new_accounts_are_not_offered():
    restricted = {"gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"}
    assert not {k for k in _listed() if k[0] == "gemini" and k[1] in restricted}
    for model in restricted:
        assert pricing.price_for("gemini", model) is not None  # still priced for accounts that already use them


def test_estimates_use_the_new_prices_and_unknown_models_stay_unknown():
    assert pricing.estimate_cost("anthropic", "claude-opus-5-5", 1_000_000, 500_000) == 4.0 + 10.0
    assert pricing.estimate_cost("openai", "gpt-6-luna", 2_000_000, 1_000_000) == 0.2 + 0.5
    assert pricing.estimate_cost("openai", "gpt-does-not-exist", 10, 10) is None  # never guessed


def test_embeddings_bill_input_only():
    for key in [("openai", "text-embedding-3-small"), ("openai", "text-embedding-ada-002"), ("gemini", "gemini-embedding-2")]:
        assert pricing.price_for(*key)["output"] == 0.0
