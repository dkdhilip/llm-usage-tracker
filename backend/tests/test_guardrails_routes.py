"""Guardrails PR2 on the wire: every gateway route, through the real app, with the provider mocked.

S1 block / S2 flag / S3 block+flag / S4 no sets / S5-S6 idempotency / S7 streaming / S8 content capture / drift guards."""
import ast
import json
import pathlib
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select, text

from app import content_capture  # noqa: F401  (imported so monkeypatching targets are importable)
from app.config import settings
from app.db import SessionLocal, engine
from app.models import IdempotencyRecord, UsageContent, VirtualKey
from tests.gr_helpers import ALL, ROUTE_IDS, ROUTES, RULE_BLOCK, TRIGGER, call, hits, install, usage


@pytest.fixture()
def on(monkeypatch):
    monkeypatch.setattr(settings, "GUARDRAILS_ENABLED", True)


@pytest.fixture()
def spies(monkeypatch, mock_provider):
    """mock_provider already patches all six provider entry points; its `calls` list proves "never called"."""
    return mock_provider


@pytest.fixture()
def key(make_live_key):
    return make_live_key(allowed_providers=ALL)


def _drain(r):
    return r.text  # consume a streamed body


def kept():
    """Every stored prompt record as (row, decrypted payload)."""
    with SessionLocal() as db:
        return [(r, content_capture.load(r)) for r in db.scalars(select(UsageContent).order_by(UsageContent.id))]


# ---------------------------------------------------------------------------------------- S1 block


@pytest.mark.parametrize("route", ROUTE_IDS)
def test_block_returns_403_before_any_provider_call_and_leaves_no_state(route, on, client, key, spies):
    install(key["id"], RULE_BLOCK)
    last_used = None
    with SessionLocal() as db:
        last_used = db.get(VirtualKey, key["id"]).last_used_at
    r = call(client, key["key"], route, TRIGGER, {"Idempotency-Key": "idem-block-1"})
    assert r.status_code == 403, r.text
    err = r.json()["detail"] if "detail" in r.json() else r.json()["error"]
    assert err["type"] == "guardrail_blocked" and err["code"] == "403"
    assert "bluefalcon" not in r.text.lower()  # the response never echoes what matched
    assert spies == []  # the provider was never called
    rows = usage()
    assert len(rows) == 1 and rows[0].status == "blocked" and rows[0].guardrail == "blocked"
    assert (rows[0].total_tokens, rows[0].cost) == (0, 0.0)
    hs = hits()
    assert len(hs) == 1 and hs[0].action == "block" and hs[0].usage_log_id == rows[0].id
    assert hs[0].expires_at is not None
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(IdempotencyRecord)) == 0  # nothing claimed
        assert db.get(VirtualKey, key["id"]).last_used_at == last_used  # not counted as use
    # the prompt that was blocked is kept for the admin (request side only), although logging is off on this key
    ((row, payload),) = kept()
    assert row.usage_log_id == rows[0].id and "bluefalcon" in json.dumps(payload["request"])
    assert payload["response"] == {"text": "", "summary": ""}


# ----------------------------------------------------------------------------------------- S2 flag


@pytest.mark.parametrize("route", ROUTE_IDS)
def test_flag_lets_the_request_through_and_records_a_hit(route, on, client, key, spies):
    install(key["id"], ("phrase", "bluefalcon", "flag"))
    r = call(client, key["key"], route, TRIGGER)
    assert r.status_code == 200, r.text
    _drain(r)
    assert len(spies) == 1  # the provider was called once
    rows = usage()
    assert len(rows) == 1 and rows[0].status == "success" and rows[0].guardrail == "flagged"
    hs = hits()
    assert len(hs) == 1 and hs[0].action == "flag" and hs[0].usage_log_id == rows[0].id
    # logging is off on this key, yet the flagged prompt is kept (without a response) so the admin can read it
    ((row, payload),) = kept()
    assert row.usage_log_id == rows[0].id and "bluefalcon" in json.dumps(payload["request"])


# ------------------------------------------------------------------------------- S3 block and flag


def test_block_and_flag_both_match_blocked_with_both_hits_in_order(on, client, key, spies):
    install(key["id"], ("phrase", "launch", "flag"), ("phrase", "bluefalcon", "block"), ("regex", r"code\w+", "flag"))
    r = call(client, key["key"], "messages", TRIGGER)
    assert r.status_code == 403 and spies == []
    hs = hits()
    assert [(h.action, h.rule_kind) for h in hs] == [("block", "phrase"), ("flag", "phrase"), ("flag", "regex")]
    assert [h.ordinal for h in hs] == [0, 1, 2]
    assert len(usage()) == 1


