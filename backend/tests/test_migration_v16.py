"""Migration v16 (guardrails): two defaulted columns plus six new tables. Additive, atomic, safe to repeat and to race,
changes no existing row, and fails LOUDLY if it cannot get its lock. `_migrate` is not run by the normal test schema
(create_all), so these tests drive the migration code directly."""
import threading

import pytest
from sqlalchemy import text
from sqlalchemy.exc import OperationalError

from app import bootstrap as bs
from app.db import SessionLocal, engine
from app.models import Base, UsageLog, User, VirtualKey, Workspace

TABLES = ["guardrail_hits", "guardrail_recording_counters", "key_guardrail_sets", "guardrail_rules",
          "guardrail_rule_sets", "audit_events"]
CHECK = text(
    "SELECT (SELECT count(*) FROM workspaces), (SELECT count(*) FROM virtual_keys), (SELECT count(*) FROM usage_logs), "
    "(SELECT md5(coalesce(string_agg(concat_ws('|', id, key_id, request_id, status, total_tokens, ts::text), ',' ORDER BY id), '')) FROM usage_logs)"
)


def _legacy_shape():
    """What a pre-v16 database looks like: no guardrail tables, and neither new column."""
    with SessionLocal() as db:
        for t in TABLES:
            db.execute(text(f"DROP TABLE IF EXISTS {t} CASCADE"))
        db.execute(text("ALTER TABLE workspaces DROP COLUMN IF EXISTS guardrail_version"))
        db.execute(text("ALTER TABLE virtual_keys DROP COLUMN IF EXISTS has_guardrails"))
        db.commit()


def _has_col(table, col) -> bool:
    with SessionLocal() as db:
        return bool(db.scalar(text("SELECT 1 FROM information_schema.columns WHERE table_name=:t AND column_name=:c"), {"t": table, "c": col}))


def _has_table(t) -> bool:
    with SessionLocal() as db:
        return bool(db.scalar(text("SELECT to_regclass(:t)"), {"t": t}))


@pytest.fixture(autouse=True)
def _restore_schema():
    yield
    with SessionLocal() as db:
        bs._migrate_v16_guardrails(db)
    Base.metadata.create_all(bind=engine)


def _seed():
    with SessionLocal() as db:
        ws = Workspace(name="mig16")
        db.add(ws)
        db.flush()
        db.add(User(username="mig16", password_hash="x", workspace_id=ws.id, workspace_role="admin"))
        key = VirtualKey(workspace_id=ws.id, label="k", key_hash="h16", key_prefix="vk_m16")
        db.add(key)
        db.flush()
        for i in range(10):
            db.add(UsageLog(key_id=key.id, request_id=f"m16-{i}", provider="openai", model="m", prompt_tokens=i,
                            completion_tokens=1, total_tokens=i + 1, cost=0.001, latency_ms=5, status="success"))
        db.commit()


def _snapshot():
    with SessionLocal() as db:
        return tuple(db.execute(CHECK).one())


def test_upgrading_a_legacy_database_adds_everything_and_changes_no_existing_row():
    _seed()
    _legacy_shape()
    before = _snapshot()
    assert not _has_col("workspaces", "guardrail_version") and not _has_table("guardrail_hits")
    with SessionLocal() as db:
        bs.bootstrap(db)  # the real boot-time entry point
    assert _has_col("workspaces", "guardrail_version") and _has_col("virtual_keys", "has_guardrails")
    assert all(_has_table(t) for t in TABLES)
    assert _snapshot() == before
    with SessionLocal() as db:
        assert db.scalar(text("SELECT count(*) FROM workspaces WHERE guardrail_version <> 0")) == 0  # nothing backfilled
        assert db.scalar(text("SELECT count(*) FROM virtual_keys WHERE has_guardrails")) == 0  # existing keys: off


def test_running_it_again_is_a_no_op():
    _seed()
    before = _snapshot()
    for _ in range(3):
        with SessionLocal() as db:
            bs.bootstrap(db)
    assert _snapshot() == before and all(_has_table(t) for t in TABLES)


def test_several_processes_booting_at_once_do_not_fail_or_duplicate():
    _seed()
    _legacy_shape()
    start = threading.Barrier(6)
    errors: list[BaseException] = []

    def boot():
        try:
            with SessionLocal() as db:
                start.wait(10)
                bs._migrate_v16_guardrails(db)
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    ts = [threading.Thread(target=boot) for _ in range(6)]
    [t.start() for t in ts]
    [t.join(60) for t in ts]
    assert not errors, errors
    assert _has_col("workspaces", "guardrail_version") and all(_has_table(t) for t in TABLES)


def test_it_fails_loudly_if_it_cannot_get_its_lock_then_works(monkeypatch):
    _legacy_shape()
    monkeypatch.setattr(bs, "_V15_LOCK_TIMEOUT", "300ms")
    holder = engine.connect()
    tx = holder.begin()
    holder.execute(text("LOCK TABLE workspaces IN ACCESS EXCLUSIVE MODE"))
    try:
        with SessionLocal() as db, pytest.raises(OperationalError):
            bs._migrate_v16_guardrails(db)
        assert not _has_col("workspaces", "guardrail_version")  # nothing half-applied
    finally:
        tx.rollback()
        holder.close()
    with SessionLocal() as db:
        bs._migrate_v16_guardrails(db)
    assert _has_col("workspaces", "guardrail_version")


def test_the_new_columns_have_constant_defaults_and_the_hit_uniqueness_exists():
    with SessionLocal() as db:
        d = dict(db.execute(text(
            "SELECT column_name, column_default FROM information_schema.columns WHERE "
            "(table_name='workspaces' AND column_name='guardrail_version') OR (table_name='virtual_keys' AND column_name='has_guardrails')"
        )).all())
        uq = db.scalar(text("SELECT count(*) FROM pg_constraint WHERE conname='uq_guardrail_hit_request_rule'"))
    assert d == {"guardrail_version": "0", "has_guardrails": "false"} and uq == 1


def test_the_lock_timeout_does_not_leak_into_later_statements():
    with SessionLocal() as db:
        before = db.scalar(text("SHOW lock_timeout"))
        bs._migrate_v16_guardrails(db)
        assert db.scalar(text("SHOW lock_timeout")) == before
