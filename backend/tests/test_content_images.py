"""Opt-in image logging (app/content_images.py + the image endpoint). Mocked providers only: no real provider
call, and the tests assert that no URL is ever fetched."""

import base64
import itertools
import json
from datetime import timedelta

import pytest
from sqlalchemy import func, select, text

from app import bootstrap, content_capture, content_images, crypto
from app.config import settings
from app.db import SessionLocal
from app.models import UsageContent, UsageContentImage, UsageLog

ALL = ["openai", "anthropic", "gemini", "openrouter"]
PNG = b"\x89PNG\r\n\x1a\n" + b"png-body-" * 20
JPEG = b"\xff\xd8\xff\xe0" + b"jpeg-body-" * 20
GIF = b"GIF89a" + b"gif-body-" * 20
WEBP = b"RIFF\x10\x00\x00\x00WEBP" + b"webp-body-" * 20
B64 = lambda b: base64.b64encode(b).decode()  # noqa: E731
DATA_PNG = "data:image/png;base64," + B64(PNG)
_ids = itertools.count(1)


@pytest.fixture()
def env(admin_client, make_live_key, mock_provider, monkeypatch):
    import httpx

    def no_fetch(*a, **k):
        raise AssertionError("the gateway must never fetch a URL")

    monkeypatch.setattr(httpx.Client, "send", no_fetch)  # nothing but the (mocked) provider seam may go out
    monkeypatch.setattr(httpx, "get", no_fetch)
    return admin_client, make_live_key(allowed_providers=ALL, default_provider="openai", content_logging_enabled=True, image_logging_enabled=True), mock_provider


def _auth(key):
    return {"Authorization": f"Bearer {key['key']}"}


def _on(c, text_on=True, images_on=True):
    if text_on:
        assert c.patch("/api/workspace/content-logging", json={"enabled": True}).status_code == 200
    if images_on:
        assert c.patch("/api/workspace/image-logging", json={"enabled": True}).status_code == 200


def _canned(monkeypatch, make):
    def send(url, headers, json_body, *, timeout=60.0):
        return make(next(_ids))

    monkeypatch.setattr("app.providers.send_request", send)


def _chat(c, key, parts, model="openai/gpt-4o-mini"):
    return c.post("/v1/chat/completions", json={"model": model, "messages": [{"role": "user", "content": parts}]}, headers=_auth(key))


def _imgs() -> list[UsageContentImage]:
    with SessionLocal() as db:
        return list(db.scalars(select(UsageContentImage).order_by(UsageContentImage.id)))


def _contents() -> list[UsageContent]:
    with SessionLocal() as db:
        return list(db.scalars(select(UsageContent).order_by(UsageContent.id)))


def _uid(c):
    return c.get("/api/requests").json()["items"][0]["id"]


def _detail(c):
    return c.get(f"/api/requests/{_uid(c)}/content").json()


def _skipped(c):
    return _detail(c)["content"].get("images_skipped", [])


# ----------------------------------------------------------------------------------------- defaults / opt-in


def test_image_logging_is_off_by_default_and_text_logging_does_not_enable_it(env):
    c, key, _ = env
    ws = c.get("/api/workspace").json()
    assert ws["image_logging"]["enabled"] is False and ws["content_logging"]["enabled"] is False
    _on(c, text_on=True, images_on=False)
    assert c.get("/api/workspace").json()["image_logging"]["enabled"] is False  # unchanged by text logging
    assert _chat(c, key, [{"type": "text", "text": "x"}, {"type": "image_url", "image_url": {"url": DATA_PNG}}]).status_code == 200
    assert len(_contents()) == 1 and _imgs() == []  # text stored, image not
    assert _detail(c)["images"] == []


def test_images_need_text_logging_too(env):
    c, key, _ = env
    _on(c, text_on=False, images_on=True)
    assert _chat(c, key, [{"type": "image_url", "image_url": {"url": DATA_PNG}}]).status_code == 200
    assert _contents() == [] and _imgs() == []


def test_members_see_the_flag_but_not_the_storage_numbers(env, new_member):
    c, _k, _ = env
    mc, _ = new_member(c)
    _on(c)
    admin = c.get("/api/workspace").json()["image_logging"]
    assert admin["enabled"] is True and admin["cap_bytes"] == settings.CONTENT_IMAGE_MAX_BYTES_PER_WORKSPACE and admin["used_bytes"] == 0
    member = mc.get("/api/workspace").json()["image_logging"]
    assert member["enabled"] is True and "used_bytes" not in member and "cap_bytes" not in member


