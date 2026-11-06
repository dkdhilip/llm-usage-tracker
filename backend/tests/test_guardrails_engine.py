"""Guardrails PR2: the engine (pure), evidence safety, the recording ceiling, fail-open behaviour, retention, limits."""
import datetime as dt
import logging
import random
import threading
import time

import pytest
from fastapi import HTTPException
from sqlalchemy import event, func, select, text
from sqlalchemy.exc import OperationalError

from app import crypto
from app import guardrails as g
from app.config import settings
from app.db import SessionLocal, engine
from app.models import AuditEvent, GuardrailHit, GuardrailRule, UsageLog, VirtualKey
from tests.gr_helpers import ALL, RULE_BLOCK, TRIGGER, call, hits, install, usage


def rule(i, kind, pat, action="block", whole_word=False, **kw):
    row = GuardrailRule(id=i, name=f"r{i}", kind=kind, pattern=None if kind == "preset" else pat,
                        preset_id=pat if kind == "preset" else None, action=action, whole_word=whole_word, **kw)
    compiled = g.compile_rule(row, "Set")
    assert compiled is not None, (kind, pat)
    return compiled


def ev(body, *rules, **kw):
    segs, over = g.extract_segments(body)
    return g.evaluate(segs, list(rules), oversize=over, **kw)


def user(t):
    return {"messages": [{"role": "user", "content": t}]}


@pytest.fixture()
def on(monkeypatch):
    monkeypatch.setattr(settings, "GUARDRAILS_ENABLED", True)


# ------------------------------------------------------------------------------------------ extraction


def test_extraction_reads_every_text_field_and_skips_binary():
    body = {
        "model": "m-secret-name",
        "system": "sys text",
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": "part one"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64," + "A" * 50}}]},
            {"role": "assistant", "content": "earlier reply", "tool_calls": [{"id": "x", "function": {"name": "f", "arguments": "{\"q\": \"tool arg\"}"}}]},
        ],
        "input": ["emb one", "emb two"],
        "contents": [{"parts": [{"text": "gemini text"}, {"inlineData": {"mimeType": "audio/wav", "data": "B" * 5000}}]}],
    }
    segs, over = g.extract_segments(body)
    texts = [s.text for s in segs]
    for want in ("sys text", "part one", "earlier reply", "tool arg", "emb one", "emb two", "gemini text"):
        assert any(want in t for t in texts), want
    joined = " ".join(texts)
    assert "m-secret-name" not in joined and "A" * 20 not in joined and "B" * 20 not in joined
    assert not over
    assert {s.role for s in segs} >= {"user", "system", "assistant"}


def test_scan_cap_marks_oversize_and_still_scans_the_head(monkeypatch):
    monkeypatch.setattr(settings, "GUARDRAIL_SCAN_CAP_CHARS", 1000)
    d = ev(user("bluefalcon " + "x " * 5000), rule(1, "phrase", "bluefalcon"))
    assert d.blocked and d.unchecked and "oversize" in d.reasons


# ---------------------------------------------------------------------------------------------- matching


def test_phrase_matching_is_case_insensitive_and_whole_word_optional():
    assert ev(user("Hello BlueFalcon!"), rule(1, "phrase", "bluefalcon")).blocked
    assert ev(user("bluefalcons"), rule(1, "phrase", "bluefalcon")).blocked
    assert not ev(user("bluefalcons"), rule(1, "phrase", "bluefalcon", whole_word=True)).blocked
    assert ev(user("the bluefalcon."), rule(1, "phrase", "bluefalcon", whole_word=True)).blocked


def test_obfuscation_by_width_case_and_zero_width_characters_is_normalised():
    for t in ("ＢＬＵＥＦＡＬＣＯＮ", "blue​falcon", "BLUE­FALCON", "blue﻿falcon", "bluefalcon"):
        assert ev(user(t), rule(1, "phrase", "bluefalcon")).blocked, repr(t)


def test_regex_rules_run_on_the_original_text_with_the_admins_flags():
    assert ev(user("Code-4411"), rule(1, "regex", r"Code-\d+")).blocked
    assert not ev(user("code-4411"), rule(1, "regex", r"Code-\d+")).blocked  # case matters unless the admin says (?i)
    assert ev(user("code-4411"), rule(1, "regex", r"(?i)Code-\d+")).blocked


