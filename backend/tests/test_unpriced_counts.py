"""A request with no cost (NULL: the model has no price) is counted apart from a free one (cost 0), so the UI can
say "no price yet" instead of showing a $0 that reads as "free"."""
import datetime as dt

from app.db import SessionLocal
from app.models import UsageLog


def _add(key_id: int, n: int, cost, provider="openrouter", *, tag: str) -> None:
    with SessionLocal() as db:
        for i in range(n):
            db.add(
                UsageLog(
                    key_id=key_id, request_id=f"{tag}-{i}", provider=provider, model="m",
                    prompt_tokens=1, completion_tokens=1, total_tokens=2, cost=cost,
                    latency_ms=1, status="success", ts=dt.datetime.now(dt.UTC),
                )
            )
        db.commit()


def test_unpriced_is_counted_apart_from_free_and_priced(admin_client, make_key):
    k = make_key()
    _add(k["id"], 2, 0.01, tag="priced")
    _add(k["id"], 3, 0, tag="free")  # a genuinely free request: a real 0, not a missing price
    _add(k["id"], 4, None, tag="unpriced")

    s = admin_client.get("/api/usage/summary").json()
    assert s["total_requests"] == 9 and s["unpriced_requests"] == 4

    row = admin_client.get("/api/usage/by-key").json()[0]
    assert row["requests"] == 9 and row["unpriced_requests"] == 4

    day = admin_client.get("/api/usage/timeseries").json()
    assert sum(p["unpriced_requests"] for p in day) == 4

    listed = next(x for x in admin_client.get("/api/keys").json() if x["id"] == k["id"])
    assert listed["requests"] == 9 and listed["unpriced_requests"] == 4


def test_a_key_whose_requests_are_all_priced_or_free_has_none_unpriced(admin_client, make_key):
    k = make_key()
    _add(k["id"], 2, 0.5, tag="p")
    _add(k["id"], 1, 0, tag="f")
    assert admin_client.get("/api/usage/by-key").json()[0]["unpriced_requests"] == 0
    assert admin_client.get("/api/usage/summary").json()["unpriced_requests"] == 0


def test_a_key_with_no_usage_lists_zero_unpriced(admin_client, make_key):
    k = make_key()
    listed = next(x for x in admin_client.get("/api/keys").json() if x["id"] == k["id"])
    assert listed["requests"] == 0 and listed["unpriced_requests"] == 0


def test_the_count_respects_the_key_filter(admin_client, make_key):
    a, b = make_key(), make_key()
    _add(a["id"], 2, None, tag="a")
    _add(b["id"], 5, None, tag="b")
    s = admin_client.get(f"/api/usage/summary?key_id={a['id']}").json()
    assert s["total_requests"] == 2 and s["unpriced_requests"] == 2
