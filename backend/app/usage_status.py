"""The vocabulary of `usage_logs.status` and `usage_logs.guardrail`.

`status` is a free-form string column with no CHECK constraint. Today the gateway writes exactly two values for a
request that reached a provider: SUCCESS, or ERROR after a provider/transport failure. BLOCKED is reserved for a
request that was stopped *before* any provider call; nothing writes it yet, but every analytics query already
excludes it (`scoping.counted_usage`), so that adding the writer later cannot change request counts, error rates,
latency percentiles, caps or "last used".

`guardrail` is NULL for every ordinary row. A later change marks a row that matched a content rule.
"""

SUCCESS = "success"
ERROR = "error"
BLOCKED = "blocked"

GUARDRAIL_FLAGGED = "flagged"  # the request went through, but matched a flag rule
GUARDRAIL_BLOCKED = "blocked"  # the request was stopped before the provider call (status is BLOCKED too)
GUARDRAIL_UNCHECKED = "unchecked"  # the rules could not be fully evaluated (the request went through)