def test_presets_card_api_key_private_key_email():
    assert ev(user("pay with 4111 1111 1111 1111 now"), rule(1, "preset", "card")).blocked
    assert not ev(user("order 4111 1111 1111 1112"), rule(1, "preset", "card")).blocked  # fails Luhn
    assert ev(user("key sk-abcdefghijklmnopqrstuv"), rule(2, "preset", "api_key")).blocked
    assert ev(user("-----BEGIN RSA PRIVATE KEY-----"), rule(3, "preset", "private_key")).blocked
    assert ev(user("mail me at Jane.Doe@example.com"), rule(4, "preset", "email")).blocked
    assert not ev(user("nothing here"), rule(1, "preset", "card"), rule(2, "preset", "email")).hits


def test_all_rules_run_block_wins_and_hits_are_ordered_and_unique_per_rule():
    d = ev(user("alpha beta alpha gamma"), rule(5, "phrase", "gamma", "flag"), rule(2, "phrase", "alpha", "block"),
           rule(9, "regex", r"bet\w", "flag"), rule(1, "phrase", "zzz", "block"))
    assert d.blocked
    assert [(h.rule.id, h.rule.action) for h in d.hits] == [(2, "block"), (5, "flag"), (9, "flag")]
    assert d.hits[0].occurrences == 2
    assert [h.ordinal for h in d.hits] == [0, 1, 2]


def test_only_flag_rules_do_not_block():
    d = ev(user("alpha"), rule(1, "phrase", "alpha", "flag"))
    assert not d.blocked and len(d.hits) == 1 and not d.unchecked


def test_hit_cap_per_request(monkeypatch):
    monkeypatch.setattr(settings, "GUARDRAIL_MAX_HITS_PER_REQUEST", 3)
    rules = [rule(i, "phrase", f"w{i}", "flag") for i in range(1, 8)]
    d = ev(user(" ".join(f"w{i}" for i in range(1, 8))), *rules)
    assert len(d.hits) == 3


# ------------------------------------------------------------------------ budget / timeouts / failures


def test_a_regex_that_times_out_is_skipped_marks_unchecked_and_other_rules_still_run():
    evil = rule(1, "regex", r"(a|aa)+$", "block")
    d = ev(user("a" * 60 + "b and bluefalcon"), evil, rule(2, "phrase", "bluefalcon", "block"))
    assert d.unchecked and "rule_timeout" in d.reasons
    assert d.blocked and [h.rule.id for h in d.hits] == [2]  # the other rule's block still counts


def test_time_budget_stops_evaluation_but_a_block_already_found_still_blocks(monkeypatch):
    monkeypatch.setattr(settings, "GUARDRAIL_EVAL_BUDGET_MS", 5)
    real = g._scan
    n = {"c": 0}

    def slow(r, seg, timeout):
        n["c"] += 1
        if n["c"] > 1:
            time.sleep(0.02)
        return real(r, seg, timeout)

    monkeypatch.setattr(g, "_scan", slow)
    rules = [rule(1, "phrase", "bluefalcon", "block")] + [rule(i, "phrase", f"x{i}", "flag") for i in range(2, 9)]
    segs = g.extract_segments(user("bluefalcon is here. " * 3))[0]
    d = g.evaluate(segs, rules)
    assert d.blocked and d.unchecked and "time_budget" in d.reasons
    assert [h.rule.id for h in d.hits] == [1]


def test_invalid_stored_rules_are_skipped_not_raised():
    assert g.compile_rule(GuardrailRule(id=1, name="x", kind="regex", pattern="(unclosed", action="block"), "S") is None
    assert g.compile_rule(GuardrailRule(id=1, name="x", kind="regex", pattern="a" * 500, action="block"), "S") is None
    assert g.compile_rule(GuardrailRule(id=1, name="x", kind="preset", preset_id="nope", action="block"), "S") is None


# --------------------------------------------------------------- S14 normalization, snippets, redaction


UNICODE_CASES = [
    ("Straße", "strasse"), ("ﬁnal ﬃ", "final ffi"), ("ＦＵＬＬ ＷＩＤＴＨ １２３", "full width 123"),
    ("Café au lait", "café"), ("İstanbul", "i̇stanbul"), ("é̂ stack", "stack"),
    ("blue​fal‍con", "bluefalcon"), ("👨‍👩‍👧 family bluefalcon", "bluefalcon"),
    ("한국어 bluefalcon 텍스트", "bluefalcon"), ("שלום bluefalcon ‮עולם", "bluefalcon"),
    ("😀 bluefalcon 😀", "bluefalcon"), ("a\ud800b bluefalcon", "bluefalcon"), ("x" * 5000 + "bluefalcon", "bluefalcon"),
]


