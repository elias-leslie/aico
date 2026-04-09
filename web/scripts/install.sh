#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export REPO_ROOT
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

usage() {
  cat <<'EOF'
Usage: bash scripts/install.sh [--no-start]

Bootstraps A-Term for a native Linux install:
  - prepares .env.local when missing
  - bootstraps a local PostgreSQL Docker container when DATABASE_URL is unset
  - bootstraps uv and Python 3.13 when needed
  - validates tmux and links the repo tmux config
  - installs Python and frontend dependencies
  - runs database migrations
  - builds the production frontend
  - installs user-level systemd units
  - optionally starts the services and verifies health
EOF
}

NO_START=0
for arg in "$@"; do
  case "$arg" in
    --no-start)
      NO_START=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

ensure_uv() {
  if command -v uv >/dev/null 2>&1; then
    return
  fi

  step "Installing uv"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

  if ! command -v uv >/dev/null 2>&1; then
    fail "uv installation completed, but uv is still not on PATH."
  fi
}

step() {
  printf '\n==> %s\n' "$1"
}

fail() {
  echo "Install failed: $1" >&2
  exit 1
}

update_env_value() {
  local file_path="$1"
  local key="$2"
  local value="$3"

  python3 - "$file_path" "$key" "$value" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]

lines = path.read_text().splitlines() if path.exists() else []
prefix = f"{key}="
updated = False
next_lines: list[str] = []

for line in lines:
    if line.startswith(prefix):
        next_lines.append(f"{key}={value}")
        updated = True
        continue
    next_lines.append(line)

if not updated:
    if next_lines and next_lines[-1] != "":
        next_lines.append("")
    next_lines.append(f"{key}={value}")

path.write_text("\n".join(next_lines) + "\n")
PY
}

find_available_local_port() {
  python3 - "$@" <<'PY'
import socket
import sys

for raw_port in sys.argv[1:]:
    port = int(raw_port)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            continue
        print(port)
        raise SystemExit(0)

raise SystemExit("Install failed: no free local PostgreSQL port was available for bootstrap.")
PY
}

wait_for_postgres_container() {
  local container_name="$1"
  local db_user="$2"
  local db_name="$3"
  local attempts="${4:-45}"

  for ((i = 1; i <= attempts; i += 1)); do
    if docker exec "$container_name" pg_isready -U "$db_user" -d "$db_name" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  fail "PostgreSQL container ${container_name} did not become ready."
}

bootstrap_local_postgres() {
  local env_file="$1"
  local container_name="$2"
  local postgres_db="a-term"
  local postgres_user="a-term"
  local postgres_password="a-term"
  local host_port=""

  if ! command -v docker >/dev/null 2>&1; then
    fail "DATABASE_URL is unset and docker is not installed. Install Docker for the supported one-shot bootstrap path, or set DATABASE_URL to an existing PostgreSQL instance in .env.local."
  fi

  if docker container inspect "$container_name" >/dev/null 2>&1; then
    step "Reusing local PostgreSQL container"
    docker start "$container_name" >/dev/null 2>&1 || true
    host_port="$(
      docker inspect \
        -f '{{range (index .NetworkSettings.Ports "5432/tcp")}}{{.HostPort}}{{end}}' \
        "$container_name"
    )"
    if [[ -z "$host_port" ]]; then
      fail "Existing PostgreSQL container ${container_name} does not expose port 5432."
    fi
  else
    step "Bootstrapping local PostgreSQL with Docker"
    host_port="$(find_available_local_port 5432 55432 56432)"
    docker run \
      -d \
      --name "$container_name" \
      --restart unless-stopped \
      -e POSTGRES_DB="$postgres_db" \
      -e POSTGRES_USER="$postgres_user" \
      -e POSTGRES_PASSWORD="$postgres_password" \
      -p "${host_port}:5432" \
      postgres:16 >/dev/null
  fi

  wait_for_postgres_container "$container_name" "$postgres_user" "$postgres_db"

  DATABASE_URL="postgresql://${postgres_user}:${postgres_password}@127.0.0.1:${host_port}/${postgres_db}"
  update_env_value "$env_file" "DATABASE_URL" "$DATABASE_URL"
  update_env_value "$env_file" "A_TERM_INSTALL_MANAGED_POSTGRES" "true"
  update_env_value "$env_file" "A_TERM_POSTGRES_CONTAINER_NAME" "$container_name"
  export DATABASE_URL

  echo "Configured local PostgreSQL at ${DATABASE_URL}"
}

