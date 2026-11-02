# Guardrails (content rules on virtual keys)

> Status: the engine, gateway wiring, admin API and the whole UI (Guardrails tab, notification bell, Requests rows and
> inspector) are in place but **off** (`GUARDRAILS_ENABLED=false`). Rules can be created and attached while the flag is off
> (the UI says plainly that nothing is enforced yet).

## Where it is in the UI

Workspace > **Guardrails** (`?tab=guardrails`): rule sets with their rules (Flag/Block shown as text), add/edit rule
drawer with a **Try it** box (runs the real engine on typed text, stores nothing; a rule that is invalid or could stall
requests is refused with the reason), enable/disable, delete with confirmation, and an Activity list. The first rule in a
workspace asks for a one-time acknowledgement that admins will be able to read short redacted fragments of matching
requests. Keys: the create-key drawer has an optional "Content rules" section, a key's "⋯" menu has **Content rules**
(tick the sets; saved immediately), and a key with sets shows "Rules: <set>" under its name.

An admin attaches rule sets (words, patterns, built-in detectors) to a virtual key. For every gateway request on that
key the request text is checked. A matching **block** rule stops the request with `403` before any provider call; a
matching **flag** rule lets it through and marks it. This is a **policy aid, not a security boundary**: word and
pattern matching can be bypassed by misspelling, other languages or encodings.

## Where it runs

```
auth -> parse/ACL -> idempotency.begin (read-only) -> quota -> budget -> workspace cap -> live-ready
     -> GUARD -> idempotency claim -> content capture -> provider call -> usage row (+ flag hits)
```

All 12 gateway handlers (17 request shapes incl. streaming variants) call `enforce_guardrails` after governance and
before anything is claimed, captured or sent (a test parses each handler and fails if the order drifts). Consequences:

- a block leaves **no** idempotency record, no captured content and no provider call; a streaming request that is
  blocked gets a plain JSON `403`, never an SSE error;
- an idempotent **replay is never re-evaluated** (the stored response is returned; rule changes apply to new
  executions only); a blocked request retried with the same key is evaluated again;
- a key with no rule sets (`virtual_keys.has_guardrails = false`) costs **zero** extra queries; a key with sets costs
  one primary-key read of `workspaces.guardrail_version`.

## Decision

`evaluate()` is pure CPU (no database, no ceiling). All rules run, block rules first; any block hit blocks; flag hits
never undo a block. One hit per (request, rule), at most 20. Phrase rules and presets match on normalised text (NFKC,
case-folded, zero-width characters removed), regex rules on the original text with the admin's own flags.

The client sees `{"message": "This request was blocked by your workspace's content rules.", "type": "guardrail_blocked", "code": "403"}`
and never which rule matched.

## Failing open, and what is logged

If evaluation itself fails (engine error, time budget, oversize input, a regex timeout, a stored rule that cannot be
compiled) the request goes through, its usage row is marked `guardrail = 'unchecked'`, and a throttled line
`guardrail_skipped reason=... workspace=... key=... kind=... exc=<Class> suppressed=n` is logged. A block already found
still blocks. Logs and audit events contain ids, enum reasons and exception **class names only**: never the prompt, the
matched text, a pattern or `str(exc)`.

## Evidence

A blocked request writes one usage row (`status='blocked'`, real provider/model, 0 tokens, cost 0) plus its hits in one
transaction with the recording counter (`statement_timeout 2s`, `lock_timeout 1s`, single attempt). If that fails, the
request is **still blocked**; the failure is counted and logged, and becomes a persistent `audit_events` row
`guardrail.evidence_gap` after the next successful write. A flagged request writes its hits in a savepoint inside its
normal usage row's transaction.

The matched text is never stored. The snippet is up to 20 characters of context each side with the match replaced by
`[matched]`, redacted (`content_capture.redact`, long digit runs and long tokens masked), at most 120 characters and
encrypted. It is omitted whenever it cannot be built reliably (offsets are verified by re-normalising the mapped span),
for secret/PII presets, and when the matched text appears in its own context.

**Recording ceiling**: `GUARDRAIL_RECORDING_CEILING_PER_HOUR` (1000) evidence records per workspace per clock hour, one
atomic upsert, exact under any concurrency. Past it, blocking continues and, after the first refusal, a process does no
database work for evidence until the hour ends.

**Retention**: after `GUARDRAIL_RETENTION_DAYS` (30) the whole hit row (snippet included) and blocked usage rows are
deleted (at startup and at most hourly afterwards). A flagged request's ordinary usage row stays. `CONTENT_RETENTION_DAYS`
is not involved.

### Notifications and Requests

- **Bell** (header, workspace admins): the number is the unread matches (`aria-label` "Notifications, N unread", shown as
  99+ above 99). It is read once, every minute while the page is visible and when the window regains focus; a failed read
  keeps the last number. Opening it lists matches grouped by key and rule (action and counts as text), links each group to
  the matching Requests, and offers **Mark reviewed** per group or **Mark all reviewed**, which only covers what the list
  showed (a match that arrives meanwhile stays unread). Read state is workspace-wide.
- **Requests**: rows a rule blocked or flagged are tinted red and say why in words ("Blocked" + "Rule: x", "Flagged: x");
  "Not fully checked" (fail-open) is a neutral badge, not an alarm. A **Content rules** filter (`?guardrail=`) and an
  inspector section (what happened, each matching rule, the redacted context, retention) complete it.

## Limits (`config.py`)

Pattern 200 characters; 50 rules per set, 5 sets per key, 100 enabled rules per key, 20 sets per workspace; 1 MB scan
cap; 100 ms evaluation budget; 10 ms per regex match. Regexes use the `regex` module so a catastrophic pattern times out
instead of hanging. Text scanned: message/prompt/system/instructions text of every role, tool arguments and results,
embedding input, image prompts, speech input, the transcription `prompt`. Not scanned: image or audio bytes and base64.

## Performance

`python -m tests.bench_guardrails` prints p50/p95/p99 for prompt size x rule count x text shape (engine only). On the
development machine, typical requests (2 KB, up to 100 rules) take under 3 ms (p99); 50 KB with 100 rules about 14-28 ms;
at 500 KB-1 MB with 50-100 rules, or non-ASCII text above ~250 KB, the budget is reached, the result is `unchecked` and
the request is not slowed past about 110 ms. Enabling in production is gated on re-running this on the target host.

## Rollback

All schema changes are additive. With the flag off nothing is read or written. If code is rolled back past PR1 while
blocked rows exist, old analytics would count them: delete them first (`DELETE FROM usage_logs WHERE status = 'blocked'`).

## Admin API semantics

- Every write (rule, rule set, attachment) bumps `workspaces.guardrail_version` **in the same transaction**, so the gateway
  applies it to the very next request in any worker. `virtual_keys.has_guardrails` is kept in step (also when a set is
  deleted).
- Every write also adds an `audit_events` row (actor, action, target, ids/names/counts; rule patterns are admin
  configuration and are included, request text never is): `ruleset.create|update|enable|disable|delete`,
  `rule.create|update|delete`, `key.guardrails.attach|detach`, `hits.review`.
- A hit is the notification. Read state is workspace-wide. `POST /hits/review` takes `up_to_id`, so hits that arrived after
  a list was loaded stay unread. Reading snippets is logged as user + count, never content.
- Limits are enforced when saving (pattern length, rules per set, sets per workspace and key, active rules per key) as well
  as when evaluating.
