"""Storage safety for stored content/images: cleanup-failure logging, cap accounting for expired-but-not-yet-deleted
images, and the throttled sweep that runs from authenticated request paths (so storage is reclaimed even when
logging is off or traffic is low). Mocked providers only."""

import base64
import json
import logging
import threading
import time
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select, text

from app import content_capture, content_images, crypto
from app.config import settings
from app.db import SessionLocal
from app.models import UsageContent, UsageContentImage, UsageLog

PNG = b"\x89PNG\r\n\x1a\n" + b"png-body-" * 20
DATA_PNG = "data:image/png;base64," + base64.b64encode(PNG).decode()
ALL = ["openai", "anthropic", "gemini", "openrouter"]


@pytest.fixture()
def env(admin_client, make_live_key, mock_provider):
    return admin_client, make_live_key(allowed_providers=ALL, default_provider="openai", content_logging_enabled=True, image_logging_enabled=True), mock_provider


def _chat(c, key, parts=None):
    parts = parts or [{"type": "text", "text": "hi"}]
    body = {"model": "openai/gpt-4o-mini", "messages": [{"role": "user", "content": parts}]}
    return c.post("/v1/chat/completions", json=body, headers={"Authorization": f"Bearer {key['key']}"})


def _rows() -> list[UsageContent]:
    with SessionLocal() as db:
        return list(db.scalars(select(UsageContent).order_by(UsageContent.id)))


def _imgs() -> list[UsageContentImage]:
    with SessionLocal() as db:
        return list(db.scalars(select(UsageContentImage).order_by(UsageContentImage.id)))


def _add_expired_content(workspace_id: int, usage_id: int, hours_ago: float = 2) -> None:
    with SessionLocal() as db:
        db.add(
            UsageContent(
                usage_log_id=usage_id,
                workspace_id=workspace_id,
                kind="chat",
                content_encrypted=crypto.encrypt(json.dumps({"v": 1, "kind": "chat", "request": {}, "response": {}})),
                expires_at=datetime.now(UTC) - timedelta(hours=hours_ago),
            )
        )
        db.commit()


def _usage_ids() -> list[int]:
    with SessionLocal() as db:
        return [u.id for u in db.scalars(select(UsageLog).order_by(UsageLog.id))]


def _fresh_sweep_state(monkeypatch, *, inline=True, last=None):
    monkeypatch.setattr(content_capture, "_last_sweep", last)
    monkeypatch.setattr(content_capture, "_SWEEP_INLINE", inline)


# ------------------------------------------------------------------------------ cleanup failure logging


def test_cleanup_failures_are_logged_safely_and_are_recoverable(env, monkeypatch, caplog):
    c, key, _ = env
    for _ in range(2):
        _chat(c, key)
    ws = c.get("/api/workspace").json()["id"]
    ids = _usage_ids()
    _add_expired_content(ws, ids[0])
    _add_expired_content(ws, ids[1])

    real_delete = content_capture.delete

    def boom(*a, **k):
        raise RuntimeError("SECRET-DETAIL sk-proj-abcdefghijklmnopqrstuvwx")

    monkeypatch.setattr(content_capture, "delete", boom)
    with SessionLocal() as db, caplog.at_level(logging.WARNING, logger="app.content_capture"):
        assert content_capture.cleanup_expired(db) == 0  # reports 0, raises nothing
    logged = " ".join(r.getMessage() for r in caplog.records)
    assert "expiry cleanup failed" in logged and "RuntimeError" in logged and "2 record(s)" in logged
    assert "SECRET-DETAIL" not in logged and "sk-proj" not in logged  # class + count only, never the message
    assert len(_rows()) == 2  # nothing was lost or half-deleted

    monkeypatch.setattr(content_capture, "delete", real_delete)  # the fault clears: the next sweep recovers
    with SessionLocal() as db:
        assert content_capture.cleanup_expired(db) == 2
    assert _rows() == []
    assert len(_usage_ids()) == 2  # analytics untouched throughout


