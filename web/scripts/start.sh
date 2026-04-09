#!/bin/bash
# Start A-Term services via systemd (User Mode)

set -e
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

if [[ -f "$REPO_ROOT/.env.local" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$REPO_ROOT/.env.local"
  set +a
fi

FRONTEND_HOST="${A_TERM_FRONTEND_HOST:-127.0.0.1}"
FRONTEND_PORT="${A_TERM_FRONTEND_PORT:-$DEFAULT_FRONTEND_PORT}"
MANAGED_POSTGRES="${A_TERM_INSTALL_MANAGED_POSTGRES:-false}"
POSTGRES_CONTAINER_NAME="${A_TERM_POSTGRES_CONTAINER_NAME:-a-term-postgres}"

echo "================================"
echo "Starting ${PRODUCT_NAME}"
echo "================================"
echo ""

if [[ "$MANAGED_POSTGRES" == "true" ]] && command -v docker >/dev/null 2>&1; then
  echo "Starting managed PostgreSQL container..."
  docker start "$POSTGRES_CONTAINER_NAME" >/dev/null 2>&1 || true
fi

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
