"""Local app for the UI audit. Nothing here touches production or the repository's own files.

    python scripts/ui-audit/ui_audit_env.py up      build the frontend, copy the backend, start the app (fake providers)
    python scripts/ui-audit/ui_audit_env.py seed    sign up accounts, create keys, add fake usage and a few stored requests
    python scripts/ui-audit/ui_audit_env.py down    stop the app and drop the throwaway database

Run it with the backend's interpreter (it needs psycopg): ..\\backend\\.venv\\Scripts\\python on Windows.
It needs a local Postgres (docker compose up db). Everything lives in a temporary folder and a database called
llm_ui_audit; override with UI_AUDIT_PG_ADMIN (admin URL), UI_AUDIT_DB, UI_AUDIT_PORT.
"""
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
FRONTEND = HERE.parent.parent
BACKEND = FRONTEND.parent / "backend"
WORK = Path(tempfile.gettempdir()) / "llm-ui-audit"
PORT = os.environ.get("UI_AUDIT_PORT", "8765")
DB = os.environ.get("UI_AUDIT_DB", "llm_ui_audit")
ADMIN_URL = os.environ.get("UI_AUDIT_PG_ADMIN", "postgresql://llm:llm@localhost:5434/postgres")
APP_URL = f"postgresql+psycopg://{ADMIN_URL.split('://', 1)[1].rsplit('/', 1)[0]}/{DB}"
PIDFILE = WORK / "server.pid"


def _env(extra=None):
    env = dict(os.environ, DATABASE_URL=APP_URL, UI_AUDIT_BACKEND=str(WORK / "backend"), PORT=PORT, PYTHONDONTWRITEBYTECODE="1")
    env.update(extra or {})
    return env


def _recreate_db():
    import psycopg

    with psycopg.connect(ADMIN_URL, autocommit=True) as c:
        c.execute(f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)')
        c.execute(f'CREATE DATABASE "{DB}"')


def up():
    down(quiet=True)
    WORK.mkdir(parents=True, exist_ok=True)
    print("building the frontend (out of tree)...")
    subprocess.run(f'npx vite build --outDir "{WORK / "dist"}" --emptyOutDir', cwd=FRONTEND, shell=True, check=True, capture_output=True)
    target = WORK / "backend"
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(BACKEND, target, ignore=shutil.ignore_patterns(".venv", "tests", "__pycache__", ".pytest_cache", ".ruff_cache", "*.pyc", "static", ".env"))
    shutil.copytree(WORK / "dist", target / "app" / "static")
    _recreate_db()
    proc = subprocess.Popen([sys.executable, "-B", str(HERE / "local_server.py")], env=_env(), cwd=target,
                            stdout=open(WORK / "server.log", "w"), stderr=subprocess.STDOUT)
    PIDFILE.write_text(str(proc.pid))
    for _ in range(60):
        try:
            if urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2).status == 200:
                print(f"app up on http://127.0.0.1:{PORT} (database {DB}); log: {WORK / 'server.log'}")
                return
        except Exception:
            time.sleep(1)
    sys.exit("the app did not become healthy; see " + str(WORK / "server.log"))


def seed():
    node = shutil.which("node") or "node"
    subprocess.run([node, str(HERE / "seed.mjs"), str(HERE / "out" / "creds.json")], check=True, cwd=FRONTEND, env=_env())
    subprocess.run([sys.executable, "-B", str(HERE / "seed_usage.py")], check=True, env=_env())


def down(quiet=False):
    if PIDFILE.exists():
        try:
            pid = int(PIDFILE.read_text())
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
            else:
                os.kill(pid, signal.SIGTERM)
        except Exception:
            pass
        PIDFILE.unlink(missing_ok=True)
    try:
        import psycopg

        with psycopg.connect(ADMIN_URL, autocommit=True) as c:
            c.execute(f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)')
    except Exception as e:  # database not running: nothing to drop
        if not quiet:
            print("could not drop the database:", e)
    if WORK.exists() and not quiet:
        shutil.rmtree(WORK, ignore_errors=True)
    if not quiet:
        print("stopped; temporary files and database removed")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    {"up": up, "seed": seed, "down": down}.get(cmd, lambda: sys.exit(__doc__))()
