#!/bin/bash
# Stop A-Term services via systemd (User Mode)
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
echo "Stopping ${PRODUCT_NAME}"
echo "================================"
echo ""

echo "Stopping ${PRODUCT_NAME} frontend..."
systemctl --user stop "$FRONTEND_SERVICE" || true

echo "Stopping ${PRODUCT_NAME} backend..."
systemctl --user stop "$BACKEND_SERVICE" || true

echo ""
echo "${PRODUCT_NAME} stopped."
echo ""
