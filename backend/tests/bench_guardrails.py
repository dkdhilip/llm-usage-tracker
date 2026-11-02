"""Guardrail evaluation benchmark (engine CPU only: extraction + matching, no database).

    python -m tests.bench_guardrails [--iters 300] [--quick]

Reports p50/p95/p99 in ms for prompt size x rule count x text shape. The engine has a hard 100 ms budget and a 1 MB
scan cap; this is the evidence for enabling GUARDRAILS_ENABLED. Not collected by pytest."""
import argparse
import random
import statistics
import string
import time

import regex as rx

from app import guardrails as g
from app.config import settings
from app.models import GuardrailRule

WORDS = ["alpha", "beta", "gamma", "delta", "report", "customer", "invoice", "meeting", "project", "update", "the", "and"]


def make_rules(n: int) -> list:
    rules = []
    for i in range(n):
        kind = ("phrase", "phrase", "regex", "preset")[i % 4]
        pat = {"phrase": f"secretword{i}", "regex": rf"codename-{i}-\d+", "preset": ("card", "email", "api_key")[i % 3]}[kind]
        row = GuardrailRule(id=i + 1, name=f"r{i}", kind=kind, pattern=None if kind == "preset" else pat,
                            preset_id=pat if kind == "preset" else None, action="block" if i % 3 == 0 else "flag")
        rules.append(g.compile_rule(row, "Bench"))
    return rules


def text_of(size: int, shape: str, rnd: random.Random) -> str:
    if shape == "ascii-clean":
        out = " ".join(rnd.choice(WORDS) for _ in range(size // 6))
    elif shape == "ascii-hit":
        out = " ".join(rnd.choice(WORDS) for _ in range(size // 6))
        out = out[: size // 2] + " secretword0 " + out[size // 2:]
    elif shape == "non-ascii":
        out = " ".join(rnd.choice(WORDS + ["Straße", "ｆｕｌｌ", "café", "한국어", "שלום", "😀"]) for _ in range(size // 6))
    else:  # adversarial: long runs a naive regex would choke on
        out = ("a" * 50 + " ") * (size // 51)
    return out[:size]


def _q(xs: list[float], p: float) -> float:
    return xs[min(len(xs) - 1, int(len(xs) * p))]


def run(iters: int, quick: bool) -> None:
    rnd = random.Random(1)
    sizes = [2_000, 50_000] if quick else [2_000, 50_000, 500_000, 1_000_000]
    counts = [0, 5, 50, 100]
    shapes = ["ascii-clean", "ascii-hit", "non-ascii", "adversarial"]
    cal = time.perf_counter()
    sum(i * i for i in range(2_000_000))
    print(f"calibration loop: {(time.perf_counter() - cal) * 1000:.0f} ms (scale results by your host's ratio)")
    print(f"budget {settings.GUARDRAIL_EVAL_BUDGET_MS} ms, regex timeout {settings.GUARDRAIL_REGEX_TIMEOUT_MS} ms, scan cap {settings.GUARDRAIL_SCAN_CAP_CHARS}")
    print(f"{'size':>9} {'rules':>5} {'shape':<12} {'p50':>8} {'p95':>8} {'p99':>8} {'max':>8}  unchecked")
    for size in sizes:
        for n in counts:
            rules = make_rules(n)
            for shape in shapes:
                body = {"messages": [{"role": "user", "content": text_of(size, shape, rnd)}]}
                it = max(20, iters // (1 + size // 100_000))
                xs, unchecked = [], 0
                for k in range(it + 5):
                    t = time.perf_counter()
                    segs, over = g.extract_segments(body)
                    d = g.evaluate(segs, rules, oversize=over)
                    dt_ms = (time.perf_counter() - t) * 1000
                    if k >= 5:
                        xs.append(dt_ms)
                        unchecked += d.unchecked
                xs.sort()
                print(f"{size:>9} {n:>5} {shape:<12} {statistics.median(xs):8.2f} {_q(xs, 0.95):8.2f} {_q(xs, 0.99):8.2f} {xs[-1]:8.2f}  {unchecked}/{len(xs)}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--iters", type=int, default=300)
    ap.add_argument("--quick", action="store_true")
    a = ap.parse_args()
    _ = (rx, string)
    run(a.iters, a.quick)
