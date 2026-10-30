"""Fake usage rows over 21 days for the UI audit (throwaway database only)."""
import datetime as dt
import os
import random
import sys

sys.path.insert(0, os.environ["UI_AUDIT_BACKEND"])
os.environ.setdefault("SECRET_KEY", "ui-audit-secret")
os.environ["REDIS_URL"] = ""
from sqlalchemy import select  # noqa: E402

from app.db import SessionLocal  # noqa: E402
from app.models import UsageLog, VirtualKey  # noqa: E402

random.seed(11)
# label -> (provider, [(model, input $/1M, output $/1M)], weight). None prices = a model with no price yet.
PLAN = {
    "prod-openai": ("openai", [("gpt-4o-mini", 0.15, 0.6), ("gpt-4.1", 2.0, 8.0)], 1.0),
    "sam-anthropic": ("anthropic", [("claude-sonnet-5-5", 3.0, 15.0), ("claude-haiku-4-5", 1.0, 5.0)], 0.8),
    "dhilip-gemini": ("gemini", [("gemini-3.8-flash", None, None)], 0.6),
    "dhilip-openrouter": ("openrouter", [("meta-llama/llama-3.3-70b-instruct", 0.13, 0.4)], 0.5),
    "support-bot": ("openai", [("gpt-4o-mini", 0.15, 0.6)], 1.4),
    "marketing-analytics-batch-eu-west": ("anthropic", [("claude-haiku-4-5", 1.0, 5.0)], 0.4),
    "old-key": ("openai", [("gpt-4o-mini", 0.15, 0.6)], 0.2),
    "mod-key": ("openai", [("omni-moderation-latest", 0.0, 0.0)], 0.3),
    "mixed-key": ("openai", [("gpt-4o-mini", 0.15, 0.6), ("future-model-x", None, None)], 0.3),
}
with SessionLocal() as db:
    n = 0
    for vk in db.scalars(select(VirtualKey)).all():
        plan = PLAN.get(vk.label)
        if not plan:
            continue
        prov, models, weight = plan
        for day in range(21):
            if random.random() < 0.3:
                continue
            for _ in range(max(1, int(random.randint(1, 9) * weight))):
                model, pi, po = random.choice(models)
                pt, ct = random.randint(80, 3000), random.randint(20, 1200)
                cost = None if pi is None else (pt * pi + ct * po) / 1e6
                n += 1
                u = UsageLog(key_id=vk.id, provider=prov, model=model, prompt_tokens=pt, completion_tokens=ct,
                             total_tokens=pt + ct, cost=cost, latency_ms=random.randint(250, 5200),
                             status="error" if random.random() < 0.07 else "success", request_id=f"uiaudit-{n}")
                db.add(u)
                db.flush()
                u.ts = dt.datetime.now(dt.UTC) - dt.timedelta(days=day, hours=random.randint(0, 20), minutes=random.randint(0, 59))
    db.commit()
    print("seeded", n, "usage rows")