def test_a_failing_sweep_never_breaks_requests_or_the_startup(env, monkeypatch, caplog):
    c, key, _ = env
    monkeypatch.setattr(content_capture, "delete", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("x")))
    ws = c.get("/api/workspace").json()["id"]
    _chat(c, key)
    _add_expired_content(ws, _usage_ids()[0])
    _fresh_sweep_state(monkeypatch)
    with caplog.at_level(logging.WARNING, logger="app.content_capture"):
        assert c.get("/api/workspace").status_code == 200  # triggers the sweep, which fails inside
        assert _chat(c, key).status_code == 200
        content_capture.cleanup_expired_startup()  # boot must survive it too
    assert any("expiry cleanup failed" in r.getMessage() for r in caplog.records)


# ------------------------------------------------------------------------------------- cap accounting


def _store_one_image(c, key):
    assert c.patch("/api/workspace/content-logging", json={"enabled": True}).status_code == 200
    assert c.patch("/api/workspace/image-logging", json={"enabled": True}).status_code == 200
    assert _chat(c, key, [{"type": "image_url", "image_url": {"url": DATA_PNG}}]).status_code == 200


def _expire_everything():
    with SessionLocal() as db:
        db.execute(text("update usage_content_images set expires_at = now() - interval '1 hour'"))
        db.execute(text("update usage_content set expires_at = now() - interval '1 hour'"))
        db.commit()


def test_caps_count_expired_but_undeleted_images_while_the_meter_shows_live_only(env, monkeypatch):
    c, key, _ = env
    _store_one_image(c, key)
    one = len(crypto.encrypt_bytes(PNG))
    ws = c.get("/api/workspace").json()["id"]
    _expire_everything()
    with SessionLocal() as db:
        assert content_images.usage_bytes(db, ws) == 0  # live: what the meter shows
        assert content_images.usage_bytes(db, ws, include_expired=True) == one  # physical: still occupying space
        assert content_images.usage_bytes(db, include_expired=True) == one
    assert c.get("/api/workspace").json()["image_logging"]["used_bytes"] == 0  # user-facing meter: live only

    # With the sweep unable to run, the expired bytes still hold the cap: a new image is skipped, not stored.
    monkeypatch.setattr(content_capture, "cleanup_expired", lambda *a, **k: 0)
    monkeypatch.setattr(settings, "CONTENT_IMAGE_MAX_BYTES_PER_WORKSPACE", one + 50)
    assert _chat(c, key, [{"type": "image_url", "image_url": {"url": DATA_PNG}}]).status_code == 200
    assert len(_imgs()) == 1  # still only the expired one
    newest = c.get("/api/requests").json()["items"][0]["id"]
    assert c.get(f"/api/requests/{newest}/content").json()["content"]["images_skipped"] == [
        {"role": "input", "reason": "cap_reached"}
    ]


def test_an_image_bearing_store_frees_expired_images_first_so_the_cap_is_not_wasted(env, monkeypatch):
    c, key, _ = env
    _store_one_image(c, key)
    one = len(crypto.encrypt_bytes(PNG))
    _expire_everything()
    monkeypatch.setattr(settings, "CONTENT_IMAGE_MAX_BYTES_PER_WORKSPACE", one + 50)
    assert _chat(c, key, [{"type": "image_url", "image_url": {"url": DATA_PNG}}]).status_code == 200
    live = [i for i in _imgs()]
    assert len(live) == 1  # the expired image was deleted, the new one stored within the same cap
    assert live[0].expires_at > datetime.now(UTC)


