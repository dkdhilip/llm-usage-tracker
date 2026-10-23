"""Per-virtual-key content logging. A key is captured only when its WORKSPACE master switch AND its own switch are on
(images need both image switches, and text capture). Both key switches default OFF. Mocked providers only."""

import base64
import threading

import pytest
from sqlalchemy import event, func, select, text

from app import bootstrap, content_capture, crypto
from app.config import settings
from app.db import SessionLocal, engine
from app.models import UsageContent, UsageContentImage, UsageLog, VirtualKey

PNG = b"\x89PNG\r\n\x1a\n" + b"png-body-" * 20
DATA_PNG = "data:image/png;base64," + base64.b64encode(PNG).decode()
ALL = ["openai", "anthropic", "gemini", "openrouter"]


@pytest.fixture()
def env(admin_client, make_live_key, mock_provider):
    """Two keys in one workspace, both created with the DEFAULT (off) per-key switches."""
    a = make_live_key(label="key-a", allowed_providers=ALL, default_provider="openai")
    b = make_live_key(label="key-b", allowed_providers=ALL, default_provider="openai")
    return admin_client, a, b


def _hdr(key):
    return {"Authorization": f"Bearer {key['key']}"}


def _chat(c, key, parts=None):
    parts = parts or [{"type": "text", "text": "hello"}]
    body = {"model": "openai/gpt-4o-mini", "messages": [{"role": "user", "content": parts}]}
    return c.post("/v1/chat/completions", json=body, headers=_hdr(key))


def _img_parts():
    return [{"type": "text", "text": "look"}, {"type": "image_url", "image_url": {"url": DATA_PNG}}]


def _master(c, text_on=True, images_on=False):
    assert c.patch("/api/workspace/content-logging", json={"enabled": text_on}).status_code == 200
    assert c.patch("/api/workspace/image-logging", json={"enabled": images_on}).status_code == 200


def _key(c, key, **flags):
    r = c.patch(f"/api/keys/{key['id']}", json=flags)
    assert r.status_code == 200, r.text
    return r.json()


def _rows():
    with SessionLocal() as db:
        return list(db.scalars(select(UsageContent).order_by(UsageContent.id)))


def _imgs():
    with SessionLocal() as db:
        return list(db.scalars(select(UsageContentImage).order_by(UsageContentImage.id)))


def _usage():
    with SessionLocal() as db:
        return list(db.scalars(select(UsageLog).order_by(UsageLog.id)))


def _captured_key_ids() -> set[int]:
    """The virtual keys whose requests have stored content."""
    with SessionLocal() as db:
        return set(
            db.scalars(
                select(UsageLog.key_id).join(UsageContent, UsageContent.usage_log_id == UsageLog.id)
            )
        )


# ------------------------------------------------------------------------------------------------ defaults


def test_new_keys_default_to_logging_off_even_when_the_workspace_master_is_on(env):
    c, a, b = env
    assert a["content_logging_enabled"] is False and a["image_logging_enabled"] is False  # POST /api/keys response
    listed = {k["id"]: k for k in c.get("/api/keys").json()}
    assert all(not k["content_logging_enabled"] and not k["image_logging_enabled"] for k in listed.values())
    _master(c, True, True)
    assert _chat(c, a, _img_parts()).status_code == 200 and _chat(c, b).status_code == 200
    assert _rows() == [] and _imgs() == []  # master on, but no key opted in: nothing logs


def test_a_key_created_with_the_switches_on_is_logged_and_the_flags_are_returned(env):
    c, _a, _b = env
    r = c.post("/api/keys", json={"label": "c", "allowed_providers": ["openai"], "allow_live": True,
                                  "content_logging_enabled": True, "image_logging_enabled": True})
    assert r.status_code == 200
    body = r.json()
    assert body["content_logging_enabled"] is True and body["image_logging_enabled"] is True and body["key"].startswith("vk_")
    assert c.post("/api/keys", json={"label": "d", "allowed_providers": ["openai"]}).json()["content_logging_enabled"] is False
    listed = [k for k in c.get("/api/keys").json() if k["id"] == body["id"]][0]
    assert listed["content_logging_enabled"] and listed["image_logging_enabled"]


# ------------------------------------------------------------------------------- isolation between keys