def test_a_clean_request_is_untouched(on, client, key, spies):
    install(key["id"], RULE_BLOCK)
    r = call(client, key["key"], "messages", "an ordinary question")
    assert r.status_code == 200 and len(spies) == 1
    assert usage()[0].guardrail is None and hits() == []


# ---------------------------------------------------------------------- S4 no sets / flag off: free


def test_a_key_without_rule_sets_costs_no_extra_queries(on, client, key, spies):
    counts = []

    from sqlalchemy import event

    def count(conn, cursor, statement, *a):
        counts.append(statement)

    r0 = call(client, key["key"], "messages", "warm up")
    assert r0.status_code == 200
    event.listen(engine, "before_cursor_execute", count)
    try:
        call(client, key["key"], "messages", "again")
    finally:
        event.remove(engine, "before_cursor_execute", count)
    touched = ("guardrail_rule", "guardrail_hits", "key_guardrail_sets", "guardrail_version", "guardrail_recording", "audit_events")
    assert not [s for s in counts if any(n in s.lower() for n in touched)]


def test_with_the_flag_off_nothing_is_evaluated_even_with_rules_attached(client, key, spies):
    install(key["id"], RULE_BLOCK)
    assert settings.GUARDRAILS_ENABLED is False
    r = call(client, key["key"], "messages", TRIGGER)
    assert r.status_code == 200 and len(spies) == 1 and hits() == []


# ----------------------------------------------------------------------------- S5/S6 idempotency


def test_a_completed_replay_is_never_re_evaluated(on, client, key, spies):
    h = {"Idempotency-Key": "idem-replay"}
    r1 = call(client, key["key"], "messages", TRIGGER, h)
    assert r1.status_code == 200 and len(spies) == 1
    install(key["id"], RULE_BLOCK)  # the rule now blocks this exact request
    r2 = call(client, key["key"], "messages", TRIGGER, h)
    assert r2.status_code == 200 and r2.json() == r1.json()  # the stored response, replayed
    assert len(spies) == 1 and hits() == []  # no provider call, no hit
    r3 = call(client, key["key"], "messages", TRIGGER, {"Idempotency-Key": "idem-new"})
    assert r3.status_code == 403  # a NEW request is evaluated


def test_a_blocked_request_retried_is_blocked_again_and_never_poisons_the_key(on, client, key, spies):
    rs_install = install(key["id"], RULE_BLOCK)
    h = {"Idempotency-Key": "idem-retry"}
    assert call(client, key["key"], "messages", TRIGGER, h).status_code == 403
    assert call(client, key["key"], "messages", TRIGGER, h).status_code == 403
    assert len(usage()) == 2 and len(hits()) == 2 and spies == []
    with SessionLocal() as db:  # remove the rule: the same key and body now run once
        from app import guardrails
        from app.models import GuardrailRuleSet

        db.get(GuardrailRuleSet, rs_install).enabled = False
        guardrails.bump_version(db, db.get(VirtualKey, key["id"]).workspace_id)
        db.commit()
    ok = call(client, key["key"], "messages", TRIGGER, h)
    assert ok.status_code == 200 and len(spies) == 1


# --------------------------------------------------------------------------------- S7 streaming


@pytest.mark.parametrize("route", [r[0] for r in ROUTES if r[2]])
def test_a_blocked_stream_is_a_plain_json_403_not_an_sse_error(route, on, client, key, spies):
    install(key["id"], RULE_BLOCK)
    r = call(client, key["key"], route, TRIGGER)
    assert r.status_code == 403
    assert r.headers["content-type"].startswith("application/json")
    assert "data:" not in r.text and spies == []
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(IdempotencyRecord)) == 0  # no in-flight lock left


# ------------------------------------------------------------------------------ S8 content capture


def test_with_logging_on_a_flagged_request_keeps_its_response_and_follows_the_guardrail_retention(on, client, make_live_key, spies, admin_client, monkeypatch):
    monkeypatch.setattr(settings, "CONTENT_RETENTION_DAYS", 7)
    assert admin_client.patch("/api/workspace/content-logging", json={"enabled": True}).status_code == 200
    key = make_live_key(allowed_providers=ALL, content_logging_enabled=True)
    install(key["id"], ("phrase", "launch", "flag"))
    assert call(client, key["key"], "messages", "the launch is soon").status_code == 200
    ((row, payload),) = kept()
    assert payload["response"]["text"]  # the normal record: prompt AND response
    assert row.expires_at > datetime.now(UTC) + timedelta(days=settings.GUARDRAIL_RETENTION_DAYS - 1)  # not the shorter 7 days
    plain = make_live_key(allowed_providers=ALL, content_logging_enabled=True)
    assert call(client, plain["key"], "messages", "an ordinary question").status_code == 200
    assert len(kept()) == 2 and kept()[1][0].expires_at < datetime.now(UTC) + timedelta(days=8)  # unflagged: unchanged