ensure_port_available() {
  local host="$1"
  local port="$2"
  local label="$3"
  local env_var="$4"

  python3 - "$host" "$port" "$label" "$env_var" <<'PY'
import socket
import sys

host = sys.argv[1]
port = int(sys.argv[2])
label = sys.argv[3]
env_var = sys.argv[4]

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((host, port))
    except OSError as exc:
        raise SystemExit(
            f"Install failed: {label} port {port} on {host} is already in use. "
            f"Set {env_var} in .env.local and rerun the installer. ({exc})"
        )
PY
}

require_command python3
require_command curl
require_command node
require_command corepack
require_command tmux
require_command systemctl
ensure_uv

eval "$(
  python3 - <<'PY'
import json
import os
from pathlib import Path

identity = json.loads((Path(os.environ["REPO_ROOT"]) / "project.identity.json").read_text())
project = identity.get("project", {})
runtime = identity.get("runtime", {})
services = identity.get("services", {})
print(f'PRODUCT_NAME={project.get("display_name", "A-Term")!r}')
print(f'BACKEND_PORT_DEFAULT={runtime.get("backend_port", 8002)!r}')
print(f'FRONTEND_PORT_DEFAULT={runtime.get("frontend_port", 3002)!r}')
print(f'BACKEND_SERVICE={services.get("backend", "a-term-backend.service")!r}')
print(f'FRONTEND_SERVICE={services.get("frontend", "a-term-frontend.service")!r}')
PY
)"

cd "$REPO_ROOT"
ENV_FILE="$REPO_ROOT/.env.local"
DATABASE_URL_PLACEHOLDER="postgresql://USER:PASSWORD@localhost:5432/a-term"
DEFAULT_POSTGRES_CONTAINER_NAME="a-term-postgres"

if [[ ! -f "$ENV_FILE" ]]; then
  step "Creating .env.local"
  cp "$REPO_ROOT/.env.example" "$ENV_FILE"
fi

eval "$(
  python3 - <<'PY'
import os
import shlex
from pathlib import Path

repo_root = Path(os.environ["REPO_ROOT"])
keys = [
    "DATABASE_URL",
    "A_TERM_PORT",
    "A_TERM_BIND_HOST",
    "A_TERM_FRONTEND_PORT",
    "A_TERM_FRONTEND_HOST",
    "A_TERM_INSTALL_MANAGED_POSTGRES",
    "A_TERM_POSTGRES_CONTAINER_NAME",
]
values: dict[str, str] = {}

for path in (repo_root / ".env", repo_root / ".env.local"):
    if not path.exists():
        continue
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in raw_line:
            continue
        key, value = raw_line.split("=", 1)
        key = key.strip()
        if key not in keys:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        values[key] = value

for key in keys:
    value = os.environ.get(key, values.get(key, ""))
    print(f"{key}={shlex.quote(value)}")
PY
)"

POSTGRES_CONTAINER_NAME="${A_TERM_POSTGRES_CONTAINER_NAME:-$DEFAULT_POSTGRES_CONTAINER_NAME}"

if [[ -z "${DATABASE_URL:-}" || "${DATABASE_URL}" == "$DATABASE_URL_PLACEHOLDER" ]]; then
  bootstrap_local_postgres "$ENV_FILE" "$POSTGRES_CONTAINER_NAME"
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  fail "DATABASE_URL is required. Leave the placeholder to let the installer bootstrap Docker PostgreSQL automatically, or set your own PostgreSQL URL in .env.local."
fi

