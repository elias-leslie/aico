#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export REPO_ROOT
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

usage() {
  cat <<'EOF'
Usage: bash scripts/install.sh [--no-start] [--skip-systemd]

Bootstraps A-Term for a native Linux install:
  - prepares .env.local when missing
  - bootstraps Node.js 22, corepack, uv, and Python 3.13 when needed
  - installs tmux automatically when it is missing
  - bootstraps managed PostgreSQL automatically when DATABASE_URL is unset
  - installs Python and frontend dependencies
  - runs database migrations
  - builds the production frontend
  - installs user-level systemd units
  - optionally starts the services and verifies health

Verification / CI support:
  --skip-systemd  Skip user-level systemd unit installation and service startup.
                  Useful for install smoke runs on hosts without a user systemd session.
EOF
}

NO_START=0
SKIP_SYSTEMD=0
for arg in "$@"; do
  case "$arg" in
    --no-start)
      NO_START=1
      ;;
    --skip-systemd)
      SKIP_SYSTEMD=1
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

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

docker_available() {
  command_exists docker && docker info >/dev/null 2>&1
}

require_command() {
  command_exists "$1" || fail "Missing required command: $1"
}

ensure_uv() {
  if command_exists uv; then
    return
  fi
  step "Installing uv"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  if ! command_exists uv; then
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

run_as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
    return
  fi
  command_exists sudo || fail "sudo is required to install missing system packages automatically."
  sudo "$@"
}

detect_package_manager() {
  if command_exists apt-get; then
    printf 'apt-get\n'
    return
  fi
  if command_exists dnf; then
    printf 'dnf\n'
    return
  fi
  if command_exists pacman; then
    printf 'pacman\n'
    return
  fi

  fail "Automatic package installation supports apt-get, dnf, and pacman right now."
}

install_system_role() {
  local role="$1"
  local manager=""
  local packages=()

  manager="$(detect_package_manager)"
  case "${manager}:${role}" in
    apt-get:tmux)
      packages=(tmux)
      ;;
    apt-get:postgresql_server)
      packages=(postgresql)
      ;;
    dnf:tmux)
      packages=(tmux)
      ;;
    dnf:postgresql_server)
      packages=(postgresql-server)
      ;;
    pacman:tmux)
      packages=(tmux)
      ;;
    pacman:postgresql_server)
      packages=(postgresql)
      ;;
    *)
      fail "Unsupported package role: ${role}"
      ;;
  esac

  step "Installing ${role//_/ }"
  case "$manager" in
    apt-get)
      run_as_root apt-get update
      run_as_root apt-get install -y "${packages[@]}"
      ;;
    dnf)
      run_as_root dnf install -y "${packages[@]}"
      ;;
    pacman)
      run_as_root pacman -Sy --noconfirm "${packages[@]}"
      ;;
  esac
}

node_major_version() {
  node -p 'process.versions.node.split(".")[0]'
}

ensure_corepack() {
  command_exists corepack || fail "corepack is not available after Node.js bootstrap."
  corepack enable --install-directory "$HOME/.local/bin" >/dev/null 2>&1 || true
}

