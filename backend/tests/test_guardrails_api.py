"""Guardrails PR3: the admin API, the hits/notification feed, the audit trail, key attachment and the Requests fields.

Rule sets are built through the HTTP API here (not the ORM), so the validation, version bump and audit behaviour that
the gateway depends on are exercised end to end."""
import pytest
from sqlalchemy import select

from app import guardrails as g
from app.config import settings
from app.db import SessionLocal
from app.models import AuditEvent, VirtualKey, Workspace
from tests.gr_helpers import ALL, TRIGGER, call


@pytest.fixture()
def on(monkeypatch):
    monkeypatch.setattr(settings, "GUARDRAILS_ENABLED", True)


def mk_set(c, name="Secrets", **kw):
    r = c.post("/api/guardrails/rule-sets", json={"name": name, **kw})
    assert r.status_code == 200, r.text
    return r.json()


def mk_rule(c, set_id, **kw):
    body = {"name": "r", "kind": "phrase", "pattern": "bluefalcon", "action": "block", **kw}
    r = c.post(f"/api/guardrails/rule-sets/{set_id}/rules", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def attach(c, key_id, *set_ids):
    r = c.put(f"/api/guardrails/keys/{key_id}/rule-sets", json={"rule_set_ids": list(set_ids)})
    assert r.status_code == 200, r.text
    return r.json()


def audit_actions():
    with SessionLocal() as db:
        return [a.action for a in db.scalars(select(AuditEvent).order_by(AuditEvent.id))]


@pytest.fixture()
def setup(admin_client, make_live_key):
    key = make_live_key(allowed_providers=ALL)
    return admin_client, key


# ------------------------------------------------------------------------------------ permissions, tenancy


def test_members_and_anonymous_get_403_or_401_everywhere(admin_client, new_member, client):
    s = mk_set(admin_client)
    member, _ = new_member(admin_client)
    paths = [("get", "/api/guardrails/rule-sets"), ("post", "/api/guardrails/rule-sets"), ("get", "/api/guardrails/hits"),
             ("get", "/api/guardrails/unread-count"), ("get", "/api/guardrails/status"), ("get", "/api/guardrails/activity"),
             ("post", "/api/guardrails/hits/review"), ("post", "/api/guardrails/test"), ("get", "/api/guardrails/presets"),
             ("delete", f"/api/guardrails/rule-sets/{s['id']}"), ("get", "/api/guardrails/hits/items")]
    for method, path in paths:
        r = getattr(member, method)(path, **({"json": {}} if method == "post" else {}))
        assert r.status_code == 403, (method, path, r.status_code)
        r = getattr(client, method)(path, **({"json": {}} if method == "post" else {}))
        assert r.status_code in (401, 403), (method, path, r.status_code)


def test_another_workspace_cannot_see_or_touch_my_rules(admin_client, new_admin):
    s = mk_set(admin_client)
    rule = mk_rule(admin_client, s["id"])
    other, _ = new_admin("Other")
    assert other.get("/api/guardrails/rule-sets").json()["items"] == []
    assert other.patch(f"/api/guardrails/rule-sets/{s['id']}", json={"name": "x"}).status_code == 404
    assert other.delete(f"/api/guardrails/rule-sets/{s['id']}").status_code == 404
    assert other.patch(f"/api/guardrails/rules/{rule['id']}", json={"name": "x"}).status_code == 404
    assert other.delete(f"/api/guardrails/rules/{rule['id']}").status_code == 404
    assert other.post(f"/api/guardrails/rule-sets/{s['id']}/rules", json={"name": "a", "kind": "phrase", "pattern": "x"}).status_code == 404
    assert len(admin_client.get("/api/guardrails/rule-sets").json()["items"][0]["rules"]) == 1


def test_cannot_attach_another_workspaces_set_or_key(setup, new_admin):
    c, key = setup
    other, _ = new_admin("Other")
    foreign = mk_set(other, "Foreign")
    r = c.put(f"/api/guardrails/keys/{key['id']}/rule-sets", json={"rule_set_ids": [foreign["id"]]})
    assert r.status_code == 422
    mine = mk_set(c)
    assert other.put(f"/api/guardrails/keys/{key['id']}/rule-sets", json={"rule_set_ids": [mine["id"]]}).status_code == 404


# ------------------------------------------------------------------------------------------- CRUD + limits


def test_rule_set_crud_and_unique_names(admin_client):
    s = mk_set(admin_client, "No secrets", description="d")
    assert admin_client.post("/api/guardrails/rule-sets", json={"name": "no SECRETS"}).status_code == 409  # case-insensitive
    r = admin_client.patch(f"/api/guardrails/rule-sets/{s['id']}", json={"name": "Renamed", "enabled": False})
    assert r.status_code == 200 and r.json()["name"] == "Renamed" and r.json()["enabled"] is False
    other = mk_set(admin_client, "Other")
    assert admin_client.patch(f"/api/guardrails/rule-sets/{other['id']}", json={"name": "renamed"}).status_code == 409
    assert admin_client.delete(f"/api/guardrails/rule-sets/{s['id']}").status_code == 200
    assert [i["name"] for i in admin_client.get("/api/guardrails/rule-sets").json()["items"]] == ["Other"]


def test_rule_validation(admin_client):
    s = mk_set(admin_client)
    url = f"/api/guardrails/rule-sets/{s['id']}/rules"
    bad = [
        {"name": "a", "kind": "phrase", "pattern": ""}, {"name": "a", "kind": "phrase", "pattern": "x" * 201},
        {"name": "a", "kind": "regex", "pattern": "(unclosed"}, {"name": "a", "kind": "regex", "pattern": "a*"},  # matches empty
        {"name": "a", "kind": "regex", "pattern": "(a|aa)+$"},  # catastrophic: refused at save time
        {"name": "a", "kind": "preset", "preset_id": "nope"}, {"name": "a", "kind": "nope", "pattern": "x"},
        {"name": "a", "kind": "phrase", "pattern": "x", "action": "kill"}, {"name": "", "kind": "phrase", "pattern": "x"},
    ]
    for b in bad:
        assert admin_client.post(url, json=b).status_code == 422, b
    assert admin_client.post(url, json={"name": "ok", "kind": "regex", "pattern": r"code-\d+"}).status_code == 200
    assert admin_client.post(url, json={"name": "card", "kind": "preset", "preset_id": "card", "action": "block"}).status_code == 200
    assert {p["id"] for p in admin_client.get("/api/guardrails/presets").json()} == set(g.PRESETS)


def test_limits(admin_client, make_live_key, monkeypatch):
    monkeypatch.setattr(settings, "GUARDRAIL_MAX_RULES_PER_SET", 3)
    monkeypatch.setattr(settings, "GUARDRAIL_MAX_SETS_PER_WORKSPACE", 2)
    monkeypatch.setattr(settings, "GUARDRAIL_MAX_SETS_PER_KEY", 1)
    monkeypatch.setattr(settings, "GUARDRAIL_MAX_RULES_PER_KEY", 4)
    s1, s2 = mk_set(admin_client, "A"), mk_set(admin_client, "B")
    assert admin_client.post("/api/guardrails/rule-sets", json={"name": "C"}).status_code == 409
    for i in range(3):
        mk_rule(admin_client, s1["id"], name=f"r{i}", pattern=f"w{i}")
    assert admin_client.post(f"/api/guardrails/rule-sets/{s1['id']}/rules", json={"name": "x", "kind": "phrase", "pattern": "x"}).status_code == 409
    key = make_live_key(allowed_providers=ALL)
    attach(admin_client, key["id"], s1["id"])
    assert admin_client.put(f"/api/guardrails/keys/{key['id']}/rule-sets", json={"rule_set_ids": [s1["id"], s2["id"]]}).status_code == 422  # per key
    monkeypatch.setattr(settings, "GUARDRAIL_MAX_SETS_PER_KEY", 5)
    mk_rule(admin_client, s2["id"], name="q0", pattern="v0")
    assert admin_client.put(f"/api/guardrails/keys/{key['id']}/rule-sets", json={"rule_set_ids": [s1["id"], s2["id"]]}).status_code == 200  # 3+1 = 4
    r = admin_client.post(f"/api/guardrails/rule-sets/{s2['id']}/rules", json={"name": "z", "kind": "phrase", "pattern": "zz"})
    assert r.status_code == 422  # the key would exceed its active-rule limit


# --------------------------------------------------------------------- key attachment and the flag/version


def test_attach_sets_flag_and_version_and_detach_clears_it(setup):
    c, key = setup
    s = mk_set(c)
    with SessionLocal() as db:
        v0 = db.scalar(select(Workspace.guardrail_version))
    assert attach(c, key["id"], s["id"])["rule_set_ids"] == [s["id"]]
    with SessionLocal() as db:
        assert db.get(VirtualKey, key["id"]).has_guardrails is True and db.scalar(select(Workspace.guardrail_version)) > v0
    assert attach(c, key["id"])["rule_set_ids"] == []
    with SessionLocal() as db:
        assert db.get(VirtualKey, key["id"]).has_guardrails is False
    keys = {k["id"]: k for k in c.get("/api/keys").json()}
    assert keys[key["id"]]["guardrail_rule_set_ids"] == []


def test_deleting_the_last_attached_set_clears_the_key_flag(setup):
    c, key = setup
    s = mk_set(c)
    attach(c, key["id"], s["id"])
    c.delete(f"/api/guardrails/rule-sets/{s['id']}")
    with SessionLocal() as db:
        assert db.get(VirtualKey, key["id"]).has_guardrails is False


def test_keys_can_be_created_and_updated_with_rule_sets(admin_client, make_live_key):
    s = mk_set(admin_client)
    r = admin_client.post("/api/keys", json={"label": "guarded", "allowed_providers": ["openrouter"], "guardrail_rule_set_ids": [s["id"]]})
    assert r.status_code == 200, r.text
    kid = r.json()["id"]
    assert {k["id"]: k for k in admin_client.get("/api/keys").json()}[kid]["guardrail_rule_set_ids"] == [s["id"]]
    bad = admin_client.post("/api/keys", json={"label": "g2", "allowed_providers": ["openrouter"], "guardrail_rule_set_ids": [99999]})
    assert bad.status_code == 422
    assert "g2" not in [k["label"] for k in admin_client.get("/api/keys").json()]  # nothing half-created
    assert admin_client.patch(f"/api/keys/{kid}", json={"guardrail_rule_set_ids": []}).json()["guardrail_rule_set_ids"] == []
    assert admin_client.patch(f"/api/keys/{kid}", json={"guardrail_rule_set_ids": [s["id"]]}).json()["guardrail_rule_set_ids"] == [s["id"]]
    assert audit_actions().count("key.guardrails.attach") == 2 and "key.guardrails.detach" in audit_actions()


def test_members_do_not_see_attachments_in_the_key_list(admin_client, new_member):
    member, uid = new_member(admin_client)
    s = mk_set(admin_client)
    admin_client.post("/api/keys", json={"label": "mk", "allowed_providers": ["openrouter"], "assigned_user_id": uid, "guardrail_rule_set_ids": [s["id"]]})
    rows = member.get("/api/keys").json()
    assert rows and all(k["guardrail_rule_set_ids"] == [] for k in rows)


# ------------------------------------------------------------------------ S12 changes apply immediately


def test_each_api_change_takes_effect_on_the_very_next_gateway_request(on, setup, client, mock_provider):
    c, key = setup
    s = mk_set(c)
    rule = mk_rule(c, s["id"])
    attach(c, key["id"], s["id"])
    send = lambda: call(client, key["key"], "messages", TRIGGER).status_code  # noqa: E731
    assert send() == 403
    c.patch(f"/api/guardrails/rules/{rule['id']}", json={"enabled": False})
    assert send() == 200
    c.patch(f"/api/guardrails/rules/{rule['id']}", json={"enabled": True, "action": "flag"})
    assert send() == 200 and mock_provider  # now only flagged
    c.patch(f"/api/guardrails/rules/{rule['id']}", json={"action": "block", "pattern": "bluefalcon"})
    assert send() == 403
    c.patch(f"/api/guardrails/rule-sets/{s['id']}", json={"enabled": False})
    assert send() == 200
    c.patch(f"/api/guardrails/rule-sets/{s['id']}", json={"enabled": True})
    assert send() == 403
    attach(c, key["id"])
    assert send() == 200
    attach(c, key["id"], s["id"])
    assert send() == 403
    c.delete(f"/api/guardrails/rules/{rule['id']}")
    assert send() == 200
    mk_rule(c, s["id"], name="again")
    assert send() == 403
    c.delete(f"/api/guardrails/rule-sets/{s['id']}")
    assert send() == 200


# ------------------------------------------------------------------------------------------- dry run


def test_dry_run_matches_like_the_gateway_and_stores_nothing(admin_client):
    r = admin_client.post("/api/guardrails/test", json={"kind": "phrase", "pattern": "BlueFalcon", "text": "the bluefalcon plan"})
    j = r.json()
    assert r.status_code == 200 and j["matched"] and j["occurrences"] == 1 and "[matched]" in j["snippet"]
    assert j["matched_text"] == "bluefalcon" and "bluefalcon" not in j["snippet"]
    assert r.headers["cache-control"] == "no-store"
    assert not admin_client.post("/api/guardrails/test", json={"kind": "phrase", "pattern": "zzz", "text": "nothing"}).json()["matched"]
    assert admin_client.post("/api/guardrails/test", json={"kind": "regex", "pattern": "(a|aa)+$", "text": "a"}).status_code == 422
    assert audit_actions() == []  # a dry run is not an administrative change


# ------------------------------------------------------------------ S16 hits, unread, review, grouping


def _generate(c, key, client, n_block=2, n_flag=1):
    s = mk_set(c, "Words")
    mk_rule(c, s["id"], name="codename", pattern="bluefalcon", action="block")
    mk_rule(c, s["id"], name="project", pattern="project x", action="flag")
    attach(c, key["id"], s["id"])
    for _ in range(n_block):
        assert call(client, key["key"], "messages", TRIGGER).status_code == 403
    for _ in range(n_flag):
        assert call(client, key["key"], "messages", "update on project x").status_code == 200
    return s


def test_unread_equals_the_sum_of_group_counts_and_groups_are_ordered(on, setup, client, mock_provider):
    c, key = setup
    _generate(c, key, client)
    assert c.get("/api/guardrails/unread-count").json()["count"] == 3
    groups = c.get("/api/guardrails/hits").json()
    assert sum(gp["unread"] for gp in groups["items"]) == groups["unread_total"] == 3
    by = {gp["rule_name"]: gp for gp in groups["items"]}
    assert by["codename"]["total"] == 2 and by["codename"]["action"] == "block" and by["project"]["action"] == "flag"
    stamps = [gp["last_seen"] for gp in groups["items"]]
    assert stamps == sorted(stamps, reverse=True)
    assert by["codename"]["key_label"] == key["label"]


def test_review_marks_only_up_to_the_id_and_is_idempotent_and_workspace_wide(on, setup, client, mock_provider, new_member):
    c, key = setup
    _generate(c, key, client)
    seen = c.get("/api/guardrails/unread-count").json()["latest_hit_id"]
    assert call(client, key["key"], "messages", TRIGGER).status_code == 403  # arrives after the list was loaded
    r = c.post("/api/guardrails/hits/review", json={"up_to_id": seen})
    assert r.json() == {"reviewed": 3}
    assert c.get("/api/guardrails/unread-count").json()["count"] == 1  # the late one stays unread
    assert c.post("/api/guardrails/hits/review", json={"up_to_id": seen}).json() == {"reviewed": 0}  # idempotent
    assert audit_actions().count("hits.review") == 1  # nothing logged for a no-op


def test_group_level_review_touches_only_that_group(on, setup, client, mock_provider):
    c, key = setup
    _generate(c, key, client)
    top = c.get("/api/guardrails/unread-count").json()["latest_hit_id"]
    grp = next(gp for gp in c.get("/api/guardrails/hits").json()["items"] if gp["rule_name"] == "codename")
    r = c.post("/api/guardrails/hits/review", json={"up_to_id": top, "key_id": grp["key_id"], "rule_id": grp["rule_id"], "action": "block"})
    assert r.json()["reviewed"] == 2 and c.get("/api/guardrails/unread-count").json()["count"] == 1
    assert [gp["rule_name"] for gp in c.get("/api/guardrails/hits", params={"unread_only": True}).json()["items"]] == ["project"]


def test_hit_items_show_decrypted_redacted_snippets_with_the_matched_words_and_are_not_cached(on, setup, client, mock_provider):
    c, key = setup
    _generate(c, key, client, n_block=1, n_flag=0)
    r = c.get("/api/guardrails/hits/items")
    assert r.headers["cache-control"] == "no-store"
    item = r.json()["items"][0]
    assert item["action"] == "block" and item["snippet"] and "[matched]" in item["snippet"] and "bluefalcon" not in item["snippet"].lower()
    assert item["matched_text"] == "bluefalcon"  # a word rule: the words as written, apart from the context
    assert item["key_label"] == key["label"] and item["request_status"] == "blocked"
    assert set(item) >= {"usage_id", "request_id", "rule_name", "rule_set_name", "occurrences", "source_role"}


def test_expired_hits_are_invisible_even_before_the_sweep(on, setup, client, mock_provider):
    c, key = setup
    _generate(c, key, client, n_block=1, n_flag=0)
    with SessionLocal() as db:
        from sqlalchemy import text
        db.execute(text("UPDATE guardrail_hits SET expires_at = now() - interval '1 minute'"))
        db.commit()
    assert c.get("/api/guardrails/unread-count").json()["count"] == 0
    assert c.get("/api/guardrails/hits").json()["items"] == [] and c.get("/api/guardrails/hits/items").json()["items"] == []


def test_a_deleted_rule_keeps_its_hits_by_name_snapshot(on, setup, client, mock_provider):
    c, key = setup
    s = _generate(c, key, client, n_block=1, n_flag=0)
    rid = next(r["id"] for r in c.get("/api/guardrails/rule-sets").json()["items"][0]["rules"] if r["name"] == "codename")
    c.delete(f"/api/guardrails/rules/{rid}")
    items = c.get("/api/guardrails/hits").json()["items"]
    assert items and items[0]["rule_id"] is None and items[0]["rule_name"] == "codename" and s


def test_hits_are_workspace_private(on, setup, client, mock_provider, new_admin):
    c, key = setup
    _generate(c, key, client)
    other, _ = new_admin("Other")
    assert other.get("/api/guardrails/unread-count").json()["count"] == 0
    assert other.get("/api/guardrails/hits").json()["items"] == [] and other.get("/api/guardrails/hits/items").json()["items"] == []
    assert other.post("/api/guardrails/hits/review", json={"up_to_id": 10**9}).json() == {"reviewed": 0}
    assert c.get("/api/guardrails/unread-count").json()["count"] == 3


# ---------------------------------------------------------------- Requests list fields, status, activity


def test_requests_list_marks_guardrail_rows_and_filters_them(on, setup, client, mock_provider):
    c, key = setup
    _generate(c, key, client)
    assert call(client, key["key"], "messages", "plain").status_code == 200
    items = c.get("/api/requests").json()["items"]
    assert {i["guardrail"] for i in items} == {None, "blocked", "flagged"}
    blocked = next(i for i in items if i["guardrail"] == "blocked")
    assert blocked["status"] == "blocked" and blocked["guardrail_rules"] == [{"rule_name": "codename", "action": "block"}]
    assert next(i for i in items if i["guardrail"] is None)["guardrail_rules"] == []
    assert len(c.get("/api/requests", params={"guardrail": "any"}).json()["items"]) == 3
    assert {i["guardrail"] for i in c.get("/api/requests", params={"guardrail": "blocked"}).json()["items"]} == {"blocked"}
    assert {i["guardrail"] for i in c.get("/api/requests", params={"guardrail": "flagged"}).json()["items"]} == {"flagged"}


def test_status_summarises_the_last_day_and_surfaces_evidence_gaps(on, setup, client, mock_provider):
    c, key = setup
    _generate(c, key, client)
    st = c.get("/api/guardrails/status").json()
    assert st["enabled"] is True and st["last_24h"] == {"blocked": 2, "flagged": 1, "unchecked": 0}
    assert st["retention_days"] == 30 and st["recording"]["throttled_at"] is None and st["evidence_gaps"] == []
    with SessionLocal() as db:
        ws = db.scalar(select(Workspace.id))
        g.audit(db, ws, None, "guardrail.evidence_gap", "guardrail", None, {"count": 4, "reasons": ["timeout"]})
        db.commit()
    gaps = c.get("/api/guardrails/status").json()["evidence_gaps"]
    assert gaps and gaps[0]["count"] == 4


def test_status_is_per_workspace(on, setup, client, mock_provider, new_admin):
    c, key = setup
    _generate(c, key, client)
    other, _ = new_admin("Other")
    assert other.get("/api/guardrails/status").json()["last_24h"] == {"blocked": 0, "flagged": 0, "unchecked": 0}


# ------------------------------------------------------------------------------------------ S17 audit


def test_every_admin_change_is_audited_with_actor_and_no_prompt_data(on, setup, client, mock_provider):
    c, key = setup
    s = mk_set(c, "Audited")
    rule = mk_rule(c, s["id"], pattern="bluefalcon")
    c.patch(f"/api/guardrails/rules/{rule['id']}", json={"action": "flag"})
    c.patch(f"/api/guardrails/rule-sets/{s['id']}", json={"enabled": False})
    c.patch(f"/api/guardrails/rule-sets/{s['id']}", json={"enabled": True})
    c.patch(f"/api/guardrails/rule-sets/{s['id']}", json={"name": "Audited 2"})
    attach(c, key["id"], s["id"])
    assert call(client, key["key"], "messages", TRIGGER).status_code == 200  # flagged
    top = c.get("/api/guardrails/unread-count").json()["latest_hit_id"]
    c.post("/api/guardrails/hits/review", json={"up_to_id": top})
    attach(c, key["id"])
    c.delete(f"/api/guardrails/rules/{rule['id']}")
    c.delete(f"/api/guardrails/rule-sets/{s['id']}")
    assert audit_actions() == [
        "ruleset.create", "rule.create", "rule.update", "ruleset.disable", "ruleset.enable", "ruleset.update",
        "key.guardrails.attach", "hits.review", "key.guardrails.detach", "rule.delete", "ruleset.delete",
    ]
    feed = c.get("/api/guardrails/activity").json()
    assert [e["action"] for e in feed["items"]][0] == "ruleset.delete"
    assert all(e["actor_user_id"] for e in feed["items"])
    blob = str(feed)
    assert "update on" not in blob and TRIGGER not in blob  # configuration only: never request text
    page = c.get("/api/guardrails/activity", params={"limit": 3}).json()
    assert len(page["items"]) == 3 and page["next_cursor"]
    assert len(c.get("/api/guardrails/activity", params={"cursor": page["next_cursor"], "limit": 50}).json()["items"]) == 8


def test_activity_is_workspace_private(setup, new_admin):
    c, _ = setup
    mk_set(c)
    other, _ = new_admin("Other")
    assert other.get("/api/guardrails/activity").json()["items"] == []
