# UI audit harness

A regression gate for the interface: overflow, accessibility (axe, WCAG 2.2 AA tags), target size, unnamed controls, keyboard and dialog behaviour, loading/error states, reduced motion and reflow, across pages, widths and light/dark.

It runs a **throwaway copy** of the app with every provider mocked (no network, no real keys) on a database called `llm_ui_audit`. It never touches production, and it writes nothing into the repository except `scripts/ui-audit/out/` (ignored).

## Run it

Needs a local Postgres (`docker compose up -d db`) and Chrome. From `frontend/`:

```bash
../backend/.venv/Scripts/python scripts/ui-audit/ui_audit_env.py up     # build out of tree, copy the backend, start the app on :8765
../backend/.venv/Scripts/python scripts/ui-audit/ui_audit_env.py seed   # fake accounts, workspace, keys, usage, a few stored requests
npm run ui-audit                  # 5 widths x pages x themes + interaction checks (a few minutes); `ui-audit:quick` = 1440 and 390 only
node scripts/ui-audit/check.mjs --shots                                  # also save full-page screenshots to out/shots
../backend/.venv/Scripts/python scripts/ui-audit/ui_audit_env.py down   # stop the app, drop the database, remove temp files
```

Overrides: `UI_AUDIT_PG_ADMIN` (admin DB URL, default `postgresql://llm:llm@localhost:5434/postgres`), `UI_AUDIT_DB`, `UI_AUDIT_PORT`, `UI_AUDIT_BROWSER` (Playwright channel, default `chrome`).

## The gate

`thresholds.json` holds the limits. The run exits 1 if any is exceeded. The values are the baseline measured on `main` at `5d6b6d0`; **tighten them as the UI improves, never loosen them**. `requiredChecks` lists interaction checks that must pass; add a check there once the behaviour it tests is fixed.

Accounts created by `seed`: `auditadmin` (workspace admin), `samuel` (team member), `emptyadmin` (empty workspace), `newcomer` (no workspace); the password is in `out/creds.json`.