@pytest.mark.parametrize("original,needle", UNICODE_CASES)
def test_snippets_are_either_verified_or_absent_and_keep_the_matched_words_apart_from_the_context(original, needle):
    try:
        original.encode("utf-8")
    except UnicodeEncodeError:
        original = original.encode("utf-8", "replace").decode("utf-8")
    d = ev(user(f"{original} and some more text"), rule(1, "phrase", needle, "flag"))
    for h in d.hits:
        if h.snippet is not None:
            context, match = g.split_snippet(h.snippet)
            assert "[matched]" in context and len(context) <= 120
            assert match and len(match) <= 60 and g._fold(match) == g._fold(needle)  # the words as they were written
            assert not any(ord(c) < 32 for c in context + match)


def test_mapped_spans_land_on_cluster_boundaries_and_refold_to_the_match():
    rnd = random.Random(7)
    pool = list("abcXYZ ßﬁÉéİ１２３​́̂‍😀한글 ­") + ["ﬃ", "é", "bluefalcon"]
    checked = 0
    for _ in range(400):
        s = "".join(rnd.choice(pool) for _ in range(rnd.randint(5, 40))) + " bluefalcon " + "".join(rnd.choice(pool) for _ in range(10))
        norm = g._fold(s)
        i = norm.find("bluefalcon")
        if i < 0:
            continue
        m = g.map_span(s, norm, i, i + 10)
        if m is None:
            continue  # unreliable ⇒ no snippet: allowed
        checked += 1
        assert g._fold(s[m[0]:m[1]]) == "bluefalcon"
        cl = g._clusters(s)
        assert m[0] in {a for a, _ in cl} and m[1] in {b for _, b in cl}
    assert checked > 50


def test_secret_presets_store_no_snippet_and_context_is_masked():
    d = ev(user("my card is 4111 1111 1111 1111 thanks"), rule(1, "preset", "card"))
    assert d.hits[0].snippet is None
    d = ev(user("password: hunter2 token abcdefghijklmnopqrstuvwxyz0123 id 1234567890123 then bluefalcon end"),
           rule(2, "phrase", "bluefalcon", "flag"))
    snip, match = g.split_snippet(d.hits[0].snippet)
    assert snip and "abcdefghijklmnopqrstuvwxyz0123" not in snip and "1234567890123" not in snip and "[matched]" in snip
    assert match == "bluefalcon"


def test_a_word_rule_keeps_the_matched_words_as_written_even_when_repeated_next_to_it():
    d = ev(user("Please keep BlueFalcon bluefalcon quiet"), rule(1, "phrase", "bluefalcon", "flag"))
    context, match = g.split_snippet(d.hits[0].snippet)
    assert match == "BlueFalcon" and context.startswith("Please keep [matched]") and "[matched]" in context


def test_a_matched_word_is_cleaned_like_the_context_and_cut_short():
    d = ev(user("x 4111111111111111 y"), rule(1, "phrase", "4111111111111111", "flag"))
    assert g.split_snippet(d.hits[0].snippet)[1] == "[digits]"  # long digit runs are masked even when they are the match
    d = ev(user("a " + "word " * 40 + "end"), rule(1, "phrase", "word " * 40, "flag"))
    assert len(g.split_snippet(d.hits[0].snippet)[1]) == 60


def test_a_pattern_rule_still_hides_the_matched_text_and_a_repeated_word_means_no_snippet():
    d = ev(user("bluefalcon bluefalcon"), rule(1, "regex", "bluefalcon", "flag"))
    assert d.hits[0].snippet is None
    d = ev(user("please keep bluefalcon quiet"), rule(1, "regex", "bluefalcon", "flag"))
    assert g.split_snippet(d.hits[0].snippet) == ("please keep [matched] quiet", None)


# ------------------------------------------------------ evidence: what is stored, and how it is stored


def test_stored_snippet_is_encrypted_and_holds_the_matched_words_only_for_a_word_rule(on, client, make_live_key, mock_provider):
    key = make_live_key(allowed_providers=ALL)
    install(key["id"], ("phrase", "bluefalcon", "flag"))
    assert call(client, key["key"], "messages", "please keep the bluefalcon plan quiet").status_code == 200
    h = hits()[0]
    assert h.snippet_enc and "bluefalcon" not in h.snippet_enc and "plan" not in h.snippet_enc  # ciphertext only
    context, match = g.split_snippet(crypto.decrypt(h.snippet_enc))
    assert match == "bluefalcon" and "bluefalcon" not in context and "[matched]" in context
    row = usage()[0]
    assert "bluefalcon" not in (row.prompt_preview or "") or settings.LOG_BODIES  # unchanged behaviour