def test_the_global_cap_also_counts_expired_images(env, monkeypatch):
    c, key, _ = env
    _store_one_image(c, key)
    one = len(crypto.encrypt_bytes(PNG))
    _expire_everything()
    monkeypatch.setattr(content_capture, "cleanup_expired", lambda *a, **k: 0)
    monkeypatch.setattr(settings, "CONTENT_IMAGE_MAX_BYTES_TOTAL", one)
    assert _chat(c, key, [{"type": "image_url", "image_url": {"url": DATA_PNG}}]).status_code == 200
    assert len(_imgs()) == 1


# ------------------------------------------------------------------------------------------- scheduling


def test_the_sweep_is_throttled(env, monkeypatch):
    c, key, _ = env
    ws = c.get("/api/workspace").json()["id"]
    for _ in range(3):
        _chat(c, key)
    ids = _usage_ids()
    _fresh_sweep_state(monkeypatch)
    _add_expired_content(ws, ids[0])
    assert content_capture.maybe_sweep() is True and _rows() == []  # first call runs

    _add_expired_content(ws, ids[1])
    assert content_capture.maybe_sweep() is False and len(_rows()) == 1  # within the interval: skipped
    monkeypatch.setattr(content_capture, "_last_sweep", time.monotonic() - settings.CONTENT_SWEEP_INTERVAL_SECONDS - 1)
    assert content_capture.maybe_sweep() is True and _rows() == []  # due again


def test_expired_images_are_reclaimed_by_signed_in_traffic_even_when_logging_is_off(env, monkeypatch):
    c, key, _ = env
    _store_one_image(c, key)
    assert c.patch("/api/workspace/image-logging", json={"enabled": False}).status_code == 200
    assert c.patch("/api/workspace/content-logging", json={"enabled": False}).status_code == 200  # both OFF now
    _expire_everything()
    assert len(_rows()) == 1 and len(_imgs()) == 1  # still physically present
    _fresh_sweep_state(monkeypatch)
    assert c.get("/api/workspace").status_code == 200  # any ordinary signed-in request
    assert _rows() == [] and _imgs() == []  # reclaimed, with no capture and no admin visit to Requests


def test_expired_content_is_reclaimed_by_low_gateway_traffic_with_a_virtual_key(env, monkeypatch):
    c, key, _ = env
    ws = c.get("/api/workspace").json()["id"]
    _chat(c, key)  # logging never enabled
    _add_expired_content(ws, _usage_ids()[0])
    _fresh_sweep_state(monkeypatch)
    assert _chat(c, key).status_code == 200  # one ordinary gateway request
    assert _rows() == []


def test_unauthenticated_requests_never_trigger_a_sweep(env, client, monkeypatch):
    _fresh_sweep_state(monkeypatch)
    assert client.get("/api/workspace").status_code == 401  # no session
    assert client.post("/v1/chat/completions", json={}).status_code == 401  # no virtual key
    assert client.post("/v1/chat/completions", json={}, headers={"Authorization": "Bearer vk_nope"}).status_code == 401
    assert client.get("/healthz").status_code == 200
    assert content_capture._last_sweep is None  # nothing ran, and /healthz never touches the database


def test_the_sweep_runs_on_a_background_thread_and_does_not_delay_the_request(env, monkeypatch):
    c, key, _ = env
    ws = c.get("/api/workspace").json()["id"]
    _chat(c, key)
    _add_expired_content(ws, _usage_ids()[0])
    _fresh_sweep_state(monkeypatch, inline=False)
    started = threading.Event()
    release = threading.Event()
    real = content_capture._run_sweep

    def slow():
        started.set()
        release.wait(10)
        real()

    monkeypatch.setattr(content_capture, "_run_sweep", slow)
    assert c.get("/api/workspace").status_code == 200  # returns while the sweep is still blocked
    assert started.wait(5) and len(_rows()) == 1
    release.set()
    for t in threading.enumerate():
        if t.name == "content-sweep":
            t.join(10)
    assert _rows() == []


