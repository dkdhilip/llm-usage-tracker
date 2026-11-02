"""PR1 of the guardrails work: a usage row with status 'blocked' (a request stopped before any provider call: no
tokens, no cost, a near-zero latency) must change NOTHING that analytics, budgets, caps or key/member rollups report.

Nothing writes such rows yet. These tests insert them directly, so the exclusion is proven before any writer exists.
The Requests list is the one place that does show them."""
import datetime as dt

import pytest

from app.config import settings
from app.db import SessionLocal
from app.gateway import enforce_workspace_quota, period_spend
from app.models import UsageLog, VirtualKey
from app.usage_status import BLOCKED, GUARDRAIL_BLOCKED

NOW = dt.datetime.now(dt.UTC)


def _row(key_id, rid, *, provider, model, status="success", latency=100, cost=0.01, tokens=(10, 20), ts=None, guardrail=None):
    return UsageLog(
        key_id=key_id, request_id=rid, provider=provider, model=model,
        prompt_tokens=tokens[0], completion_tokens=tokens[1], total_tokens=tokens[0] + tokens[1],
        cost=cost, cost_source="configured", latency_ms=latency, status=status, guardrail=guardrail,
        ts=ts or NOW,
    )


def _seed_real(key_a, key_b):
    """Requests that reached a provider: several keys, providers, models, days, latencies, errors and one unpriced."""
    rows = []
    lat = [120, 340, 80, 900, 450, 60, 700, 210, 95, 1500, 30, 640]
    for i, ms in enumerate(lat):
        key = key_a if i % 2 == 0 else key_b
        provider, model = ("openrouter", "m-a") if i % 3 else ("openai", "gpt-x")
        rows.append(
            _row(
                key, f"real-{i}", provider=provider, model=model, latency=ms,
                status="error" if i in (3, 8) else "success",
                cost=None if i == 5 else round(0.001 * (i + 1), 6),
                ts=NOW - dt.timedelta(days=i % 4, hours=i),
            )
        )
    with SessionLocal() as db:
        db.add_all(rows)
        db.commit()


def _seed_blocked(key_a, key_b, *, n=6):
    """Blocked rows designed to distort every aggregate if one of them forgot to exclude them: latency ~0 (drags
    percentiles and tokens/sec), the newest timestamps (moves max(ts)), a provider/model pair that no real request
    has (a phantom group), zero cost, zero tokens, on both keys."""
    rows = []
    for i in range(n):
        key = key_a if i % 2 == 0 else key_b
        provider, model = ("anthropic", "ghost-model") if i % 3 == 0 else ("openrouter", "m-a")
        rows.append(
            _row(
                key, f"blocked-{i}", provider=provider, model=model, status=BLOCKED, guardrail=GUARDRAIL_BLOCKED,
                latency=i % 2, cost=0.0, tokens=(0, 0), ts=NOW + dt.timedelta(minutes=i + 1),
            )
        )
    with SessionLocal() as db:
        db.add_all(rows)
        db.commit()


def _snapshot(admin, member, key_ids):
    """Everything that counts requests, for several filters, minus the one field that exists to report blocked rows."""
    a, b = key_ids
    start = (NOW - dt.timedelta(days=2)).isoformat()
    queries = [
        {}, {"key_id": a}, {"key_id": b}, {"provider": "openrouter"}, {"provider": "openai"}, {"model": "m-a"},
        {"start": start}, {"key_id": a, "provider": "openrouter"},
    ]
    out = {}
    for q in queries:
        label = repr(sorted(q.items()))
        r = admin.get("/api/usage/summary", params=q)
        assert r.status_code == 200, r.text
        s = r.json()
        s.pop("blocked_requests")
        out[f"summary{label}"] = s
        for ep in ("timeseries", "by-key", "by-model"):
            r = admin.get(f"/api/usage/{ep}", params=q)
            assert r.status_code == 200, r.text
            out[f"{ep}{label}"] = r.json()
    out["keys"] = admin.get("/api/keys").json()
    out["workspace_members"] = admin.get("/api/workspace").json()["members"]
    out["member_summary"] = {k: v for k, v in member.get("/api/usage/summary").json().items() if k != "blocked_requests"}
    out["member_by_key"] = member.get("/api/usage/by-key").json()
    out["member_keys"] = member.get("/api/keys").json()
    return out


@pytest.fixture()
def world(admin_client, new_member):
    member, uid = new_member(admin_client)
    mk = lambda label, **o: admin_client.post(  # noqa: E731
        "/api/keys", json={"label": label, "allowed_providers": ["openrouter"], **o}
    ).json()
    a = mk("hers", assigned_user_id=uid)
    b = mk("shared")
    _seed_real(a["id"], b["id"])
    return admin_client, member, (a["id"], b["id"])