# ------------------------------------------------------------------------- fail open and its logging


def _no_leak(caplog, *needles):
    for rec in caplog.records:
        msg = rec.getMessage()
        for n in needles:
            assert n.lower() not in msg.lower(), (n, msg)


def test_an_engine_error_fails_open_marks_unchecked_and_logs_only_class_names(on, client, make_live_key, mock_provider, monkeypatch, caplog):
    key = make_live_key(allowed_providers=ALL)
    install(key["id"], RULE_BLOCK)

    def boom(body):
        raise RuntimeError("SECRETPARAM bluefalcon")

    monkeypatch.setattr(g, "extract_segments", boom)
    with caplog.at_level(logging.INFO):
        r = call(client, key["key"], "messages", TRIGGER)
    assert r.status_code == 200 and len(mock_provider) == 1  # failed open
    assert usage()[0].guardrail == "unchecked" and hits() == []
    lines = [r.getMessage() for r in caplog.records if "guardrail_skipped" in r.getMessage()]
    assert lines and "reason=engine_error" in lines[0] and "exc=RuntimeError" in lines[0]
    _no_leak(caplog, "SECRETPARAM", "bluefalcon", TRIGGER)


def test_skip_logs_are_throttled_with_a_suppressed_count(on, client, make_live_key, mock_provider, monkeypatch, caplog):
    key = make_live_key(allowed_providers=ALL)
    install(key["id"], RULE_BLOCK)
    monkeypatch.setattr(g, "extract_segments", lambda b: (_ for _ in ()).throw(RuntimeError("x")))
    with caplog.at_level(logging.INFO):
        for _ in range(4):
            call(client, key["key"], "messages", "hi")
    assert len([r for r in caplog.records if "guardrail_skipped" in r.getMessage()]) == 1
    assert g.status()["counters"]["skipped_engine_error"] == 4


# ------------------------------------------------------------- evidence failure never changes a block

FAULTS = {
    "operational": lambda *a, **k: (_ for _ in ()).throw(OperationalError("INSERT SECRETPARAM bluefalcon", {"p": "bluefalcon"}, Exception("boom"))),
    "runtime": lambda *a, **k: (_ for _ in ()).throw(RuntimeError("SECRETPARAM bluefalcon")),
}


@pytest.mark.parametrize("fault", sorted(FAULTS))
@pytest.mark.parametrize("route", ["messages", "chat-native", "proxy-chat", "gemini-generate", "responses-stream"])
def test_a_block_is_enforced_even_if_recording_its_evidence_fails(fault, route, on, client, make_live_key, mock_provider, monkeypatch, caplog):
    key = make_live_key(allowed_providers=ALL)
    install(key["id"], RULE_BLOCK)
    monkeypatch.setattr(g, "admit", FAULTS[fault])
    with caplog.at_level(logging.INFO):
        r = call(client, key["key"], route, TRIGGER)
    assert r.status_code == 403 and "guardrail_blocked" in r.text
    assert mock_provider == [] and usage() == [] and hits() == []  # all-or-nothing: no half-written evidence
    lines = [r.getMessage() for r in caplog.records if "guardrail_evidence_failed" in r.getMessage()]
    assert lines and "exc=" in lines[0]
    _no_leak(caplog, "SECRETPARAM", "bluefalcon", TRIGGER, "boom")
    assert g.status()["counters"].get("blocked") == 1


def test_the_evidence_gap_becomes_a_persistent_audit_event_after_recovery(on, client, make_live_key, mock_provider, monkeypatch):
    key = make_live_key(allowed_providers=ALL)
    install(key["id"], RULE_BLOCK)
    real = g.admit
    monkeypatch.setattr(g, "admit", FAULTS["runtime"])
    for _ in range(2):
        assert call(client, key["key"], "messages", TRIGGER).status_code == 403
    monkeypatch.setattr(g, "admit", real)
    assert call(client, key["key"], "messages", TRIGGER).status_code == 403
    with SessionLocal() as db:
        ev_rows = list(db.scalars(select(AuditEvent).where(AuditEvent.action == "guardrail.evidence_gap")))
    assert len(ev_rows) == 1 and ev_rows[0].detail["count"] == 2
    assert "bluefalcon" not in str(ev_rows[0].detail)
    assert len(usage()) == 1  # the recovered request is recorded normally