def test_only_the_key_that_opted_in_is_captured_and_analytics_are_identical(env):
    c, a, b = env
    _master(c)
    _key(c, a, content_logging_enabled=True)
    for _ in range(2):
        assert _chat(c, a).status_code == 200 and _chat(c, b).status_code == 200
    assert _captured_key_ids() == {a["id"]}
    assert len(_rows()) == 2 and len(_usage()) == 4  # all four requests have usage rows; two have content
    per_key = {}
    for u in _usage():
        per_key.setdefault(u.key_id, []).append((u.status, u.prompt_tokens, u.completion_tokens, u.total_tokens))
    assert per_key[a["id"]] == per_key[b["id"]]  # logging changes no analytics
    # the list view only flags the logged key's rows
    items = c.get("/api/requests").json()["items"]
    assert {i["key_label"]: i["has_content"] for i in items if i["has_content"]} == {"key-a": True}


def test_image_logging_is_per_key_and_needs_text_logging_on_the_same_key(env):
    c, a, b = env
    _master(c, True, True)
    _key(c, a, content_logging_enabled=True)  # text only
    assert _chat(c, a, _img_parts()).status_code == 200
    assert len(_rows()) == 1 and _imgs() == []  # text stored, key's image switch is off

    _key(c, a, image_logging_enabled=True)
    assert _chat(c, a, _img_parts()).status_code == 200
    assert len(_imgs()) == 1  # now the images are stored

    _key(c, b, image_logging_enabled=True)  # image switch on, text switch off
    assert _chat(c, b, _img_parts()).status_code == 200
    assert len(_rows()) == 2 and len(_imgs()) == 1  # key-b captured nothing at all
    assert b["id"] not in _captured_key_ids()


def test_the_workspace_image_switch_is_a_master_for_the_key_image_switch(env):
    c, a, _b = env
    _master(c, True, False)  # workspace images OFF
    _key(c, a, content_logging_enabled=True, image_logging_enabled=True)
    assert _chat(c, a, _img_parts()).status_code == 200
    assert len(_rows()) == 1 and _imgs() == []


# ----------------------------------------------------------------------------------- workspace master switch


def test_the_workspace_master_switch_overrides_and_preserves_the_key_switches(env):
    c, a, _b = env
    _key(c, a, content_logging_enabled=True, image_logging_enabled=True)
    assert _chat(c, a, _img_parts()).status_code == 200  # master off (default)
    assert _rows() == []
    listed = [k for k in c.get("/api/keys").json() if k["id"] == a["id"]][0]
    assert listed["content_logging_enabled"] and listed["image_logging_enabled"]  # the choice is kept

    _master(c, True, True)
    assert _chat(c, a, _img_parts()).status_code == 200  # master on: the same key logs again, no re-setup
    assert len(_rows()) == 1 and len(_imgs()) == 1
    _master(c, False, False)
    assert _chat(c, a, _img_parts()).status_code == 200
    assert len(_rows()) == 1 and len(_imgs()) == 1  # master off again: stops at once


def test_the_playground_proxy_path_respects_the_key_switch(env):
    c, a, b = env
    _master(c)
    _key(c, a, content_logging_enabled=True)
    for k in (a, b):
        r = c.post("/v1/proxy/chat", json={"provider": "openai", "model": "gpt-4o-mini", "prompt": "hi"}, headers=_hdr(k))
        assert r.status_code == 200, r.text
    assert _captured_key_ids() == {a["id"]}


def test_a_key_with_logging_off_does_not_touch_the_database_for_the_decision(env):
    c, a, _b = env
    _master(c)

    class Counter:
        n = 0

    def hit(*args, **kw):
        Counter.n += 1

    with SessionLocal() as db:
        vk = db.get(VirtualKey, a["id"])
        event.listen(engine, "before_cursor_execute", hit)
        try:
            assert content_capture.begin(db, vk, "chat", {"messages": []}) is None
            off_queries = Counter.n
            vk.content_logging_enabled = True  # (in-memory only, not committed)
            assert content_capture.begin(db, vk, "chat", {"messages": []}) is not None
            on_queries = Counter.n - off_queries
        finally:
            event.remove(engine, "before_cursor_execute", hit)
            db.rollback()
    assert off_queries == 0  # decided from the key row already in memory
    assert on_queries == 1  # one workspace-master lookup only for an opted-in key


# ----------------------------------------------------------------------------------- authorization / tenancy


