# Deploy (Render + Neon)

One Docker web service (FastAPI serves the built SPA) + one managed Postgres. It runs on the
Render and Neon free tiers; the only catch is a ~30–60 s cold start after 15 min idle (Render)
and a ~300 ms cold DB wake (Neon).

## Steps

1. Create a **Neon** project → copy the connection string.
2. Push this repo to GitHub.
3. Render → **New → Blueprint** → select the repo. It reads `render.yaml` and creates the
   Docker web service with `ENVIRONMENT=production` and generated `SECRET_KEY` + `ENCRYPTION_KEY`
   (the app refuses to boot on the dev-default `SECRET_KEY` once `ENVIRONMENT` is deployed).
   Creating the service by hand instead? Set `ENVIRONMENT`, `SECRET_KEY`, `ENCRYPTION_KEY`
   yourself.
4. Set `DATABASE_URL` on the service to the Neon connection string, then deploy.
5. Open `https://<service>.onrender.com/healthz` → `{"status":"ok",...}`. **Sign up**, then
   create a workspace or join one with an invite code. There is no privileged super-admin —
   every account is scoped to its own workspace.

**All-Render fallback:** uncomment the `databases:` block in `render.yaml`. Note Render's free
Postgres is deleted 30 days after creation; the schema is recreated automatically but any keys
and usage you added are lost.

## Keeping it warm

```bash
curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" https://<service>.onrender.com/healthz
```

Or point an UptimeRobot / cron-job.org monitor at `/healthz` every 10 minutes.

## Deployment drift monitoring

Pushing `main` does **not** reliably auto-deploy this Render service, so "the code on `main`" and
"the code actually running" can silently diverge. Two pieces detect that:

**`GET /version`** (unauthenticated, like `/healthz`) reports the running deployment's identity:

```json
{ "version": "0.19.0", "commit": "732c12f…", "branch": "main" }
```

`version` is the hand-maintained release string. `commit`/`branch` are the exact deployed Git
identity, read from Render's runtime env (`RENDER_GIT_COMMIT` / `RENDER_GIT_BRANCH`, which Render
injects for Docker services too — no Dockerfile or `render.yaml` change needed). Off-Render (local,
docker-compose) both are `null` — a local SHA is never fabricated. The commit SHA is public (it's in
the repo), so nothing sensitive is exposed.

**`scripts/check_drift.py`** does a three-way comparison and exits non-zero on any mismatch:

```
expected  = origin/main HEAD            (git ls-remote)
deployed  = Render's live deploy commit (Render API)
running   = GET /version commit         (the live app)
```

```bash
# full check — needs a Render API key for the "deployed" layer
RENDER_API_KEY=rnd_… python scripts/check_drift.py

# subset checks (no API key): compare only what you can reach
python scripts/check_drift.py --skip-deployed          # expected vs running
python scripts/check_drift.py --skip-deployed --skip-running   # just resolve origin/main
python scripts/check_drift.py --self-test              # offline logic check
```

Stdlib only, no monitoring infrastructure. `RENDER_SERVICE_ID` / `APP_URL` / `GIT_REMOTE` /
`GIT_BRANCH` default to this project's values and can be overridden by env var or flag; the API key
is read from `RENDER_API_KEY` and never printed. (Scheduling this check and config-drift detection
are deliberately out of scope for now.)