def test_the_admin_reads_a_blocked_prompt_from_the_request_inspector_endpoint(on, client, make_live_key, spies, admin_client):
    key = make_live_key(allowed_providers=ALL)  # logging is off for the workspace and the key
    install(key["id"], RULE_BLOCK)
    assert call(client, key["key"], "messages", TRIGGER).status_code == 403
    uid = usage()[0].id
    r = admin_client.get(f"/api/requests/{uid}/content")
    j = r.json()
    assert r.status_code == 200 and j["content_status"] == "available" and r.headers["cache-control"] == "no-store"
    assert TRIGGER in json.dumps(j["content"]["request"])
    assert [x for x in admin_client.get("/api/requests").json()["items"] if x["id"] == uid][0]["has_content"] is True


def test_a_kept_prompt_follows_the_guardrail_retention_and_goes_with_the_blocked_row(on, client, make_live_key, spies, monkeypatch):
    monkeypatch.setattr(settings, "CONTENT_RETENTION_DAYS", 7)  # a shorter content-logging retention must not shorten it
    key = make_live_key(allowed_providers=ALL)
    install(key["id"], RULE_BLOCK)
    assert call(client, key["key"], "messages", TRIGGER).status_code == 403
    ((row, _),) = kept()
    assert row.expires_at > datetime.now(UTC) + timedelta(days=settings.GUARDRAIL_RETENTION_DAYS - 1)
    with SessionLocal() as db:  # the blocked usage row is deleted by the guardrail sweep: the prompt cascades with it
        from app.models import UsageLog

        db.query(UsageLog).delete()
        db.commit()
        assert db.scalar(select(func.count()).select_from(UsageContent)) == 0


def test_a_credential_in_a_kept_prompt_is_redacted_like_any_stored_prompt(on, client, make_live_key, spies):
    key = make_live_key(allowed_providers=ALL)
    install(key["id"], RULE_BLOCK)
    assert call(client, key["key"], "messages", TRIGGER + " key sk-abcdefghijklmnopqrstuvwxyz0123").status_code == 403
    ((_, payload),) = kept()
    text = json.dumps(payload["request"])
    assert "sk-abcdefghijklmnopqrstuvwxyz0123" not in text and "[REDACTED:openai-key]" in text and "bluefalcon" in text


@pytest.mark.parametrize("action,status", [("block", 403), ("flag", 200)])
def test_a_secret_detector_match_never_keeps_the_prompt(action, status, on, client, make_live_key, spies):
    key = make_live_key(allowed_providers=ALL)
    install(key["id"], ("preset", "card", action))
    r = call(client, key["key"], "messages", "charge 4111 1111 1111 1111 please")
    assert r.status_code == status and len(hits()) == 1
    assert kept() == []  # the card number is nowhere in storage


def test_a_card_match_next_to_a_word_match_keeps_nothing_forced(on, client, make_live_key, spies):
    key = make_live_key(allowed_providers=ALL)
    install(key["id"], ("preset", "card", "flag"), ("phrase", "bluefalcon", "flag"))
    assert call(client, key["key"], "messages", "bluefalcon card 4111 1111 1111 1111").status_code == 200
    assert kept() == []  # the prompt holds a card number, so it is not kept on the rules' account


def test_no_prompt_is_kept_once_the_recording_ceiling_is_reached_but_blocking_continues(on, client, make_live_key, spies, monkeypatch):
    monkeypatch.setattr(settings, "GUARDRAIL_RECORDING_CEILING_PER_HOUR", 0)
    key = make_live_key(allowed_providers=ALL)
    install(key["id"], RULE_BLOCK)
    assert call(client, key["key"], "messages", TRIGGER).status_code == 403 and spies == []
    assert kept() == [] and hits() == []


# --------------------------------------------------------------------------- tenancy and edges


def test_another_workspaces_rules_never_apply(on, client, key, spies, new_admin, make_live_key):
    other_client, _ = new_admin("Other")
    other_client.put("/api/workspace/providers/anthropic/key", json={"api_key": "sk-fake-anthropic-key-000000"})
    ok = other_client.post("/api/keys", json={"label": "o1", "allowed_providers": ["anthropic"], "allow_live": True}).json()
    install(key["id"], RULE_BLOCK)  # attached to the first workspace's key only
    r = call(client, ok["key"], "messages", TRIGGER)
    assert r.status_code == 200