def test_only_workspace_admins_can_change_key_logging_and_only_in_their_workspace(env, new_member, new_admin, client):
    c, a, _b = env
    mc, _ = new_member(c)
    assert mc.patch(f"/api/keys/{a['id']}", json={"content_logging_enabled": True}).status_code == 403
    assert client.patch(f"/api/keys/{a['id']}", json={"content_logging_enabled": True}).status_code == 401
    other, _ws = new_admin("Other")
    assert other.patch(f"/api/keys/{a['id']}", json={"content_logging_enabled": True}).status_code == 404
    assert other.patch("/api/keys/999999", json={"content_logging_enabled": True}).status_code == 404
    listed = [k for k in c.get("/api/keys").json() if k["id"] == a["id"]][0]
    assert listed["content_logging_enabled"] is False  # nothing changed
    r = other.post("/api/keys", json={"label": "o", "allowed_providers": ["openai"], "content_logging_enabled": True})
    assert r.status_code == 200
    assert not [k for k in c.get("/api/keys").json() if k["label"] == "o"]  # the other workspace's key stays there


def test_the_switches_are_strict_booleans_and_patch_changes_only_what_is_sent(env):
    c, a, _b = env
    assert c.patch(f"/api/keys/{a['id']}", json={"content_logging_enabled": "maybe"}).status_code == 422
    out = _key(c, a, content_logging_enabled=True)
    assert out["content_logging_enabled"] is True and out["image_logging_enabled"] is False
    out = _key(c, a, image_logging_enabled=True)
    assert out["content_logging_enabled"] is True and out["image_logging_enabled"] is True
    out = _key(c, a, allow_live=True)  # an unrelated update leaves both switches alone
    assert out["content_logging_enabled"] is True and out["image_logging_enabled"] is True


def test_members_see_the_switches_of_their_own_key_only_and_no_secrets_are_listed(env, new_member):
    c, a, b = env
    mc, uid = new_member(c)
    assert c.patch(f"/api/keys/{a['id']}", json={"assigned_user_id": uid}).status_code == 200
    _key(c, a, content_logging_enabled=True)
    mine = mc.get("/api/keys")
    assert [k["id"] for k in mine.json()] == [a["id"]]
    assert mine.json()[0]["content_logging_enabled"] is True  # a member can see their own key is logged
    for resp in (mine, c.get("/api/keys")):
        assert a["key"] not in resp.text and b["key"] not in resp.text  # only the prefix is ever shown


def test_the_workspace_payload_counts_keys_for_the_master_cards(env):
    c, a, b = env
    cl = c.get("/api/workspace").json()["content_logging"]
    assert (cl["keys_total"], cl["keys_logging"], cl["keys_logging_images"]) == (2, 0, 0)
    _key(c, a, content_logging_enabled=True, image_logging_enabled=True)
    _key(c, b, content_logging_enabled=True)
    cl = c.get("/api/workspace").json()["content_logging"]
    assert (cl["keys_total"], cl["keys_logging"], cl["keys_logging_images"]) == (2, 2, 1)
    assert c.delete(f"/api/keys/{b['id']}").status_code == 200  # revoked keys are not counted
    cl = c.get("/api/workspace").json()["content_logging"]
    assert (cl["keys_total"], cl["keys_logging"]) == (1, 1)


# ---------------------------------------------------------------------------------- compat, in-flight, caps


def test_stored_content_stays_readable_after_the_key_is_switched_off(env):
    c, a, _b = env
    _master(c, True, True)
    _key(c, a, content_logging_enabled=True, image_logging_enabled=True)
    assert _chat(c, a, _img_parts()).status_code == 200
    uid = c.get("/api/requests").json()["items"][0]["id"]
    _key(c, a, content_logging_enabled=False, image_logging_enabled=False)
    detail = c.get(f"/api/requests/{uid}/content").json()
    assert detail["content_status"] == "available" and len(detail["images"]) == 1  # until it expires
    assert c.get(f"/api/requests/{uid}/images/{detail['images'][0]['id']}").status_code == 200
    assert _chat(c, a, _img_parts()).status_code == 200
    assert len(_rows()) == 1  # but nothing new is captured


def test_a_request_that_already_decided_to_capture_is_not_affected_by_a_later_toggle(env):
    c, a, _b = env
    _master(c)
    _key(c, a, content_logging_enabled=True)
    with SessionLocal() as db:
        cap = content_capture.begin(db, db.get(VirtualKey, a["id"]), "chat", {"messages": [{"role": "user", "content": "x"}]})
    assert cap is not None  # decision taken when the request started
    _key(c, a, content_logging_enabled=False)  # an admin flips it mid-request
    assert _chat(c, a).status_code == 200  # a NEW request is not captured
    assert _rows() == []
    uid = _usage()[0].id
    assert content_capture.store(uid, cap) is True  # the in-flight one still completes as decided
    assert len(_rows()) == 1


