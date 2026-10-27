"""The model catalog beyond the price table: dated snapshots and aliases, deprecated vs retired models, rates the
vendor has scheduled for a later date, and models that are deliberately left unpriced."""

import re

import pytest

from app import pricing


def _by_key():
    return {(m["provider"], m["model"]): m for m in pricing.models_catalog()}


@pytest.fixture()
def on(monkeypatch):
    """Pin the catalog's idea of today."""

    def _set(day: str):
        monkeypatch.setattr(pricing, "_today", lambda: day)

    return _set


# ---------------------------------------------------------------------------------------------- lookup and cost


def test_every_priced_entry_has_a_sane_rate_and_a_known_provider():
    for (provider, model), p in pricing.CONFIGURED_PRICING.items():
        assert provider in pricing.PROVIDERS, (provider, model)
        assert set(p) == {"input", "output"}, (provider, model)
        assert p["input"] >= 0 and p["output"] >= 0, (provider, model)
        assert model == model.strip() and " " not in model, (provider, model)


def test_the_catalog_has_no_duplicate_models_and_legacy_never_shadows_a_current_entry():
    models = [(m["provider"], m["model"]) for m in pricing.models_catalog()]
    assert len(models) == len(set(models))
    # LEGACY_PRICING is merged under CONFIGURED_PRICING, so a name in both would silently use the current rate
    from app.pricing import LEGACY_PRICING

    code_current = {k for k in pricing.CONFIGURED_PRICING if k not in LEGACY_PRICING}
    assert not (code_current & set(LEGACY_PRICING)), "an entry is both current and legacy"


@pytest.mark.parametrize(
    ("provider", "model", "prompt", "completion", "cost"),
    [
        ("openai", "gpt-6-luna", 1_000_000, 1_000_000, 0.60),
        ("openai", "gpt-6.1-terra", 2_000_000, 1_000_000, 2.0 + 5.0),
        ("openai", "gpt-5.4-pro", 1_000_000, 100_000, 30.0 + 18.0),
        ("anthropic", "claude-sonnet-4-6", 1_000_000, 1_000_000, 18.0),
        ("anthropic", "claude-haiku-5-5", 1_000_000, 1_000_000, 0.60),
        ("gemini", "gemini-3.5-flash-lite", 1_000_000, 1_000_000, 2.80),
        ("gemini", "gemini-3.1-pro-preview", 500_000, 500_000, 1.0 + 6.0),
        ("openai", "text-embedding-3-large", 1_000_000, 0, 0.13),
        ("openai", "omni-moderation-latest", 5_000_000, 0, 0.0),
    ],
)
def test_cost_is_input_plus_output_at_the_listed_rates(provider, model, prompt, completion, cost):
    assert pricing.estimate_cost(provider, model, prompt, completion) == pytest.approx(cost)


def test_a_model_that_is_not_in_the_catalog_stays_unknown_never_guessed():
    for provider, model in [("openai", "gpt-9"), ("anthropic", "claude-future-9"), ("gemini", "gemini-9-ultra")]:
        assert pricing.price_for(provider, model) is None
        assert pricing.estimate_cost(provider, model, 1000, 1000) is None
        assert pricing.lifecycle_for(provider, model) == {}


def test_the_same_name_under_another_provider_is_not_a_match():
    assert pricing.price_for("anthropic", "gpt-6-luna") is None
    assert pricing.price_for("openai", "claude-opus-5-5") is None


# ---------------------------------------------------------------------------------------------- aliases and snapshots


def test_every_alias_points_at_a_priced_model_and_never_shadows_a_priced_name():
    for (provider, alias), target in pricing.ALIASES.items():
        assert (provider, target) in pricing.CONFIGURED_PRICING, (provider, alias, target)
        assert (provider, alias) not in pricing.CONFIGURED_PRICING, f"{alias} is priced AND an alias"
        assert alias != target


def test_dated_snapshots_are_priced_like_the_model_they_belong_to():
    assert pricing.price_for("openai", "gpt-4o-2024-08-06") == pricing.price_for("openai", "gpt-4o")
    assert pricing.price_for("openai", "gpt-5.4-mini-2026-03-17") == pricing.price_for("openai", "gpt-5.4-mini")
    assert pricing.price_for("anthropic", "claude-opus-4-5-20251101") == {"input": 5.0, "output": 25.0}
    assert pricing.price_for("anthropic", "claude-haiku-4-5-20251001") == {"input": 1.0, "output": 5.0}
    assert pricing.price_for("anthropic", "claude-sonnet-4-5-20250929") == {"input": 3.0, "output": 15.0}
    assert pricing.estimate_cost("openai", "gpt-4o-2024-08-06", 1_000_000, 1_000_000) == 12.5