ensure_node_runtime() {
  local node_version="${A_TERM_NODE_VERSION:-v22.21.1}"
  local install_root="$HOME/.local/share/a-term/node"
  local arch=""
  local install_dir=""
  local archive_path=""
  local download_url=""

  if command_exists node && command_exists corepack && [[ "$(node_major_version)" -ge 20 ]]; then
    ensure_corepack
    return
  fi

  [[ "$(uname -s)" == "Linux" ]] || fail "Automatic Node.js bootstrap currently supports Linux only."

  case "$(uname -m)" in
    x86_64)
      arch="x64"
      ;;
    aarch64|arm64)
      arch="arm64"
      ;;
    *)
      fail "Unsupported CPU architecture for automatic Node.js bootstrap: $(uname -m)"
      ;;
  esac

  install_dir="${install_root}/node-${node_version}-linux-${arch}"
  if [[ ! -x "${install_dir}/bin/node" ]]; then
    step "Installing Node.js ${node_version}"
    archive_path="$(mktemp)"
    download_url="https://nodejs.org/dist/${node_version}/node-${node_version}-linux-${arch}.tar.xz"
    curl -fsSL "$download_url" -o "$archive_path"
    mkdir -p "$install_root"
    tar -xJf "$archive_path" -C "$install_root"
    rm -f "$archive_path"
  fi

  mkdir -p "$HOME/.local/bin"
  ln -sfn "${install_dir}/bin/node" "$HOME/.local/bin/node"
  ln -sfn "${install_dir}/bin/npm" "$HOME/.local/bin/npm"
  ln -sfn "${install_dir}/bin/npx" "$HOME/.local/bin/npx"
  ln -sfn "${install_dir}/bin/corepack" "$HOME/.local/bin/corepack"
  hash -r
  ensure_corepack

  if ! command_exists node || [[ "$(node_major_version)" -lt 20 ]]; then
    fail "Node.js bootstrap completed, but node 20+ is still not available."
  fi
}

ensure_tmux_available() {
  if command_exists tmux; then
    return
  fi

  install_system_role tmux
  command_exists tmux || fail "tmux installation completed, but tmux is still not on PATH."
}

bootstrap_managed_postgres() {
  local bootstrap_mode="auto"

  if ! docker_available; then
    if ! bash "$REPO_ROOT/scripts/managed-postgres.sh" local-tools-ready; then
      install_system_role postgresql_server
    fi
    bootstrap_mode="local"
  fi

  step "Bootstrapping managed PostgreSQL (${bootstrap_mode})"
  eval "$(
    bash "$REPO_ROOT/scripts/managed-postgres.sh" bootstrap "$bootstrap_mode"
  )"

  update_env_value "$ENV_FILE" "DATABASE_URL" "$DATABASE_URL"
  update_env_value "$ENV_FILE" "A_TERM_MANAGED_POSTGRES_MODE" "$A_TERM_MANAGED_POSTGRES_MODE"
  update_env_value "$ENV_FILE" "A_TERM_POSTGRES_CONTAINER_NAME" "${A_TERM_POSTGRES_CONTAINER_NAME:-}"
  update_env_value "$ENV_FILE" "A_TERM_POSTGRES_DATA_DIR" "${A_TERM_POSTGRES_DATA_DIR:-}"
  update_env_value "$ENV_FILE" "A_TERM_POSTGRES_PORT" "${A_TERM_POSTGRES_PORT:-}"
  export DATABASE_URL

  echo "Configured managed PostgreSQL at ${DATABASE_URL} (${A_TERM_MANAGED_POSTGRES_MODE})"
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
if [[ "$SKIP_SYSTEMD" -eq 0 ]]; then
  require_command systemctl
fi
ensure_node_runtime
ensure_uv
ensure_tmux_available

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
    "A_TERM_MANAGED_POSTGRES_MODE",
    "A_TERM_POSTGRES_DATA_DIR",
    "A_TERM_POSTGRES_PORT",
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

if [[ -z "${DATABASE_URL:-}" || "${DATABASE_URL}" == "$DATABASE_URL_PLACEHOLDER" ]]; then
  bootstrap_managed_postgres
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  fail "DATABASE_URL is required. Leave the placeholder to let the installer bootstrap managed PostgreSQL automatically, or set your own PostgreSQL URL in .env.local."
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
uv sync --extra dev --managed-python --python "$PYTHON_VERSION"

step "Running database migrations"
uv run --managed-python --python "$PYTHON_VERSION" alembic upgrade head

step "Installing frontend dependencies"
corepack pnpm --dir "$REPO_ROOT/frontend" install --frozen-lockfile

step "Building frontend"
corepack pnpm --dir "$REPO_ROOT/frontend" build

if [[ "$SKIP_SYSTEMD" -eq 1 ]]; then
  step "Bootstrap complete"
  echo "Install smoke passed without systemd integration."
  echo "  Re-run without --skip-systemd on a Linux user session to install and start the services."
  exit 0
fi

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
