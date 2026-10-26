# Future improvements

OpenAI image edits/variations, audio translations, duration/character rates in the model pricing
registry (Phase 3 continued, all documented limitations in [Architecture notes](architecture.md)) · Phase 4 reliability continued —
moving the circuit breaker/liveness cache (see [Reliability](architecture.md#reliability-connection-pooling-circuit-breaker-atomic-rate-limiting)) off process-local state now that the rate limiter
has shown the pattern, forwarding `Idempotency-Key` upstream to providers that honor it (the
deferred slice of the [idempotency work](architecture.md#idempotency-appidempotencypy)), deployment/drift monitoring, CI/CD actually running
in the repo, reliability/failure testing · Gemini built-in tools (code execution,
Search grounding) test coverage · per-model budgets · webhook/Slack alerts · usage-anomaly
detection · exact-match response cache · SSO / org hierarchy.