# ------------------------------------------------------------------------------ capture + retrieval (inputs)


def test_an_input_image_is_stored_listed_as_metadata_and_served_by_the_image_endpoint(env):
    c, key, _ = env
    _on(c)
    assert _chat(c, key, [{"type": "text", "text": "what is this"}, {"type": "image_url", "image_url": {"url": DATA_PNG}}]).status_code == 200
    (img,) = _imgs()
    assert (img.role, img.mime, img.byte_size) == ("input", "image/png", len(PNG)) and img.stored_bytes == len(img.data_encrypted)
    # list + detail carry metadata only: never bytes or base64
    listing = c.get("/api/requests")
    detail = c.get(f"/api/requests/{_uid(c)}/content")
    for r in (listing, detail):
        assert B64(PNG) not in r.text and "iVBOR" not in r.text and "data:image" not in r.text
    assert detail.json()["images"] == [{"id": img.id, "role": "input", "position": 0, "mime": "image/png", "bytes": len(PNG)}]
    served = c.get(f"/api/requests/{_uid(c)}/images/{img.id}")
    assert served.status_code == 200 and served.content == PNG and served.headers["content-type"] == "image/png"
    assert served.headers["x-content-type-options"] == "nosniff" and served.headers["cache-control"] == "private, no-store"
    assert "sandbox" in served.headers["content-security-policy"]