def test_caps_stay_exact_across_two_keys_capturing_images_concurrently(env, monkeypatch):
    c, a, b = env
    for _ in range(6):
        assert _chat(c, a).status_code == 200 and _chat(c, b).status_code == 200  # usage rows, master off
    usage = _usage()
    _master(c, True, True)
    _key(c, a, content_logging_enabled=True, image_logging_enabled=True)
    _key(c, b, content_logging_enabled=True, image_logging_enabled=True)
    one = len(crypto.encrypt_bytes(PNG))
    monkeypatch.setattr(settings, "CONTENT_IMAGE_MAX_BYTES_PER_WORKSPACE", one * 2)
    barrier = threading.Barrier(len(usage))
    errors = []

    def work(u):
        try:
            with SessionLocal() as db:
                cap = content_capture.begin(
                    db, db.get(VirtualKey, u.key_id), "chat",
                    {"messages": [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": DATA_PNG}}]}]},
                )
            assert cap is not None
            barrier.wait()
            content_capture.store(u.id, cap)
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=work, args=(u,)) for u in usage]
    [t.start() for t in threads]
    [t.join(60) for t in threads]
    assert errors == []
    assert len(_imgs()) == 2  # the workspace cap holds exactly across both keys
    assert len(_rows()) == len(usage)  # and every request still kept its text


# ------------------------------------------------------------------------------------------------ migration


def _drop_key_columns():
    with SessionLocal() as db:
        db.execute(text("ALTER TABLE virtual_keys DROP COLUMN content_logging_enabled, DROP COLUMN image_logging_enabled"))
        db.commit()


def _flags(key_id):
    with SessionLocal() as db:
        return db.execute(
            text("select content_logging_enabled, image_logging_enabled from virtual_keys where id = :i"), {"i": key_id}
        ).one()


def test_migration_copies_each_workspaces_state_once_and_never_re_enables_a_key(env, new_admin):
    c, a, b = env  # workspace 1: master text ON, images OFF
    _master(c, True, False)
    other, _ws = new_admin("Off workspace")  # workspace 2: everything off
    o = other.post("/api/keys", json={"label": "o", "allowed_providers": ["openai"]}).json()
    third, _ws3 = new_admin("Image workspace")  # workspace 3: text + images ON
    _master(third, True, True)
    t = third.post("/api/keys", json={"label": "t", "allowed_providers": ["openai"]}).json()
    assert _chat(c, a).status_code == 200  # an existing usage row that must survive the migration
    usage_before = [(u.id, u.key_id, u.total_tokens, u.status) for u in _usage()]

    _drop_key_columns()  # back to the schema before this feature
    with SessionLocal() as db:
        bootstrap._migrate(db)
    assert tuple(_flags(a["id"])) == (True, False) and tuple(_flags(b["id"])) == (True, False)  # inherited once
    assert tuple(_flags(o["id"])) == (False, False)  # an off workspace's keys stay off
    assert tuple(_flags(t["id"])) == (True, True)

    _key(c, a, content_logging_enabled=False)  # an admin switches one key off afterwards...
    with SessionLocal() as db:
        bootstrap._migrate(db)
        bootstrap._migrate(db)  # ...and re-running the migration (every boot) must not undo that
    assert tuple(_flags(a["id"])) == (False, False) and tuple(_flags(b["id"])) == (True, False)
    assert [(u.id, u.key_id, u.total_tokens, u.status) for u in _usage()] == usage_before  # existing usage untouched


def test_migration_on_a_workspace_that_is_off_never_turns_any_key_on(env):
    c, a, b = env  # master off (default)
    _drop_key_columns()
    with SessionLocal() as db:
        bootstrap._migrate(db)
    assert tuple(_flags(a["id"])) == (False, False) and tuple(_flags(b["id"])) == (False, False)
    assert _chat(c, a).status_code == 200 and _rows() == []
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(UsageLog)) == 1


def test_the_columns_are_not_null_with_a_false_default(env):
    with SessionLocal() as db:
        rows = db.execute(text(
            "select column_name, is_nullable, column_default from information_schema.columns "
            "where table_name = 'virtual_keys' and column_name in ('content_logging_enabled', 'image_logging_enabled')"
        )).all()
    assert len(rows) == 2 and all(r[1] == "NO" and "false" in r[2] for r in rows)
