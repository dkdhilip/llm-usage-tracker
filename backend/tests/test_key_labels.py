"""Key names are unique among a workspace's ACTIVE keys (case and surrounding spaces ignored); a revoked key's
name can be reused; another workspace may use the same name."""


def _create(c, label, **over):
    return c.post("/api/keys", json={"label": label, "allowed_providers": ["openrouter"], **over})


def _labels(c):
    return sorted(k["label"] for k in c.get("/api/keys").json())


def test_a_duplicate_name_is_rejected_with_a_clear_message_and_creates_nothing(admin_client):
    c = admin_client
    assert _create(c, "support-bot").status_code == 200
    r = _create(c, "support-bot")
    assert r.status_code == 409
    assert r.json()["detail"] == "A key named 'support-bot' already exists in this workspace. Pick a different name."
    assert _labels(c) == ["support-bot"]  # the rejected request made no key


def test_the_check_ignores_case_and_surrounding_spaces_but_keeps_the_name_as_typed(admin_client):
    c = admin_client
    assert _create(c, "Support-Bot").status_code == 200
    assert _create(c, "  support-bot ").status_code == 409
    assert _create(c, "SUPPORT-BOT").status_code == 409
    assert _create(c, "support-bot-2").status_code == 200  # a different name is fine
    assert _labels(c) == ["Support-Bot", "support-bot-2"]  # stored as typed (trimmed), not lower-cased


def test_another_workspace_can_use_the_same_name(admin_client, new_admin):
    other, _ = new_admin("Other")
    assert _create(admin_client, "shared-name").status_code == 200
    assert _create(other, "shared-name").status_code == 200  # names are unique per workspace only
    assert _create(admin_client, "shared-name").status_code == 409


def test_a_revoked_keys_name_can_be_reused(admin_client):
    c = admin_client
    key = _create(c, "nightly-job").json()
    assert _create(c, "nightly-job").status_code == 409  # while it is active
    assert c.delete(f"/api/keys/{key['id']}").status_code == 200  # revoke
    assert _create(c, "nightly-job").status_code == 200  # now free again


def test_the_check_runs_before_the_key_limit_and_blank_names_are_still_rejected(admin_client):
    assert _create(admin_client, "   ").status_code == 422  # unchanged
    assert _create(admin_client, "ok").status_code == 200
    assert _create(admin_client, "ok").status_code == 409


def test_members_cannot_create_keys_so_cannot_probe_names(admin_client, new_member):
    mc, _ = new_member(admin_client)
    assert _create(admin_client, "secret-project").status_code == 200
    assert _create(mc, "secret-project").status_code == 403  # still admin-only, no name information leaks