def test_rule_changes_apply_to_the_very_next_request(on, client, key, spies):
    sid = install(key["id"], RULE_BLOCK)
    assert call(client, key["key"], "messages", TRIGGER).status_code == 403
    from app import guardrails
    from app.models import GuardrailRule

    with SessionLocal() as db:
        rule = db.scalar(select(GuardrailRule).where(GuardrailRule.rule_set_id == sid))
        rule.enabled = False
        guardrails.bump_version(db, db.get(VirtualKey, key["id"]).workspace_id)
        db.commit()
    assert call(client, key["key"], "messages", TRIGGER).status_code == 200  # no staleness window
    with SessionLocal() as db:
        rule = db.scalar(select(GuardrailRule).where(GuardrailRule.rule_set_id == sid))
        rule.enabled = True
        guardrails.bump_version(db, db.get(VirtualKey, key["id"]).workspace_id)
        db.commit()
    assert call(client, key["key"], "messages", TRIGGER).status_code == 403


def test_a_stale_cache_entry_with_an_older_version_is_ignored(on, client, key, spies):
    from app import guardrails

    install(key["id"], RULE_BLOCK)
    assert call(client, key["key"], "messages", "fine").status_code == 200  # fills the cache at version N
    with SessionLocal() as db:
        guardrails.bump_version(db, db.get(VirtualKey, key["id"]).workspace_id)
        db.execute(text("DELETE FROM guardrail_rules"))  # rules vanish behind the cache's back
        db.commit()
    assert call(client, key["key"], "messages", TRIGGER).status_code == 200


def test_a_member_key_is_evaluated_like_any_other(on, client, key, spies):
    """Evaluation depends only on the key, not on who owns it."""
    install(key["id"], RULE_BLOCK)
    assert call(client, key["key"], "responses", {"x": 1}.__repr__() + TRIGGER).status_code == 403


# ------------------------------------------------------------------------------ S18 drift guards

_ROUTERS = pathlib.Path(__file__).resolve().parent.parent / "app" / "routers"
_GATE = {"claim", "claim_streaming", "run_native_completion", "run_native_completion_raw", "run_completion", "begin",
         "stream_native_passthrough", "record_usage", "record_usage_detached"}


def _handlers():
    for path in sorted(_ROUTERS.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for fn in [n for n in tree.body if isinstance(n, ast.FunctionDef)]:
            if any(isinstance(d, ast.Call) and getattr(d.func, "attr", "") == "post" for d in fn.decorator_list):
                yield path.name, fn


def _calls(fn):
    out = []
    for node in ast.walk(fn):
        if isinstance(node, ast.Call):
            f = node.func
            name = f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", "")
            owner = getattr(getattr(f, "value", None), "id", "")
            out.append((node.lineno, node.col_offset, name, owner))
    return sorted(out)


def test_every_gateway_post_handler_calls_the_guard_before_claiming_capturing_or_calling_a_provider():
    gateway_files = {"openai_compat.py", "messages.py", "responses.py", "embeddings.py", "images.py", "audio.py", "gemini.py", "proxy.py"}
    seen = 0
    for fname, fn in _handlers():
        if fname not in gateway_files:
            continue
        seen += 1
        calls = _calls(fn)
        guards = [c for c in calls if c[2] == "enforce_guardrails"]
        assert guards, f"{fname}:{fn.name} has no enforce_guardrails call"
        first = min(c[0] for c in guards)
        for line, _, name, owner in calls:
            risky = (name in _GATE - {"begin"}) or (name == "begin" and owner == "content_capture")
            if risky and name != "enforce_guardrails":
                assert line > first or (line == first and False), f"{fname}:{fn.name} line {line}: {name} before the guard"
    assert seen == 12  # chat, messages, responses, embeddings, images, 2 audio, 4 gemini, proxy


def test_the_route_table_covers_every_gateway_post_route():
    from app.main import app

    gateway = {
        path for path, ops in app.openapi()["paths"].items()
        if "post" in ops and (path.startswith("/v1/") or path.startswith("/v1beta/"))
    }
    covered = {
        "/v1/chat/completions", "/v1/messages", "/v1/responses", "/v1/embeddings", "/v1/images/generations",
        "/v1/audio/transcriptions", "/v1/audio/speech", "/v1/proxy/chat",
        "/v1beta/models/{model}:generateContent", "/v1beta/models/{model}:streamGenerateContent",
        "/v1beta/models/{model}:embedContent", "/v1beta/models/{model}:batchEmbedContents",
    }
    assert gateway == covered, gateway ^ covered
