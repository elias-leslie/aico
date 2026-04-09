#!/bin/bash
# Start A-Term services via systemd (User Mode)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export REPO_ROOT

PRODUCT_NAME="$(python3 - <<'PY'
import json
from pathlib import Path
import os

identity = json.loads((Path(os.environ["REPO_ROOT"]) / "project.identity.json").read_text())
print(identity["project"]["display_name"])
PY
)"

RUNTIME_ENV="$(python3 - <<'PY'
import json
from pathlib import Path
import os

identity = json.loads((Path(os.environ["REPO_ROOT"]) / "project.identity.json").read_text())
runtime = identity.get("runtime", {})
print(f'DEFAULT_BACKEND_PORT={runtime.get("backend_port", 8002)}')
print(f'DEFAULT_FRONTEND_PORT={runtime.get("frontend_port", 3002)}')
PY
)"
eval "$RUNTIME_ENV"

SERVICE_ENV="$(python3 - <<'PY'
import json
from pathlib import Path
import os

identity = json.loads((Path(os.environ["REPO_ROOT"]) / "project.identity.json").read_text())
services = identity.get("services", {})
print(f'BACKEND_SERVICE={services.get("backend", "a-term-backend.service")}')
print(f'FRONTEND_SERVICE={services.get("frontend", "a-term-frontend.service")}')
PY
)"
eval "$SERVICE_ENV"

FRONTEND_ENV="$(python3 - <<'PY'
import os
import shlex
from pathlib import Path

repo_root = Path(os.environ["REPO_ROOT"])
values = {
    "A_TERM_FRONTEND_HOST": "",
    "A_TERM_FRONTEND_PORT": "",
}

for path in (repo_root / ".env", repo_root / ".env.local"):
    if not path.exists():
        continue
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in raw_line:
            continue
        key, value = raw_line.split("=", 1)
        key = key.strip()
        if key not in values:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        values[key] = value

for key, default in (
    ("A_TERM_FRONTEND_HOST", "127.0.0.1"),
    ("A_TERM_FRONTEND_PORT", str(os.environ.get("DEFAULT_FRONTEND_PORT", "3002"))),
):
    value = os.environ.get(key, values.get(key) or default)
    print(f"{key}={shlex.quote(value)}")
PY
)"
eval "$FRONTEND_ENV"

FRONTEND_HOST="${A_TERM_FRONTEND_HOST}"
FRONTEND_PORT="${A_TERM_FRONTEND_PORT}"

echo "================================"
echo "Starting ${PRODUCT_NAME}"
echo "================================"
echo ""

echo "Starting managed PostgreSQL (if configured)..."
bash "$REPO_ROOT/scripts/managed-postgres.sh" start

echo "Starting ${PRODUCT_NAME} backend..."
systemctl --user start "$BACKEND_SERVICE"

echo "Starting ${PRODUCT_NAME} frontend..."
systemctl --user start "$FRONTEND_SERVICE"

echo "Waiting for services..."
sleep 3

echo ""
echo "Service Status:"
echo "  Backend:  $(systemctl --user is-active "$BACKEND_SERVICE" 2>/dev/null && echo 'Running' || echo 'Stopped')"
echo "  Frontend: $(systemctl --user is-active "$FRONTEND_SERVICE" 2>/dev/null && echo 'Running' || echo 'Stopped')"
echo ""
echo "URLs:"
echo "  Local: http://${FRONTEND_HOST}:${FRONTEND_PORT}"
echo ""