def test_a_scheduling_error_never_breaks_a_request(env, monkeypatch):
    c, key, _ = env
    _fresh_sweep_state(monkeypatch, inline=False)
    monkeypatch.setattr(threading, "Thread", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no threads")))
    assert c.get("/api/workspace").status_code == 200
    assert _chat(c, key).status_code == 200


def test_toggling_image_logging_sweeps_expired_content(env):
    c, key, _ = env
    _store_one_image(c, key)
    _expire_everything()
    assert len(_imgs()) == 1
    assert c.patch("/api/workspace/image-logging", json={"enabled": False}).status_code == 200
    assert _imgs() == [] and _rows() == []


def test_the_boot_sweep_counts_as_the_intervals_run(env, monkeypatch):
    monkeypatch.setattr(content_capture, "_last_sweep", None)
    content_capture.cleanup_expired_startup()
    assert content_capture._last_sweep is not None
    assert content_capture.maybe_sweep() is False  # no duplicate sweep right after boot


# ------------------------------------------------------------- retry after a failed sweep (~5 minutes, bounded)


class _Clock:
    """A controllable time.monotonic() for content_capture only (everything else keeps the real clock)."""

    def __init__(self, start=10_000.0):
        self.now = start

    def monotonic(self):
        return self.now


def _use_clock(monkeypatch, start=10_000.0):
    clock = _Clock(start)
    monkeypatch.setattr(content_capture, "time", clock)
    return clock


def _break_delete(monkeypatch):
    monkeypatch.setattr(content_capture, "delete", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down")))


def _fix_delete(monkeypatch):
    from sqlalchemy import delete

    monkeypatch.setattr(content_capture, "delete", delete)


def test_a_failed_sweep_is_retried_in_about_five_minutes_not_a_full_interval(env, monkeypatch):
    c, key, _ = env
    clock = _use_clock(monkeypatch)
    ws = c.get("/api/workspace").json()["id"]
    _chat(c, key)
    _add_expired_content(ws, _usage_ids()[0])
    monkeypatch.setattr(settings, "CONTENT_SWEEP_INTERVAL_SECONDS", 3600)
    _fresh_sweep_state(monkeypatch)  # AFTER the setup requests: they would otherwise consume the sweep slot

    _break_delete(monkeypatch)
    assert content_capture.maybe_sweep() is True  # runs, fails inside
    assert len(_rows()) == 1
    clock.now += 299
    assert content_capture.maybe_sweep() is False  # still throttled (no retry storm)
    clock.now += 2  # 301 s after the failure: eligible again, an hour before the normal interval
    _fix_delete(monkeypatch)
    assert content_capture.maybe_sweep() is True and _rows() == []  # the retry recovers the backlog

    # ...and after a SUCCESS the normal (long) interval applies again
    clock.now += 600
    assert content_capture.maybe_sweep() is False
    clock.now += 3000
    assert content_capture.maybe_sweep() is True


def test_a_persistent_failure_cannot_cause_a_retry_storm(env, monkeypatch):
    c, key, _ = env
    clock = _use_clock(monkeypatch)
    monkeypatch.setattr(settings, "CONTENT_SWEEP_INTERVAL_SECONDS", 3600)
    ws = c.get("/api/workspace").json()["id"]
    _chat(c, key)
    _add_expired_content(ws, _usage_ids()[0])
    _break_delete(monkeypatch)
    _fresh_sweep_state(monkeypatch)
    attempts = 0
    for _ in range(360):  # an hour of requests, one every 10 seconds
        attempts += content_capture.maybe_sweep()
        clock.now += 10
    assert 10 <= attempts <= 13  # ~one per 5 minutes: bounded, but it does keep retrying


def test_a_short_interval_is_never_stretched_by_the_retry_delay(env, monkeypatch):
    c, key, _ = env
    clock = _use_clock(monkeypatch)
    monkeypatch.setattr(settings, "CONTENT_SWEEP_INTERVAL_SECONDS", 60)
    ws = c.get("/api/workspace").json()["id"]
    _chat(c, key)
    _add_expired_content(ws, _usage_ids()[0])
    _break_delete(monkeypatch)
    _fresh_sweep_state(monkeypatch)
    assert content_capture.maybe_sweep() is True
    clock.now += 61
    assert content_capture.maybe_sweep() is True  # min(300, interval): never later than the normal interval


def test_a_thread_that_cannot_start_is_retried_in_about_five_minutes(env, monkeypatch):
    c, key, _ = env
    clock = _use_clock(monkeypatch)
    _fresh_sweep_state(monkeypatch, inline=False)
    monkeypatch.setattr(settings, "CONTENT_SWEEP_INTERVAL_SECONDS", 3600)
    real_thread = threading.Thread

    def cannot_start(*a, **k):
        raise RuntimeError("can't start new thread")

    monkeypatch.setattr(threading, "Thread", cannot_start)
    assert content_capture.maybe_sweep() is False  # reports not started, raises nothing
    assert c.get("/api/workspace").status_code == 200 and _chat(c, key).status_code == 200  # requests unaffected
    clock.now += 299
    assert content_capture.maybe_sweep() is False  # throttled
    clock.now += 2
    monkeypatch.setattr(threading, "Thread", real_thread)
    assert content_capture.maybe_sweep() is True  # eligible again and now it starts
    for t in threading.enumerate():
        if t.name == "content-sweep":
            t.join(10)


def test_a_failed_startup_sweep_gets_the_same_early_retry(env, monkeypatch):
    c, key, _ = env
    clock = _use_clock(monkeypatch)
    monkeypatch.setattr(content_capture, "_last_sweep", None)
    monkeypatch.setattr(content_capture, "_SWEEP_INLINE", True)
    monkeypatch.setattr(settings, "CONTENT_SWEEP_INTERVAL_SECONDS", 3600)
    ws = c.get("/api/workspace").json()["id"]
    _chat(c, key)
    _add_expired_content(ws, _usage_ids()[0])
    _break_delete(monkeypatch)
    content_capture.cleanup_expired_startup()  # fails, must not raise or block boot
    clock.now += 100
    assert content_capture.maybe_sweep() is False
    clock.now += 201
    _fix_delete(monkeypatch)
    assert content_capture.maybe_sweep() is True and _rows() == []


def test_a_successful_startup_sweep_keeps_the_normal_interval(env, monkeypatch):
    clock = _use_clock(monkeypatch)
    monkeypatch.setattr(content_capture, "_last_sweep", None)
    content_capture.cleanup_expired_startup()
    clock.now += 400
    assert content_capture.maybe_sweep() is False  # no early retry when nothing failed


# --------------------------------------------------------------- the smaller synchronous pre-store cleanup


def _usage_rows_without_content(c, key, n):
    for _ in range(n):
        assert _chat(c, key).status_code == 200  # logging is still off: usage rows only
    return _usage_ids()


def test_an_image_bearing_store_frees_at_most_fifty_expired_records_the_sweep_keeps_the_bulk(env, monkeypatch):
    c, key, _ = env
    # store() has a 2% chance of also running an opportunistic sweep at its end, which would delete the 10
    # leftovers this test expects to remain; pin it off so the test is deterministic.
    monkeypatch.setattr(content_capture, "_SWEEP_PROBABILITY", 0)
    n = 60
    ids = _usage_rows_without_content(c, key, n + 1)
    ws = c.get("/api/workspace").json()["id"]
    for uid in ids[:n]:
        _add_expired_content(ws, uid)
    assert content_capture._PRESTORE_CLEANUP_LIMIT == 50

    cap = content_capture.ContentCapture(ws, "chat", {"model": "m"}, False, 1)
    cap.want_images = True
    cap.images = [content_images.Candidate("input", 0, b64=base64.b64encode(PNG).decode())]
    assert content_capture.store(ids[n], cap) is True
    expired_left = [r for r in _rows() if r.expires_at <= datetime.now(UTC)]
    assert len(expired_left) == 10  # exactly 50 of 60 freed inline, 10 left for the sweep
    assert len(_imgs()) == 1  # and the new image was stored

    # the scheduled sweep still deletes in the full 500-record batches
    limits = []
    real = content_capture._cleanup_batch
    monkeypatch.setattr(content_capture, "_cleanup_batch", lambda db, limit: (limits.append(limit), real(db, limit))[1])
    content_capture._run_sweep()
    assert limits == [500] and [r for r in _rows() if r.expires_at <= datetime.now(UTC)] == []


# ------------------------------------------------------- ordered, row-locked (SKIP LOCKED) cleanup, concurrently


def test_cleanup_skips_records_another_transaction_has_locked_instead_of_blocking(env):
    c, key, _ = env
    ids = _usage_rows_without_content(c, key, 3)
    ws = c.get("/api/workspace").json()["id"]
    for uid in ids:
        _add_expired_content(ws, uid)
    holder = SessionLocal()
    try:
        locked = holder.scalars(
            select(UsageContent.id).where(UsageContent.expires_at <= func.now()).order_by(UsageContent.id).limit(2).with_for_update()
        ).all()
        assert len(locked) == 2  # another sweeper is mid-way through the two lowest ids
        out = {}

        def other():
            with SessionLocal() as db:
                out["n"] = content_capture.cleanup_expired(db)

        t = threading.Thread(target=other)
        t.start()
        t.join(5)
        assert not t.is_alive(), "cleanup blocked on rows another transaction holds"
        assert out["n"] == 1 and len(_rows()) == 2  # took only the unlocked record
    finally:
        holder.rollback()
        holder.close()
    with SessionLocal() as db:
        assert content_capture.cleanup_expired(db) == 2  # the skipped ones are picked up by the next sweep
    assert _rows() == []


def test_concurrent_cleanup_workers_split_the_backlog_exactly_without_errors(env, caplog):
    c, key, _ = env
    n = 40
    ids = _usage_rows_without_content(c, key, n)
    ws = c.get("/api/workspace").json()["id"]
    for uid in ids:
        _add_expired_content(ws, uid)
    with SessionLocal() as db:  # give every record an image too, so the cascade is part of the deletes
        for row in db.scalars(select(UsageContent)):
            blob = crypto.encrypt_bytes(PNG)
            db.add(UsageContentImage(content_id=row.id, workspace_id=ws, role="input", position=0, mime="image/png",
                                     byte_size=len(PNG), stored_bytes=len(blob), sha256="0" * 64, data_encrypted=blob,
                                     expires_at=row.expires_at))
        db.commit()
    assert len(_imgs()) == n

    totals, errors = [], []
    barrier = threading.Barrier(4)

    def worker():
        try:
            barrier.wait()
            got = 0
            with SessionLocal() as db:
                for _ in range(40):
                    k = content_capture.cleanup_expired(db, limit=7)
                    got += k
                    if k == 0 and not _rows_exist():
                        break
            totals.append(got)
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    def _rows_exist():
        with SessionLocal() as db:
            return db.scalar(select(UsageContent.id).limit(1)) is not None

    with caplog.at_level(logging.WARNING, logger="app.content_capture"):
        threads = [threading.Thread(target=worker) for _ in range(4)]
        [t.start() for t in threads]
        [t.join(60) for t in threads]
    assert errors == [] and len(totals) == 4
    assert sum(totals) == n  # every record deleted exactly once: no double counting, nothing left over
    assert _rows() == [] and _imgs() == []  # images went with their records
    assert not [r for r in caplog.records if "cleanup failed" in r.getMessage()]  # no deadlock / error path


def test_cap_enforcement_stays_exact_while_cleanup_workers_run_concurrently(env, monkeypatch):
    c, key, _ = env
    ids = _usage_rows_without_content(c, key, 11)
    ws = c.get("/api/workspace").json()["id"]
    one = len(crypto.encrypt_bytes(PNG))

    def capture(uid):
        cap = content_capture.ContentCapture(ws, "chat", {"model": "m"}, False, 1)
        cap.want_images = True
        cap.images = [content_images.Candidate("input", 0, b64=base64.b64encode(PNG).decode())]
        return cap

    # three expired images already occupy the physical cap (3 > 2)
    for uid in ids[:3]:
        assert content_capture.store(uid, capture(uid))
    _expire_everything()
    assert len(_imgs()) == 3
    monkeypatch.setattr(settings, "CONTENT_IMAGE_MAX_BYTES_PER_WORKSPACE", one * 2)  # the backlog alone exceeds it

    stores = ids[3:]  # eight concurrent image-bearing stores
    sweepers = 3
    barrier = threading.Barrier(len(stores) + sweepers)
    errors = []

    def do_store(uid):
        try:
            barrier.wait()
            content_capture.store(uid, capture(uid))
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    def do_sweep():
        try:
            barrier.wait()
            with SessionLocal() as db:
                for _ in range(5):
                    content_capture.cleanup_expired(db, limit=2)
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=do_store, args=(u,)) for u in stores] + [
        threading.Thread(target=do_sweep) for _ in range(sweepers)
    ]
    [t.start() for t in threads]
    [t.join(60) for t in threads]
    assert errors == [] and not any(t.is_alive() for t in threads)
    live = [i for i in _imgs() if i.expires_at > datetime.now(UTC)]
    assert len(live) <= 2  # the cap held exactly, whatever the interleaving
    assert len([r for r in _rows() if r.expires_at > datetime.now(UTC)]) == len(stores)  # every store kept its text
    with SessionLocal() as db:
        assert content_capture.cleanup_expired(db) >= 0  # and the backlog is still collectable afterwards
        while content_capture.cleanup_expired(db):
            pass
    assert [i for i in _imgs() if i.expires_at <= datetime.now(UTC)] == []