def test_a_snapshot_with_its_own_price_is_not_redirected_to_the_model():
    # gpt-4o-2024-05-13 was sold at $5/$15 while gpt-4o is $2.50/$10
    assert pricing.price_for("openai", "gpt-4o-2024-05-13") == {"input": 5.0, "output": 15.0}
    assert pricing.price_for("openai", "gpt-4o") == {"input": 2.5, "output": 10.0}
    assert ("openai", "gpt-4o-2024-05-13") not in pricing.ALIASES


def test_aliases_are_not_offered_as_separate_models():
    offered = _by_key()
    for key in pricing.ALIASES:
        assert key not in offered, key


def test_a_routed_endpoint_is_priced_as_the_model_that_serves_it():
    # Google documents that these endpoints route to the successor; the rate is the successor's.
    assert pricing.price_for("gemini", "gemini-3.5-flash") == pricing.price_for("gemini", "gemini-3.6-flash")
    assert pricing.price_for("gemini", "gemini-3.7-flash") == pricing.price_for("gemini", "gemini-3.8-flash")
    assert pricing.estimate_cost("gemini", "gemini-3.5-flash", 1_000_000, 1_000_000) == 0.75 + 3.75


# ---------------------------------------------------------------------------------------------- lifecycle


def test_deprecated_models_are_offered_with_their_shutdown_date_and_replacement(on):
    on("2026-10-27")
    m = _by_key()[("openai", "gpt-4o")]
    assert m["status"] == "deprecated"
    assert m["shutdown_date"] == "2027-01-14"
    assert m["replacement"] == "gpt-6-luna"
    assert _by_key()[("anthropic", "claude-sonnet-4-5")]["shutdown_date"] == "2026-11-30"
    assert pricing.price_for("openai", "gpt-4o") is not None  # still billed and priced while callable


def test_current_models_are_active_and_carry_no_shutdown_date(on):
    on("2026-10-27")
    for key in [("openai", "gpt-6-astra"), ("anthropic", "claude-opus-5-5"), ("gemini", "gemini-4-argon")]:
        m = _by_key()[key]
        assert m["status"] == "active"
        assert "shutdown_date" not in m


def test_preview_models_say_so(on):
    on("2026-10-27")
    assert _by_key()[("gemini", "gemini-3.1-pro-preview")]["status"] == "preview"
    assert _by_key()[("gemini", "gemini-robotics-er-2-preview")]["status"] == "preview"


def test_a_model_is_retired_automatically_once_its_shutdown_date_passes(on):
    on("2026-12-10")
    assert _by_key()[("openai", "gpt-5")]["status"] == "deprecated"  # shuts down 2026-12-11
    on("2026-12-11")
    assert ("openai", "gpt-5") not in _by_key()  # no longer offered ...
    assert pricing.lifecycle_for("openai", "gpt-5")["status"] == "retired"
    assert pricing.estimate_cost("openai", "gpt-5", 1_000_000, 0) == 1.25  # ... but old usage keeps its estimate
    assert pricing.lifecycle_for("openai", "gpt-5-2025-08-07")["status"] == "retired"  # a snapshot follows its model


def test_models_shut_down_before_today_are_priced_but_not_offered(on):
    on("2026-10-27")
    for key in [("openai", "o4-mini"), ("openai", "gpt-4.1-nano"), ("openai", "o1"), ("anthropic", "claude-opus-4-1"),
                ("anthropic", "claude-sonnet-4"), ("anthropic", "claude-3-5-haiku")]:
        assert pricing.price_for(*key) is not None, key
        assert pricing.lifecycle_for(*key)["status"] == "retired", key
        assert key not in _by_key(), key
    assert pricing.estimate_cost("anthropic", "claude-opus-4-1", 1_000_000, 1_000_000) == 90.0


def test_restricted_models_are_priced_but_not_offered_to_new_accounts(on):
    on("2026-10-27")
    for model in ("gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"):
        assert pricing.lifecycle_for("gemini", model)["status"] == "restricted"
        assert ("gemini", model) not in _by_key()
        assert pricing.price_for("gemini", model) is not None


def test_lifecycle_data_is_well_formed():
    statuses = {"deprecated", "preview", "restricted"}
    for key, info in pricing.LIFECYCLE.items():
        assert info["status"] in statuses, key
        if info["status"] == "deprecated":
            assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", info["shutdown"]), key
            assert info.get("replacement"), key
        if "shutdown" in info:
            assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", info["shutdown"]), key
        in_a_table = (
            key in pricing.CONFIGURED_PRICING
            or key in pricing.CONFIGURED_DURATION_PRICING
            or key in pricing.CONFIGURED_CHARACTER_PRICING
        )
        assert in_a_table, f"{key} has a lifecycle but no price"