def test_a_failing_flag_hit_write_still_records_the_usage_row(on, client, make_live_key, mock_provider, monkeypatch):
    key = make_live_key(allowed_providers=ALL)
    install(key["id"], ("phrase", "bluefalcon", "flag"))
    monkeypatch.setattr(g, "_hit_rows", FAULTS["runtime"])
    r = call(client, key["key"], "messages", TRIGGER)
    assert r.status_code == 200
    rows = usage()
    assert len(rows) == 1 and rows[0].guardrail == "flagged" and hits() == []


# ----------------------------------------------------------------------------- recording ceiling


def _enforce_blocked(key_id: int) -> int:
    with SessionLocal() as db:
        vk = db.get(VirtualKey, key_id)
        try:
            g.enforce_guardrails(db, vk, "messages", user(TRIGGER), "openai", "gpt-4o-mini")
        except HTTPException as exc:
            return exc.status_code
    return 200


def test_burst_above_the_ceiling_blocks_everything_but_records_exactly_the_ceiling(on, make_live_key, monkeypatch):
    monkeypatch.setattr(settings, "GUARDRAIL_RECORDING_CEILING_PER_HOUR", 5)
    key = make_live_key(allowed_providers=ALL)
    install(key["id"], RULE_BLOCK)
    out: list[int] = []
    start = threading.Barrier(15)

    def worker():
        start.wait(10)
        out.append(_enforce_blocked(key["id"]))

    ts = [threading.Thread(target=worker) for _ in range(15)]
    [t.start() for t in ts]
    [t.join(30) for t in ts]
    assert out == [403] * 15  # enforcement never depends on the ceiling
    assert len(usage()) == 5 and len(hits()) == 5  # exactly the ceiling was admitted
    with SessionLocal() as db:
        c = db.execute(text("SELECT recorded, throttled_at FROM guardrail_recording_counters")).one()
    assert c.recorded == 5 and c.throttled_at is not None


def test_after_the_ceiling_there_is_no_further_database_work_for_evidence(on, make_live_key, monkeypatch):
    monkeypatch.setattr(settings, "GUARDRAIL_RECORDING_CEILING_PER_HOUR", 1)
    key = make_live_key(allowed_providers=ALL)
    install(key["id"], RULE_BLOCK)
    for _ in range(2):  # one admitted, one refused (which arms the in-process memo)
        assert _enforce_blocked(key["id"]) == 403
    seen: list[str] = []

    def spy(conn, cursor, statement, *a):
        seen.append(statement)

    event.listen(engine, "before_cursor_execute", spy)
    try:
        assert _enforce_blocked(key["id"]) == 403
    finally:
        event.remove(engine, "before_cursor_execute", spy)
    assert not [s for s in seen if "guardrail_recording_counters" in s or "INSERT INTO usage_logs" in s]
    assert len(usage()) == 1


def test_ceiling_zero_records_nothing_and_still_blocks(on, client, make_live_key, mock_provider, monkeypatch):
    monkeypatch.setattr(settings, "GUARDRAIL_RECORDING_CEILING_PER_HOUR", 0)
    key = make_live_key(allowed_providers=ALL)
    install(key["id"], RULE_BLOCK)
    assert call(client, key["key"], "messages", TRIGGER).status_code == 403
    assert mock_provider == [] and usage() == [] and hits() == []


def test_a_flagged_request_over_the_ceiling_keeps_its_usage_row_without_hits(on, client, make_live_key, mock_provider, monkeypatch):
    monkeypatch.setattr(settings, "GUARDRAIL_RECORDING_CEILING_PER_HOUR", 0)
    key = make_live_key(allowed_providers=ALL)
    install(key["id"], ("phrase", "bluefalcon", "flag"))
    assert call(client, key["key"], "messages", TRIGGER).status_code == 200
    assert usage()[0].guardrail == "flagged" and hits() == []


# -------------------------------------------------------------------------------------- retention