def test_each_provider_format_for_input_images(env):
    c, key, _ = env
    _on(c)
    gem = {"contents": [{"role": "user", "parts": [{"text": "q"}, {"inlineData": {"mimeType": "image/jpeg", "data": B64(JPEG)}},
                                                    {"inlineData": {"mimeType": "audio/wav", "data": B64(b"RIFFxxxxWAVE")}}]}]}
    calls = {
        "messages": ("/v1/messages", {"model": "claude-3-5-haiku", "max_tokens": 8, "messages": [{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/gif", "data": B64(GIF)}}]}]}, "image/gif"),
        "gemini": ("/v1beta/models/gemini-3.8-flash:generateContent", gem, "image/jpeg"),
        "responses": ("/v1/responses", {"model": "gpt-4o-mini", "input": [{"role": "user", "content": [
            {"type": "input_text", "text": "q"}, {"type": "input_image", "image_url": "data:image/webp;base64," + B64(WEBP)}]}]}, "image/webp"),
    }
    for name, (path, body, mime) in calls.items():
        assert c.post(path, json=body, headers=_auth(key)).status_code == 200, name
        assert _imgs()[-1].mime == mime, name  # the audio inlineData in the Gemini body is not an image: ignored
    assert [i.role for i in _imgs()] == ["input"] * 3


def test_the_declared_type_is_never_trusted(env):
    c, key, _ = env
    _on(c)
    jpeg_as_png = "data:image/png;base64," + B64(JPEG)
    svg = "data:image/png;base64," + B64(b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")
    pdf = "data:image/png;base64," + B64(b"%PDF-1.7 not an image")
    junk = "data:image/png;base64,@@@not base64@@@"
    for url in (jpeg_as_png, svg, pdf, junk):
        assert _chat(c, key, [{"type": "image_url", "image_url": {"url": url}}]).status_code == 200
    assert [i.mime for i in _imgs()] == ["image/jpeg"]  # sniffed, not declared
    assert _skipped(c) == [{"role": "input", "reason": "unsupported_type"}]


# ------------------------------------------------------------------------------------- outputs per provider


@pytest.mark.parametrize(
    "path,body,resp",
    [
        ("/v1/images/generations", {"model": "gpt-image-1", "prompt": "a bike"},
         lambda n: {"created": n, "data": [{"b64_json": B64(PNG), "revised_prompt": "a red bike"}], "usage": {"input_tokens": 1, "output_tokens": 2}}),
        ("/v1beta/models/gemini-3.8-flash:generateContent", {"contents": [{"role": "user", "parts": [{"text": "draw"}]}]},
         lambda n: {"candidates": [{"content": {"parts": [{"text": "here"}, {"inlineData": {"mimeType": "image/png", "data": B64(PNG)}}]}}],
                    "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 2, "totalTokenCount": 3}}),
        ("/v1/responses", {"model": "gpt-4o-mini", "input": "draw"},
         lambda n: {"id": f"resp_{n}", "output": [{"type": "image_generation_call", "result": B64(PNG)}], "usage": {"input_tokens": 1, "output_tokens": 2}}),
        ("/v1/chat/completions", {"model": "openai/gpt-4o-mini", "messages": [{"role": "user", "content": "draw"}]},
         lambda n: {"id": f"chat_{n}", "choices": [{"message": {"role": "assistant", "content": "ok", "images": [{"image_url": {"url": DATA_PNG}}]}}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3}}),
    ],
)
def test_generated_images_are_stored_per_provider_format(env, monkeypatch, path, body, resp):
    c, key, _ = env
    _on(c)
    _canned(monkeypatch, resp)
    assert c.post(path, json=body, headers=_auth(key)).status_code == 200
    (img,) = _imgs()
    assert (img.role, img.mime) == ("output", "image/png")
    assert c.get(f"/api/requests/{_uid(c)}/images/{img.id}").content == PNG


def test_urls_are_never_fetched_or_persisted(env, monkeypatch):
    c, key, _ = env
    _on(c)
    signed = "https://oaidalleapi.blob.core.windows.net/x.png?sig=SECRETSIGNATURE123&se=2026"
    # an input image given as a URL, and a generated image given as a (short-lived) URL
    assert _chat(c, key, [{"type": "image_url", "image_url": {"url": "https://example.com/cat.png?token=abcdef"}}]).status_code == 200
    assert _skipped(c) == [{"role": "input", "reason": "url_not_stored"}]
    _canned(monkeypatch, lambda n: {"created": n, "data": [{"url": signed}], "usage": {"input_tokens": 1, "output_tokens": 1}})
    assert c.post("/v1/images/generations", json={"model": "dall-e-3", "prompt": "a cat"}, headers=_auth(key)).status_code == 200
    assert _skipped(c) == [{"role": "output", "reason": "url_not_stored"}]
    assert _imgs() == []  # (the env fixture makes any httpx fetch raise)
    for row in _contents():  # the URL itself is not persisted either
        assert "SECRETSIGNATURE123" not in json.dumps(content_capture.load(row)) and "token=abcdef" not in json.dumps(content_capture.load(row))


def test_streams_capture_input_images(env):
    c, key, _ = env
    _on(c)
    body = {"model": "openai/gpt-4o-mini", "stream": True, "messages": [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": DATA_PNG}}]}]}
    with c.stream("POST", "/v1/chat/completions", json=body, headers=_auth(key)) as r:
        r.read()
    assert [i.role for i in _imgs()] == ["input"]


# ------------------------------------------------------------------------------------------ caps and bounds


def test_per_image_request_and_count_limits(env, monkeypatch):
    c, key, _ = env
    _on(c)
    big = b"\x89PNG\r\n\x1a\n" + b"x" * 3000
    monkeypatch.setattr(settings, "CONTENT_IMAGE_MAX_BYTES", 2000)
    assert _chat(c, key, [{"type": "image_url", "image_url": {"url": "data:image/png;base64," + B64(big)}}]).status_code == 200
    assert _imgs() == [] and _skipped(c) == [{"role": "input", "reason": "too_large"}]

    monkeypatch.setattr(settings, "CONTENT_IMAGE_MAX_BYTES", 2_000_000)
    monkeypatch.setattr(settings, "CONTENT_IMAGE_MAX_PER_REQUEST", 2)
    parts = [{"type": "image_url", "image_url": {"url": DATA_PNG}}] * 3
    assert _chat(c, key, parts).status_code == 200
    assert len(_imgs()) == 2 and _skipped(c) == [{"role": "input", "reason": "request_limit"}]

    monkeypatch.setattr(settings, "CONTENT_IMAGE_MAX_PER_REQUEST", 4)
    one = len(crypto.encrypt_bytes(PNG))
    monkeypatch.setattr(settings, "CONTENT_IMAGE_MAX_REQUEST_BYTES", one + 10)
    before = len(_imgs())
    assert _chat(c, key, parts[:2]).status_code == 200
    assert len(_imgs()) == before + 1 and _skipped(c) == [{"role": "input", "reason": "request_limit"}]


def test_workspace_and_global_caps_skip_without_failing_requests(env, monkeypatch):
    c, key, _ = env
    _on(c)
    one = len(crypto.encrypt_bytes(PNG))
    monkeypatch.setattr(settings, "CONTENT_IMAGE_MAX_BYTES_PER_WORKSPACE", one + 50)
    assert _chat(c, key, [{"type": "image_url", "image_url": {"url": DATA_PNG}}]).status_code == 200
    assert _chat(c, key, [{"type": "image_url", "image_url": {"url": DATA_PNG}}]).status_code == 200  # over the cap
    assert len(_imgs()) == 1 and _skipped(c) == [{"role": "input", "reason": "cap_reached"}]
    assert len(_contents()) == 2 and len(_usage_rows()) == 2  # text + analytics unaffected
    ws = c.get("/api/workspace").json()["image_logging"]
    assert ws["used_bytes"] == one and ws["cap_bytes"] == one + 50

    monkeypatch.setattr(settings, "CONTENT_IMAGE_MAX_BYTES_PER_WORKSPACE", 50_000_000)
    monkeypatch.setattr(settings, "CONTENT_IMAGE_MAX_BYTES_TOTAL", one)
    assert _chat(c, key, [{"type": "image_url", "image_url": {"url": DATA_PNG}}]).status_code == 200
    assert len(_imgs()) == 1 and _skipped(c) == [{"role": "input", "reason": "cap_reached"}]
    assert c.get("/api/workspace").json()["image_logging"]["global_full"] is True


def _usage_rows():
    with SessionLocal() as db:
        return list(db.scalars(select(UsageLog)))


def test_a_huge_base64_is_rejected_before_decoding(env, monkeypatch):
    c, key, _ = env
    _on(c)
    monkeypatch.setattr(settings, "CONTENT_IMAGE_MAX_BYTES", 10_000)
    called = []
    monkeypatch.setattr(content_images, "_decode", lambda s: called.append(1))
    huge = "data:image/png;base64," + "A" * 100_000
    assert _chat(c, key, [{"type": "image_url", "image_url": {"url": huge}}]).status_code == 200
    assert called == [] and _skipped(c) == [{"role": "input", "reason": "too_large"}]


def test_hostile_bodies_never_raise():
    weird = [None, 5, "x", [], {}, {"messages": "no"}, {"messages": [None, 1, {"content": [None, {"type": "image_url"}, {"type": "image_url", "image_url": 5}]}]},
             {"contents": [{"parts": [{"inlineData": "bad"}, {"inlineData": {"mimeType": None, "data": 5}}]}]},
             {"input": [None, {"content": "x"}, {"type": "input_image"}]}]
    for kind in content_capture.KINDS:
        for body in weird:
            content_images.request_candidates(kind, body)
            content_images.response_candidates(kind, body)


# --------------------------------------------------------------------------------- encryption / failures


def test_images_are_encrypted_at_rest(env):
    c, key, _ = env
    _on(c)
    _chat(c, key, [{"type": "image_url", "image_url": {"url": DATA_PNG}}])
    with SessionLocal() as db:
        raw = bytes(db.scalar(text("select data_encrypted from usage_content_images")))
    # a Fernet token that holds neither the image bytes nor their base64 (checking the whole image, not a 3-letter
    # fragment like b"PNG", which random base64 text can contain by chance)
    assert raw.startswith(b"gAAAA") and PNG not in raw and B64(PNG).encode() not in raw
    assert crypto.decrypt_bytes(raw) == PNG


def test_an_image_failure_never_breaks_the_request_and_keeps_the_text(env, monkeypatch):
    c, key, _ = env
    _on(c)

    def boom(_b):
        raise RuntimeError("boom")

    monkeypatch.setattr(content_images.crypto, "encrypt_bytes", boom)
    r = _chat(c, key, [{"type": "text", "text": "keep me"}, {"type": "image_url", "image_url": {"url": DATA_PNG}}])
    assert r.status_code == 200 and len(_usage_rows()) == 1 and _usage_rows()[0].status == "success"
    assert _imgs() == [] and len(_contents()) == 1
    assert "keep me" in json.dumps(content_capture.load(_contents()[0]))


def test_an_image_scan_failure_keeps_text_capture(env, monkeypatch):
    c, key, _ = env
    _on(c)
    monkeypatch.setattr(content_images, "request_candidates", lambda *a: (_ for _ in ()).throw(ValueError("x")))
    assert _chat(c, key, [{"type": "image_url", "image_url": {"url": DATA_PNG}}]).status_code == 200
    assert len(_contents()) == 1 and _imgs() == []


def test_unreadable_images_are_a_404_not_an_error(env, monkeypatch):
    c, key, _ = env
    _on(c)
    _chat(c, key, [{"type": "image_url", "image_url": {"url": DATA_PNG}}])
    (img,) = _imgs()
    monkeypatch.setattr(content_images.crypto, "decrypt_bytes", lambda _t: None)  # e.g. ENCRYPTION_KEY changed
    assert c.get(f"/api/requests/{_uid(c)}/images/{img.id}").status_code == 404


def test_enabling_images_changes_no_analytics(env):
    c, key, _ = env

    def shape():
        return [(u.provider, u.model, u.prompt_tokens, u.completion_tokens, u.total_tokens, u.status) for u in _usage_rows()]

    parts = [{"type": "text", "text": "hi"}, {"type": "image_url", "image_url": {"url": DATA_PNG}}]
    _chat(c, key, parts)
    off = shape()
    _on(c)
    _chat(c, key, parts)
    assert shape() == off * 2 and len(_imgs()) == 1


# -------------------------------------------------------------------------------------------- authorization


def test_only_admins_of_the_owning_workspace_can_fetch_images(env, new_member, new_admin, client):
    a, key, _ = env
    _on(a)
    _chat(a, key, [{"type": "image_url", "image_url": {"url": DATA_PNG}}])
    (img,) = _imgs()
    uid = _uid(a)
    url = f"/api/requests/{uid}/images/{img.id}"
    mc, _ = new_member(a)
    assert mc.get(url).status_code == 403 and client.get(url).status_code == 401
    assert mc.patch("/api/workspace/image-logging", json={"enabled": False}).status_code == 403
    b, b_ws = new_admin("Other")
    assert b.get(url).status_code == 404 and b.get(f"/api/requests/999999/images/{img.id}").status_code == 404
    assert b.get(f"/api/requests/{uid}/images/999999").status_code == 404
    assert a.get(f"/api/requests/{uid}/images/999999").status_code == 404
    with SessionLocal() as db:  # even a mislabelled image row is not served to the owner of the usage row
        db.execute(text("update usage_content_images set workspace_id = :w"), {"w": b_ws["id"]})
        db.commit()
    assert a.get(url).status_code == 404 and b.get(url).status_code == 404


def test_an_image_id_cannot_be_read_through_another_request(env):
    c, key, _ = env
    _on(c)
    _chat(c, key, [{"type": "image_url", "image_url": {"url": DATA_PNG}}])
    _chat(c, key, [{"type": "text", "text": "no image"}])
    first_img = _imgs()[0]
    other_usage = _uid(c)  # the newest row: the one WITHOUT an image
    assert c.get(f"/api/requests/{other_usage}/images/{first_img.id}").status_code == 404


# ------------------------------------------------------------------------- expiry, purge, cascade, migration


def test_expired_images_are_never_returned_even_before_the_sweep(env):
    c, key, _ = env
    _on(c)
    _chat(c, key, [{"type": "image_url", "image_url": {"url": DATA_PNG}}])
    (img,) = _imgs()
    uid = _uid(c)
    with SessionLocal() as db:
        db.execute(text("update usage_content_images set expires_at = now() - interval '1 hour'"))
        db.commit()
    assert c.get(f"/api/requests/{uid}/images/{img.id}").status_code == 404
    assert _detail(c)["images"] == []
    assert c.get("/api/workspace").json()["image_logging"]["used_bytes"] == 0  # expired bytes do not count against the cap
    assert len(_imgs()) == 1  # still physically there


def test_a_parent_that_expired_hides_its_images_and_the_sweep_cascades(env):
    c, key, _ = env
    _on(c)
    _chat(c, key, [{"type": "image_url", "image_url": {"url": DATA_PNG}}])
    (img,) = _imgs()
    uid = _uid(c)
    with SessionLocal() as db:
        db.execute(text("update usage_content set expires_at = now() - interval '1 minute'"))
        db.commit()
    assert c.get(f"/api/requests/{uid}/images/{img.id}").status_code == 404
    content_capture.cleanup_expired_startup()
    assert _contents() == [] and _imgs() == []  # deleting the text record took its images with it


def test_images_expire_with_their_text_record(env):
    c, key, _ = env
    _on(c)
    _chat(c, key, [{"type": "image_url", "image_url": {"url": DATA_PNG}}])
    (img,) = _imgs()
    (row,) = _contents()
    assert img.expires_at == row.expires_at and row.expires_at - row.created_at == timedelta(days=30)


def test_purge_and_workspace_deletion_remove_images(env):
    c, key, _ = env
    _on(c)
    _chat(c, key, [{"type": "image_url", "image_url": {"url": DATA_PNG}}])
    assert c.delete("/api/workspace/content").json() == {"deleted": 1}
    assert _imgs() == [] and len(_usage_rows()) == 1  # analytics kept
    _chat(c, key, [{"type": "image_url", "image_url": {"url": DATA_PNG}}])
    assert len(_imgs()) == 1
    assert c.delete("/api/workspace").status_code == 200
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(UsageContentImage)) == 0


def test_disabling_stops_image_capture_but_keeps_stored_images(env):
    c, key, _ = env
    _on(c)
    _chat(c, key, [{"type": "image_url", "image_url": {"url": DATA_PNG}}])
    assert c.patch("/api/workspace/image-logging", json={"enabled": False}).json()["image_logging"]["enabled"] is False
    _chat(c, key, [{"type": "image_url", "image_url": {"url": DATA_PNG}}])
    assert len(_imgs()) == 1 and len(_contents()) == 2


def test_migration_is_idempotent_and_upgrades_a_schema_without_the_image_objects(env):
    c, key, _ = env
    _chat(c, key, [{"type": "text", "text": "pre-existing"}])
    with SessionLocal() as db:
        bootstrap._migrate(db)
        bootstrap._migrate(db)
        db.execute(text("drop table usage_content_images"))
        db.execute(text(
            "alter table workspaces drop column image_logging_enabled, drop column image_logging_updated_at, "
            "drop column image_logging_updated_by"
        ))
        db.commit()
        bootstrap._migrate(db)
        bootstrap._migrate(db)
        assert bootstrap._has_table(db, "usage_content_images")
        for col in ("image_logging_enabled", "image_logging_updated_at", "image_logging_updated_by"):
            assert bootstrap._has_col(db, "workspaces", col)
        assert db.scalar(text("select image_logging_enabled from workspaces")) is False  # never auto-enabled
        assert db.scalar(select(func.count()).select_from(UsageLog)) == 1
    assert c.get("/api/workspace").json()["image_logging"]["enabled"] is False


# ---------------------------------------------------------------------------------------------- concurrency


def test_caps_are_exact_under_a_concurrent_burst(env, monkeypatch):
    """Without the advisory lock every concurrent store read the same 'bytes used' before inserting and a burst
    sailed past the cap (measured: a cap of 2 images stored 4-15). With it, the cap holds exactly."""
    import threading

    c, key, _ = env
    for _ in range(12):  # twelve usage rows with no content yet (logging is still off)
        assert _chat(c, key, [{"type": "text", "text": "x"}]).status_code == 200
    ws = c.get("/api/workspace").json()["id"]
    usage_ids = [u.id for u in _usage_rows()]
    one = len(crypto.encrypt_bytes(PNG))
    monkeypatch.setattr(settings, "CONTENT_IMAGE_MAX_BYTES_PER_WORKSPACE", one * 2)
    barrier = threading.Barrier(len(usage_ids))

    def work(uid):
        cap = content_capture.ContentCapture(ws, "chat", {"model": "m"}, False, 1)
        cap.want_images = True
        cap.images = [content_images.Candidate("input", 0, b64=B64(PNG))]
        barrier.wait()
        content_capture.store(uid, cap)

    threads = [threading.Thread(target=work, args=(u,)) for u in usage_ids]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(_imgs()) == 2  # exactly the cap, never more
    assert len(_contents()) == 12  # every request still got its text record
    skipped = [
        r for row in _contents() for r in content_capture.load(row).get("images_skipped", [])
    ]
    assert len(skipped) == 10 and {x["reason"] for x in skipped} == {"cap_reached"}