BACKEND_PORT="${A_TERM_PORT:-$BACKEND_PORT_DEFAULT}"
BACKEND_HOST="${A_TERM_BIND_HOST:-127.0.0.1}"
FRONTEND_PORT="${A_TERM_FRONTEND_PORT:-$FRONTEND_PORT_DEFAULT}"
FRONTEND_HOST="${A_TERM_FRONTEND_HOST:-127.0.0.1}"
PYTHON_VERSION="3.13"

step "Validating tmux"
bash "$REPO_ROOT/scripts/install-local-tmux.sh"

step "Installing Python ${PYTHON_VERSION}"
uv python install "$PYTHON_VERSION"

step "Installing Python dependencies"
uv sync --dev --managed-python --python "$PYTHON_VERSION"

step "Running database migrations"
uv run --managed-python --python "$PYTHON_VERSION" alembic upgrade head

step "Installing frontend dependencies"
corepack pnpm --dir "$REPO_ROOT/frontend" install --frozen-lockfile

step "Building frontend"
corepack pnpm --dir "$REPO_ROOT/frontend" build

step "Installing systemd user units"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$SYSTEMD_USER_DIR"

render_service() {
  local template_path="$1"
  local destination_path="$2"
  python3 - "$template_path" "$destination_path" "$REPO_ROOT" <<'PY'
from pathlib import Path
import sys

template_path = Path(sys.argv[1])
destination_path = Path(sys.argv[2])
project_root = sys.argv[3]
text = template_path.read_text()
destination_path.write_text(text.replace("__PROJECT_ROOT__", project_root))
PY
}

render_service \
  "$REPO_ROOT/scripts/systemd/$BACKEND_SERVICE" \
  "$SYSTEMD_USER_DIR/$BACKEND_SERVICE"
render_service \
  "$REPO_ROOT/scripts/systemd/$FRONTEND_SERVICE" \
  "$SYSTEMD_USER_DIR/$FRONTEND_SERVICE"

step "Checking ports"
systemctl --user stop "$BACKEND_SERVICE" "$FRONTEND_SERVICE" >/dev/null 2>&1 || true
sleep 1
ensure_port_available "$BACKEND_HOST" "$BACKEND_PORT" "Backend" "A_TERM_PORT"
ensure_port_available "$FRONTEND_HOST" "$FRONTEND_PORT" "Frontend" "A_TERM_FRONTEND_PORT"

systemctl --user daemon-reload
systemctl --user enable "$BACKEND_SERVICE" "$FRONTEND_SERVICE" >/dev/null

if [[ "$NO_START" -eq 1 ]]; then
  step "Bootstrap complete"
  echo "Units installed. Start A-Term with:"
  echo "  bash scripts/start.sh"
  exit 0
fi

step "Starting services"
systemctl --user restart "$BACKEND_SERVICE"
systemctl --user restart "$FRONTEND_SERVICE"

wait_for_url() {
  local url="$1"
  local label="$2"
  local attempts="${3:-45}"

  for ((i = 1; i <= attempts; i += 1)); do
    if curl --silent --show-error --fail "$url" >/dev/null; then
      return 0
    fi
    sleep 1
  done

  fail "$label did not become healthy at $url"
}

step "Verifying runtime"
wait_for_url "http://${BACKEND_HOST}:${BACKEND_PORT}/health" "backend"
wait_for_url "http://${FRONTEND_HOST}:${FRONTEND_PORT}" "frontend"

echo
echo "${PRODUCT_NAME} is ready."
echo "  Frontend: http://${FRONTEND_HOST}:${FRONTEND_PORT}"
echo "  Backend:  http://${BACKEND_HOST}:${BACKEND_PORT}/health"
