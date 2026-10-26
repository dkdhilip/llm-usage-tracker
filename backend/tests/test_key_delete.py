"""Deleting a key is a soft delete of a REVOKED key: it leaves the keys list for a "Deleted keys" view, frees a slot
under the key limit, can no longer be changed, and keeps its usage history. Admin only, tenant-isolated."""
from app.config import settings


def _create(c, label, **over):
    r = c.post("/api/keys", json={"label": label, "allowed_providers": ["openrouter"], **over})
    assert r.status_code == 200, r.text
    return r.json()


def _by_id(c):
    return {k["id"]: k for k in c.get("/api/keys").json()}


def test_an_active_key_must_be_revoked_before_it_can_be_deleted(admin_client):
    key = _create(admin_client, "live")
    r = admin_client.post(f"/api/keys/{key['id']}/delete")
    assert r.status_code == 409
    assert r.json()["detail"] == "Revoke the key before deleting it."
    assert _by_id(admin_client)[key["id"]]["deleted_at"] is None  # nothing changed


def test_deleting_a_revoked_key_marks_it_deleted_and_keeps_it_listed_for_the_deleted_view(admin_client):
    key = _create(admin_client, "old")
    assert admin_client.delete(f"/api/keys/{key['id']}").status_code == 200
    r = admin_client.post(f"/api/keys/{key['id']}/delete")
    assert r.status_code == 200
    body = r.json()
    assert body["deleted_at"] and body["revoked_at"]
    listed = _by_id(admin_client)[key["id"]]
    assert listed["deleted_at"] and listed["revoked_at"]  # the UI files it under "Deleted keys"


def test_delete_is_idempotent_and_keeps_the_first_timestamp(admin_client):
    key = _create(admin_client, "twice")
    admin_client.delete(f"/api/keys/{key['id']}")
    first = admin_client.post(f"/api/keys/{key['id']}/delete").json()["deleted_at"]
    again = admin_client.post(f"/api/keys/{key['id']}/delete")
    assert again.status_code == 200
    assert again.json()["deleted_at"] == first


def test_a_deleted_key_cannot_be_changed_or_revoked_again(admin_client):
    key = _create(admin_client, "gone")
    admin_client.delete(f"/api/keys/{key['id']}")
    admin_client.post(f"/api/keys/{key['id']}/delete")
    assert admin_client.patch(f"/api/keys/{key['id']}", json={"allow_live": True}).status_code == 404
    assert admin_client.delete(f"/api/keys/{key['id']}").status_code == 404


def test_a_deleted_key_still_cannot_authenticate(admin_client):
    key = _create(admin_client, "dead")
    admin_client.delete(f"/api/keys/{key['id']}")
    admin_client.post(f"/api/keys/{key['id']}/delete")
    r = admin_client.get("/v1/proxy/inspect", headers={"Authorization": f"Bearer {key['key']}"})
    assert r.status_code in (401, 403)


def test_deleting_frees_a_slot_under_the_key_limit(admin_client, monkeypatch):
    monkeypatch.setattr(settings, "MAX_KEYS_PER_WORKSPACE", 2)
    a = _create(admin_client, "a")
    _create(admin_client, "b")
    assert admin_client.post("/api/keys", json={"label": "c", "allowed_providers": ["openrouter"]}).status_code == 409
    admin_client.delete(f"/api/keys/{a['id']}")  # revoking alone does not free the slot
    assert admin_client.post("/api/keys", json={"label": "c", "allowed_providers": ["openrouter"]}).status_code == 409
    admin_client.post(f"/api/keys/{a['id']}/delete")
    assert admin_client.post("/api/keys", json={"label": "c", "allowed_providers": ["openrouter"]}).status_code == 200


def test_usage_history_of_a_deleted_key_is_kept(admin_client):
    key = _create(admin_client, "history")
    before = admin_client.get("/api/usage/summary").json()
    admin_client.delete(f"/api/keys/{key['id']}")
    admin_client.post(f"/api/keys/{key['id']}/delete")
    after = admin_client.get("/api/usage/summary").json()
    before.pop("active_keys"), after.pop("active_keys")  # revoking (not deleting) is what changes this count
    assert after == before
    assert key["id"] in _by_id(admin_client)  # the row, and with it its usage rows, still exist


def test_members_cannot_delete_and_never_see_deleted_keys(admin_client, new_member):
    mc, uid = new_member(admin_client)
    key = _create(admin_client, "assigned", assigned_user_id=uid)
    admin_client.delete(f"/api/keys/{key['id']}")
    assert mc.post(f"/api/keys/{key['id']}/delete").status_code == 403
    assert key["id"] in {k["id"] for k in mc.get("/api/keys").json()}  # revoked but not deleted: still visible
    admin_client.post(f"/api/keys/{key['id']}/delete")
    assert key["id"] not in {k["id"] for k in mc.get("/api/keys").json()}


def test_another_workspace_cannot_delete_my_key(admin_client, new_admin):
    other, _ = new_admin("Other")
    key = _create(admin_client, "mine")
    admin_client.delete(f"/api/keys/{key['id']}")
    assert other.post(f"/api/keys/{key['id']}/delete").status_code == 404
    assert _by_id(admin_client)[key["id"]]["deleted_at"] is None
