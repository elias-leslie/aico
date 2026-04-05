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

SERVICE_ENV="$(python3 - <<'PY'
import json
from pathlib import Path
import os

identity = json.loads((Path(os.environ["REPO_ROOT"]) / "project.identity.json").read_text())
services = identity.get("services", {})
print(f'BACKEND_SERVICE={services.get("backend", "aterm-backend.service")}')
print(f'FRONTEND_SERVICE={services.get("frontend", "aterm-frontend.service")}')
PY
)"
eval "$SERVICE_ENV"

echo "================================"
echo "Starting ${PRODUCT_NAME}"
echo "================================"
echo ""

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
echo "  Local: http://localhost:3002"
echo ""