def test_blocked_rows_change_no_analytics_number(world):
    admin, member, keys = world
    before = _snapshot(admin, member, keys)
    assert admin.get("/api/usage/summary").json()["blocked_requests"] == 0

    _seed_blocked(*keys)

    assert admin.get("/api/usage/summary").json()["blocked_requests"] == 6
    after = _snapshot(admin, member, keys)
    # every request count, error rate, p50/p95, tokens/sec, cost, unpriced count, last-used and active-keys figure,
    # for every filter, for the admin and for a member, is exactly what it was without the blocked rows
    assert after.keys() == before.keys()
    for name in before:
        assert after[name] == before[name], f"{name} changed when blocked rows were added"


def test_blocked_requests_are_reported_on_their_own_and_respect_filters(world):
    admin, _member, (a, b) = world
    _seed_blocked(a, b, n=6)  # even i -> key a, odd -> key b; i % 3 == 0 -> anthropic/ghost-model
    assert admin.get("/api/usage/summary").json()["blocked_requests"] == 6
    assert admin.get(f"/api/usage/summary?key_id={a}").json()["blocked_requests"] == 3
    assert admin.get("/api/usage/summary?provider=anthropic").json()["blocked_requests"] == 2
    future = (NOW + dt.timedelta(minutes=3, seconds=30)).isoformat()
    assert admin.get("/api/usage/summary", params={"start": future}).json()["blocked_requests"] == 3
    # no phantom (provider, model) group, and a member's own count only includes their key
    assert not [g for g in admin.get("/api/usage/by-model").json() if g["model"] == "ghost-model"]


def test_member_sees_only_blocked_counts_for_their_own_key(world):
    admin, member, (a, b) = world
    _seed_blocked(a, b, n=6)
    assert member.get("/api/usage/summary").json()["blocked_requests"] == 3  # only key a is assigned to them


def test_blocked_rows_never_fill_the_workspace_row_cap(world, monkeypatch):
    _admin, _member, (a, b) = world
    with SessionLocal() as db:
        real = db.query(UsageLog).count()
        vk = db.get(VirtualKey, a)
        monkeypatch.setattr(settings, "MAX_USAGE_ROWS_PER_WORKSPACE", real + 1)
        enforce_workspace_quota(db, vk)  # room for one more

    _seed_blocked(a, b, n=40)  # a flood of blocked requests

    with SessionLocal() as db:
        vk = db.get(VirtualKey, a)
        enforce_workspace_quota(db, vk)  # still no 429: blocked rows are not counted
        db.add(_row(a, "one-more", provider="openrouter", model="m-a"))
        db.add(_row(a, "and-one", provider="openrouter", model="m-a"))
        db.commit()
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as e:  # real rows still reach the cap
            enforce_workspace_quota(db, vk)
        assert e.value.status_code == 429 and e.value.detail["type"] == "quota_exceeded"


def test_blocked_rows_do_not_touch_budgets_or_unpriced_counts(world):
    admin, _member, (a, b) = world
    with SessionLocal() as db:
        spent_before = period_spend(db, db.get(VirtualKey, a))
    _seed_blocked(a, b)
    with SessionLocal() as db:
        assert period_spend(db, db.get(VirtualKey, a)) == spent_before
    # cost is a real 0.0 (never NULL), so a blocked row is not "no price yet"
    assert admin.get("/api/usage/summary").json()["unpriced_requests"] == 1


def test_requests_list_shows_blocked_rows_and_the_guardrail_field(world):
    admin, _member, (a, b) = world
    _seed_blocked(a, b, n=4)
    items = admin.get("/api/requests?limit=200").json()["items"]
    blocked = [i for i in items if i["status"] == "blocked"]
    assert len(blocked) == 4 and all(i["guardrail"] == "blocked" for i in blocked)
    assert all(i["guardrail"] is None for i in items if i["status"] != "blocked")  # ordinary rows: null
    only = admin.get("/api/requests?status=blocked").json()["items"]
    assert len(only) == 4 and all(i["cost"] == 0 and i["total_tokens"] == 0 for i in only)


def test_a_normal_gateway_request_still_writes_a_row_with_no_guardrail(admin_client, make_live_key, mock_provider):
    """PR1 adds no write path: a real request is recorded exactly as before, with guardrail NULL."""
    k = make_live_key(allowed_providers=["openai"])
    r = admin_client.post(
        "/v1/chat/completions", json={"model": "openai/gpt-4o-mini", "messages": [{"role": "user", "content": "hi"}]},
        headers={"Authorization": f"Bearer {k['key']}"},
    )
    assert r.status_code == 200, r.text
    row = admin_client.get("/api/requests").json()["items"][0]
    assert row["status"] == "success" and row["guardrail"] is None


def test_a_request_with_no_usage_has_zero_blocked(admin_client, make_key):
    make_key()
    assert admin_client.get("/api/usage/summary").json()["blocked_requests"] == 0