def _seed_hit(db, vk, *, usage_ts, expires_in_days, status="success", guardrail="flagged", rid="r"):
    row = UsageLog(key_id=vk.id, request_id=rid, provider="openai", model="m", prompt_tokens=0, completion_tokens=0,
                   total_tokens=0, cost=0.0, cost_source="configured", latency_ms=1, status=status, guardrail=guardrail,
                   ts=usage_ts)
    db.add(row)
    db.flush()
    db.add(GuardrailHit(workspace_id=vk.workspace_id, key_id=vk.id, usage_log_id=row.id, rule_id=None, rule_name="n",
                        rule_set_name="s", rule_kind="phrase", action="flag", ordinal=0, occurrences=1,
                        snippet_enc=crypto.encrypt("x [matched] y"),
                        expires_at=dt.datetime.now(dt.UTC) + dt.timedelta(days=expires_in_days)))
    return row


def test_retention_deletes_the_whole_hit_and_blocked_rows_but_keeps_ordinary_usage(make_live_key, monkeypatch):
    key = make_live_key(allowed_providers=ALL)
    now = dt.datetime.now(dt.UTC)
    with SessionLocal() as db:
        vk = db.get(VirtualKey, key["id"])
        old_flag = _seed_hit(db, vk, usage_ts=now - dt.timedelta(days=31), expires_in_days=-1, rid="old-flag")
        _seed_hit(db, vk, usage_ts=now - dt.timedelta(days=31), expires_in_days=-1, status="blocked", guardrail="blocked", rid="old-blocked")
        _seed_hit(db, vk, usage_ts=now - dt.timedelta(days=2), expires_in_days=28, rid="new-flag")
        _seed_hit(db, vk, usage_ts=now - dt.timedelta(days=2), expires_in_days=28, status="blocked", guardrail="blocked", rid="new-blocked")
        db.commit()
        old_flag_id = old_flag.id
    monkeypatch.setattr(settings, "CONTENT_RETENTION_DAYS", 1)  # content logging's setting must not shorten this
    with SessionLocal() as db:
        out = g.sweep(db)
    assert out["hits"] == 2 and out["blocked_rows"] == 1
    rids = sorted(u.request_id for u in usage())
    assert rids == ["new-blocked", "new-flag", "old-flag"]  # the ordinary old usage row stays
    assert sorted(h.usage_log_id for h in hits()) and len(hits()) == 2
    with SessionLocal() as db:
        assert db.get(UsageLog, old_flag_id).guardrail == "flagged"  # keeps its marker; only the hit record went


def test_the_retention_setting_is_independent_and_capped_at_30_days():
    from pydantic import ValidationError

    from app.config import Settings

    with pytest.raises(ValidationError):
        Settings(GUARDRAIL_RETENTION_DAYS=31)
    assert Settings().GUARDRAIL_RETENTION_DAYS == 30


def test_expiry_is_set_from_the_guardrail_setting_not_the_content_one(on, client, make_live_key, mock_provider, monkeypatch):
    monkeypatch.setattr(settings, "CONTENT_RETENTION_DAYS", 1)
    key = make_live_key(allowed_providers=ALL)
    install(key["id"], RULE_BLOCK)
    call(client, key["key"], "messages", TRIGGER)
    h = hits()[0]
    days = (h.expires_at - dt.datetime.now(dt.UTC)).total_seconds() / 86400
    assert 29.9 < days <= 30


# ------------------------------------------------------------------------------------------- limits


def test_attach_enforces_the_per_key_set_limit_and_workspace_ownership(make_live_key, new_admin):
    key = make_live_key(allowed_providers=ALL)
    from app.models import GuardrailRuleSet

    with SessionLocal() as db:
        vk = db.get(VirtualKey, key["id"])
        sets = [GuardrailRuleSet(workspace_id=vk.workspace_id, name=f"s{i}") for i in range(settings.GUARDRAIL_MAX_SETS_PER_KEY + 1)]
        db.add_all(sets)
        db.flush()
        with pytest.raises(ValueError):
            g.attach_rule_sets(db, vk, [s.id for s in sets])
        with pytest.raises(ValueError):
            g.attach_rule_sets(db, vk, [999999])
        g.attach_rule_sets(db, vk, [sets[0].id])
        assert vk.has_guardrails is True
        g.attach_rule_sets(db, vk, [])
        assert vk.has_guardrails is False
        db.rollback()


def test_the_workspace_version_is_bumped_by_attach(make_live_key):
    key = make_live_key(allowed_providers=ALL)
    with SessionLocal() as db:
        v0 = db.scalar(select(func.count()).select_from(VirtualKey))
        assert v0 == 1
    install(key["id"], RULE_BLOCK)
    with SessionLocal() as db:
        vk = db.get(VirtualKey, key["id"])
        from app.models import Workspace

        assert db.get(Workspace, vk.workspace_id).guardrail_version >= 1
