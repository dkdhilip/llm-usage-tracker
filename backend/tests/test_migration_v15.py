"""Migration v15 (`usage_logs.guardrail`): one nullable column, added atomically, safe to repeat and to race, changing
no existing row, and failing LOUDLY (not silently skipping) if it cannot get its lock. The normal test schema is built
by `create_all`, which never runs `_migrate`, so these tests exercise the migration code directly."""
import datetime as dt
import threading

import pytest
from sqlalchemy import text
from sqlalchemy.exc import OperationalError

from app import bootstrap as bs
from app.db import SessionLocal, engine
from app.models import UsageLog

CHECKSUM = text(
    "SELECT count(*), md5(coalesce(string_agg(concat_ws('|', id, key_id, request_id, provider, model, prompt_tokens, "
    "completion_tokens, total_tokens, coalesce(cost::text, '~'), cost_source, latency_ms, status, mode, ts::text), ',' "
    "ORDER BY id), ''))::text FROM usage_logs"
)


def _has_column() -> bool:
    with SessionLocal() as db:
        return bool(db.scalar(text(
            "SELECT 1 FROM information_schema.columns WHERE table_name='usage_logs' AND column_name='guardrail'"
        )))


def _drop_column() -> None:
    with SessionLocal() as db:
        db.execute(text("ALTER TABLE usage_logs DROP COLUMN IF EXISTS guardrail"))
        db.commit()


@pytest.fixture(autouse=True)
def _always_restore_the_column():
    """Whatever a test does, the shared schema must end with the column (other tests need it)."""
    yield
    with SessionLocal() as db:
        db.execute(text("ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS guardrail VARCHAR(12)"))
        db.commit()


def _seed(n=25):
    with SessionLocal() as db:
        from app.models import User, VirtualKey, Workspace

        ws = Workspace(name="mig")
        db.add(ws)
        db.flush()
        user = User(username="miguser", password_hash="x", workspace_id=ws.id, workspace_role="admin")
        db.add(user)
        db.flush()
        key = VirtualKey(workspace_id=ws.id, assigned_user_id=None, label="k", key_hash="h", key_prefix="vk_mig")
        db.add(key)
        db.flush()
        for i in range(n):
            db.add(UsageLog(
                key_id=key.id, request_id=f"mig-{i}", provider="openrouter", model="m", prompt_tokens=i, completion_tokens=2,
                total_tokens=i + 2, cost=None if i % 5 == 0 else 0.001 * i, latency_ms=10 + i,
                status="error" if i % 7 == 0 else "success", ts=dt.datetime(2026, 1, 1, tzinfo=dt.UTC) + dt.timedelta(minutes=i),
            ))
        db.commit()


def _checksum():
    with SessionLocal() as db:
        return tuple(db.execute(CHECKSUM).one())


def test_fresh_schema_has_the_column_nullable_without_a_default():
    """The `create_all` path (a brand-new database) creates exactly the same column the migration adds."""
    with SessionLocal() as db:
        row = db.execute(text(
            "SELECT data_type, character_maximum_length, is_nullable, column_default FROM information_schema.columns "
            "WHERE table_name='usage_logs' AND column_name='guardrail'"
        )).one()
    assert tuple(row) == ("character varying", 12, "YES", None)


def test_upgrading_a_legacy_table_adds_the_column_and_changes_no_existing_row():
    _seed()
    _drop_column()  # the shape of a pre-v15 database
    legacy = _checksum()
    assert legacy[0] == 25 and not _has_column()

    with SessionLocal() as db:
        bs.bootstrap(db)  # the real boot-time entry point

    assert _has_column()
    assert _checksum() == legacy  # same row count and the same content in every pre-existing column
    with SessionLocal() as db:
        assert db.scalar(text("SELECT count(*) FROM usage_logs WHERE guardrail IS NOT NULL")) == 0  # nothing backfilled


def test_running_the_migration_again_is_a_no_op():
    _seed()
    before = _checksum()
    for _ in range(3):
        with SessionLocal() as db:
            bs.bootstrap(db)
    assert _has_column() and _checksum() == before
    with SessionLocal() as db:
        assert db.scalar(text(
            "SELECT count(*) FROM information_schema.columns WHERE table_name='usage_logs' AND column_name='guardrail'"
        )) == 1


def test_several_processes_booting_at_once_do_not_fail_or_duplicate():
    """The older guarded blocks are check-then-act; v15 uses ADD COLUMN IF NOT EXISTS so a race is harmless."""
    _seed()
    _drop_column()
    start = threading.Barrier(8)
    errors: list[BaseException] = []

    def boot():
        try:
            with SessionLocal() as db:
                start.wait(timeout=10)
                bs._migrate_v15_usage_guardrail(db)
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=boot) for _ in range(8)]
    [t.start() for t in threads]
    [t.join(timeout=30) for t in threads]
    assert not errors, errors
    assert _has_column()


def test_it_fails_loudly_if_it_cannot_get_its_lock_and_works_once_the_lock_is_free(monkeypatch):
    """Skipping the column would break every ORM query on UsageLog at request time, so a stuck lock must fail the
    boot (the previous deploy keeps serving) rather than be ignored."""
    _drop_column()
    monkeypatch.setattr(bs, "_V15_LOCK_TIMEOUT", "300ms")
    holder = engine.connect()
    tx = holder.begin()
    holder.execute(text("LOCK TABLE usage_logs IN ACCESS EXCLUSIVE MODE"))  # a long-running transaction
    try:
        with SessionLocal() as db, pytest.raises(OperationalError):
            bs._migrate_v15_usage_guardrail(db)
        assert not _has_column()  # nothing half-applied
    finally:
        tx.rollback()
        holder.close()

    with SessionLocal() as db:
        bs._migrate_v15_usage_guardrail(db)
    assert _has_column()


def test_the_lock_timeout_does_not_leak_into_later_statements_on_the_session():
    """SET LOCAL ends with the transaction: the session's next statements run with the server default again."""
    _drop_column()
    with SessionLocal() as db:
        before = db.scalar(text("SHOW lock_timeout"))
        bs._migrate_v15_usage_guardrail(db)
        assert db.scalar(text("SHOW lock_timeout")) == before