def test_retired_status_never_hides_a_priced_current_model(on):
    on("2026-10-27")
    retired_now = {k for k in pricing.CONFIGURED_PRICING if pricing.lifecycle_for(*k).get("status") == "retired"}
    offered = set(_by_key())
    assert not (retired_now & offered)
    # every other priced model that is not restricted is offered
    expected = {k for k in pricing.CONFIGURED_PRICING if k not in retired_now and pricing.lifecycle_for(*k)["status"] != "restricted"}
    assert offered == expected


# ---------------------------------------------------------------------------------------------- scheduled rates


def test_a_rate_the_vendor_scheduled_applies_from_its_date_without_a_deploy(on):
    on("2026-11-30")
    assert pricing.price_for("gemini", "gemini-4-argon") == {"input": 2.0, "output": 10.0}
    on("2026-12-01")
    assert pricing.price_for("gemini", "gemini-4-argon") == {"input": 4.0, "output": 20.0}
    assert pricing.estimate_cost("gemini", "gemini-4-argon", 1_000_000, 1_000_000) == 24.0
    assert _by_key()[("gemini", "gemini-4-argon")]["input_per_1m"] == 4.0  # the catalog shows the rate in force


def test_scheduled_rates_follow_aliases_and_routing(on):
    on("2027-01-01")
    assert pricing.price_for("gemini", "gemini-3.8-flash") == {"input": 1.5, "output": 7.5}
    assert pricing.price_for("gemini", "gemini-3.7-flash") == {"input": 1.5, "output": 7.5}
    assert pricing.price_for("gemini", "gemini-3.5-flash") == {"input": 1.5, "output": 7.5}
    on("2026-12-31")
    assert pricing.price_for("gemini", "gemini-3.8-flash") == {"input": 0.75, "output": 3.75}


def test_scheduled_changes_are_well_formed_and_only_for_priced_models():
    for key, changes in pricing.PRICE_CHANGES.items():
        assert key in pricing.CONFIGURED_PRICING, key
        dates = [d for d, _ in changes]
        assert dates == sorted(dates) and len(set(dates)) == len(dates), key
        for d, rate in changes:
            assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", d), key
            assert set(rate) == {"input", "output"}, key


# ---------------------------------------------------------------------------------------------- deliberately unpriced


def test_models_that_a_flat_rate_cannot_price_stay_unknown_with_a_reason():
    assert pricing.UNPRICED, "the unpriced list should not be empty"
    for (provider, model), reason in pricing.UNPRICED.items():
        assert reason.strip(), (provider, model)
        assert pricing.price_for(provider, model) is None, f"{provider}/{model} is both unpriced and priced"
        assert pricing.estimate_cost(provider, model, 1000, 1000) is None
    for key in [("openai", "gpt-image-2"), ("openai", "gpt-realtime-2.1"), ("gemini", "gemini-nano-banana-2.1"),
                ("gemini", "gemini-flash-latest"), ("anthropic", "claude-3-opus"), ("gemini", "lyria-3.5")]:
        assert key in pricing.UNPRICED, key


# ---------------------------------------------------------------------------------------------- audio tables


def test_audio_models_price_by_their_own_unit():
    assert pricing.estimate_duration_cost("openai", "gpt-transcribe", 600) == pytest.approx(0.045)
    assert pricing.estimate_duration_cost("openai", "whisper-1", 60) == pytest.approx(0.006)
    assert pricing.estimate_character_cost("openai", "tts-1-hd", 1_000_000) == 30.0
    assert pricing.estimate_character_cost("openai", "tts-1", 1_000_000) == 15.0
    assert pricing.estimate_duration_cost("openai", "gpt-live-1", 60) is None  # live sessions are not proxied
    # token-billed speech models use the token table, not the duration or character tables
    assert pricing.price_for("openai", "gpt-4o-mini-tts") == {"input": 0.6, "output": 12.0}
    assert pricing.price_for("gemini", "gemini-3.5-transcribe") == {"input": 2.0, "output": 12.0}


# ---------------------------------------------------------------------------------------------- sources


def test_the_catalog_records_where_it_was_verified_and_when():
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", pricing.CATALOG_VERIFIED)
    for provider in ("openai", "anthropic", "gemini"):
        urls = pricing.CATALOG_SOURCES[provider]
        assert urls and all(u.startswith("https://") for u in urls)