# ------------------------------------------- an empty cleanup must not disturb the caller's loaded rows (no N+1)


class _Statements:
    """Counts SQL statements sent through the engine while active."""

    def __init__(self):
        self.n = 0

    def __enter__(self):
        from sqlalchemy import event

        from app.db import engine

        self._event, self._engine = event, engine
        event.listen(engine, "before_cursor_execute", self._hit)
        return self

    def _hit(self, *a, **k):
        self.n += 1

    def __exit__(self, *exc):
        self._event.remove(self._engine, "before_cursor_execute", self._hit)


def test_an_empty_cleanup_does_not_expire_rows_the_caller_already_loaded(env):
    c, key, _ = env
    for _ in range(25):
        assert _chat(c, key).status_code == 200
    with SessionLocal() as db:
        rows = db.execute(select(UsageLog)).scalars().all()
        assert len(rows) == 25
        with _Statements() as q:
            assert content_capture.cleanup_expired(db) == 0  # nothing expired: the common case
            before_reads = q.n
            _ = [(u.id, u.ts, u.model, u.status, u.total_tokens) for u in rows]  # what a list view then reads
        assert before_reads == 1  # just the (locking) select
        assert q.n == before_reads  # reading the loaded rows afterwards issued no refresh queries


def test_the_requests_first_page_issues_the_same_number_of_queries_whatever_the_row_count(env):
    c, key, _ = env

    def first_page_statements() -> int:
        with _Statements() as q:
            assert c.get("/api/requests?limit=50").status_code == 200
        return q.n

    for _ in range(3):
        assert _chat(c, key).status_code == 200
    few = first_page_statements()
    for _ in range(20):
        assert _chat(c, key).status_code == 200
    many = first_page_statements()
    assert many == few  # 23 rows cost the same queries as 3: no per-row refresh after the cleanup call
