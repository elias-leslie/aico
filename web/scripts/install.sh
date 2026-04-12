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

remove_blank_env_keys() {
  local file_path="$1"
  shift

  python3 - "$file_path" "$@" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
keys = {key.strip() for key in sys.argv[2:] if key.strip()}
if not path.exists() or not keys:
    raise SystemExit(0)

lines = path.read_text().splitlines()
next_lines: list[str] = []
for line in lines:
    stripped = line.strip()
    if "=" in line and not stripped.startswith("#"):
        key, value = line.split("=", 1)
        if key.strip() in keys and not value.strip():
            continue
    next_lines.append(line)

path.write_text("\n".join(next_lines) + ("\n" if next_lines else ""))
PY
}

install_is_interactive() {
  case "${A_TERM_INSTALL_INTERACTIVE:-auto}" in
    1|true|yes)
      return 0
      ;;
    0|false|no)
      return 1
      ;;
  esac

  [[ -t 0 && -t 1 ]]
}

prompt_with_default() {
  local prompt="$1"
  local default_value="${2:-}"
  local response=""

  if [[ -n "$default_value" ]]; then
    printf '%s [%s]: ' "$prompt" "$default_value" >&2
  else
    printf '%s: ' "$prompt" >&2
  fi
  read -r response || true
  if [[ -z "$response" ]]; then
    response="$default_value"
  fi
  printf '%s\n' "$response"
}

prompt_yes_no() {
  local prompt="$1"
  local default_answer="${2:-Y}"
  local suffix="Y/n"
  local default_value="y"
  local response=""

  case "${default_answer^^}" in
    N)
      suffix="y/N"
      default_value="n"
      ;;
    *)
      suffix="Y/n"
      default_value="y"
      ;;
  esac

  while true; do
    printf '%s [%s]: ' "$prompt" "$suffix" >&2
    read -r response || true
    response="${response:-$default_value}"
    case "${response,,}" in
      y|yes)
        return 0
        ;;
      n|no)
        return 1
        ;;
    esac
    echo "Please answer yes or no." >&2
  done
}

probe_url() {
  local url="$1"
  curl --silent --show-error --fail --max-time 2 "$url" >/dev/null 2>&1
}

local_postgres_ready() {
  if command_exists pg_isready; then
    pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1
    return
  fi

  python3 - <<'PY' >/dev/null 2>&1
import socket

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.settimeout(1.0)
    sock.connect(("127.0.0.1", 5432))
PY
}

port_is_available() {
  local host="$1"
  local port="$2"

  python3 - "$host" "$port" <<'PY' >/dev/null 2>&1
import socket
import sys

host = sys.argv[1]
port = int(sys.argv[2])

infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
for family, socktype, proto, _, sockaddr in infos:
    with socket.socket(family, socktype, proto) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(sockaddr)
        except OSError:
            continue
        raise SystemExit(0)

raise SystemExit(1)
PY
}

find_available_port_near() {
  local host="$1"
  local start_port="$2"

  python3 - "$host" "$start_port" <<'PY'
import socket
import sys

host = sys.argv[1]
start_port = int(sys.argv[2])

def can_bind(candidate: int) -> bool:
    infos = socket.getaddrinfo(host, candidate, type=socket.SOCK_STREAM)
    for family, socktype, proto, _, sockaddr in infos:
        with socket.socket(family, socktype, proto) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(sockaddr)
            except OSError:
                continue
            return True
    return False

for candidate in range(max(1, start_port + 1), start_port + 101):
    if can_bind(candidate):
        print(candidate)
        raise SystemExit(0)

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
}

resolve_service_port() {
  local host="$1"
  local requested_port="$2"
  local label="$3"
  local env_var="$4"
  local suggested_port=""
  local chosen_port=""

  if port_is_available "$host" "$requested_port"; then
    printf '%s\n' "$requested_port"
    return
  fi

  suggested_port="$(find_available_port_near "$host" "$requested_port")"
  [[ -n "$suggested_port" ]] || fail "Unable to find an available ${label,,} port near ${requested_port}."

  if install_is_interactive; then
    echo "${label} port ${requested_port} on ${host} is already in use." >&2
    while true; do
      chosen_port="$(prompt_with_default "Choose a different ${label,,} port" "$suggested_port")"
      if [[ ! "$chosen_port" =~ ^[0-9]+$ ]]; then
        echo "Please enter a numeric port." >&2
        continue
      fi
      if port_is_available "$host" "$chosen_port"; then
        printf '%s\n' "$chosen_port"
        return
      fi
      echo "Port ${chosen_port} on ${host} is also in use." >&2
      suggested_port="$(find_available_port_near "$host" "$chosen_port")"
    done
  fi

  echo "${label} port ${requested_port} on ${host} is already in use. Using ${suggested_port} instead. Override ${env_var} later if you want a different value." >&2
  printf '%s\n' "$suggested_port"
}

looks_like_postgres_url() {
  case "$1" in
    postgresql://*|postgres://*)
      return 0
      ;;
  esac
  return 1
}

sync_default_cors_origin() {
  local file_path="$1"
  local frontend_host="$2"
  local frontend_port="$3"

  python3 - "$file_path" "$frontend_host" "$frontend_port" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
frontend_host = sys.argv[2]
frontend_port = sys.argv[3]

if not path.exists():
    raise SystemExit(0)

line_prefix = "CORS_ORIGINS="
lines = path.read_text().splitlines()
current_value = None
for line in lines:
    if line.startswith(line_prefix):
        current_value = line[len(line_prefix):].strip()
        break

managed_defaults = {
    "",
    '["http://localhost:3002"]',
    '["http://127.0.0.1:3002"]',
    '["http://0.0.0.0:3002"]',
}
if current_value not in managed_defaults:
    raise SystemExit(0)

origin_host = frontend_host
if origin_host in {"127.0.0.1", "0.0.0.0", "::1", "localhost"}:
    origin_host = "localhost"
next_value = f'["http://{origin_host}:{frontend_port}"]'

updated = False
next_lines = []
for line in lines:
    if line.startswith(line_prefix):
        next_lines.append(f"{line_prefix}{next_value}")
        updated = True
        continue
    next_lines.append(line)

if not updated:
    if next_lines and next_lines[-1] != "":
        next_lines.append("")
    next_lines.append(f"{line_prefix}{next_value}")

path.write_text("\n".join(next_lines) + "\n")
PY
}

configure_database_choice() {
  if [[ -n "${DATABASE_URL:-}" && "${DATABASE_URL}" != "$DATABASE_URL_PLACEHOLDER" ]]; then
    return
  fi
  if ! install_is_interactive; then
    return
  fi

  step "Database setup"
  echo "A-Term can manage PostgreSQL for you, or connect to an existing PostgreSQL database you already run."
  if local_postgres_ready; then
    echo "Found a PostgreSQL listener on 127.0.0.1:5432."
  fi

  if prompt_yes_no "Use A-Term-managed PostgreSQL?" "Y"; then
    return
  fi

  local existing_url=""
  while true; do
    existing_url="$(prompt_with_default "Enter your PostgreSQL connection URL" "")"
    if [[ -z "$existing_url" ]]; then
      echo "A PostgreSQL URL is required when you choose an existing database." >&2
      continue
    fi
    if ! looks_like_postgres_url "$existing_url"; then
      echo "That does not look like a PostgreSQL URL. Expected postgres:// or postgresql://." >&2
      continue
    fi
    break
  done

  DATABASE_URL="$existing_url"
  A_TERM_MANAGED_POSTGRES_MODE=""
  A_TERM_POSTGRES_CONTAINER_NAME=""
  A_TERM_POSTGRES_DATA_DIR=""
  A_TERM_POSTGRES_PORT=""
  update_env_value "$ENV_FILE" "DATABASE_URL" "$DATABASE_URL"
  update_env_value "$ENV_FILE" "A_TERM_MANAGED_POSTGRES_MODE" ""
  update_env_value "$ENV_FILE" "A_TERM_POSTGRES_CONTAINER_NAME" ""
  update_env_value "$ENV_FILE" "A_TERM_POSTGRES_DATA_DIR" ""
  update_env_value "$ENV_FILE" "A_TERM_POSTGRES_PORT" ""
}

configure_companion_api() {
  local summitflow_health="http://127.0.0.1:8001/health"
  local summitflow_api="http://127.0.0.1:8001/api"

  if [[ -n "${SUMMITFLOW_API_BASE:-}" ]]; then
    return
  fi
  if ! probe_url "$summitflow_health"; then
    return
  fi

  if ! install_is_interactive; then
    echo "Detected an optional companion API locally at ${summitflow_health}. Set SUMMITFLOW_API_BASE=${summitflow_api} in .env.local if you want shared notes and project scopes." >&2
    return
  fi

  step "Companion mode"
  echo "Found an optional companion API running locally."
  echo "Companion mode lets A-Term use a shared notes library and project catalog."
  if prompt_yes_no "Enable companion API mode?" "Y"; then
    SUMMITFLOW_API_BASE="$summitflow_api"
    update_env_value "$ENV_FILE" "SUMMITFLOW_API_BASE" "$SUMMITFLOW_API_BASE"
  fi
}

configure_agent_hub_companion() {
  local agent_hub_health="http://127.0.0.1:8003/health"
  local agent_hub_url="http://127.0.0.1:8003"

  if [[ -n "${AGENT_HUB_URL:-}" || -n "${NEXT_PUBLIC_AGENT_HUB_URL:-}" ]]; then
    if [[ -n "${AGENT_HUB_URL:-}" && -z "${NEXT_PUBLIC_AGENT_HUB_URL:-}" ]]; then
      NEXT_PUBLIC_AGENT_HUB_URL="$AGENT_HUB_URL"
      update_env_value "$ENV_FILE" "NEXT_PUBLIC_AGENT_HUB_URL" "$NEXT_PUBLIC_AGENT_HUB_URL"
    elif [[ -z "${AGENT_HUB_URL:-}" && -n "${NEXT_PUBLIC_AGENT_HUB_URL:-}" ]]; then
      AGENT_HUB_URL="$NEXT_PUBLIC_AGENT_HUB_URL"
      update_env_value "$ENV_FILE" "AGENT_HUB_URL" "$AGENT_HUB_URL"
    fi
    return
  fi
  if ! probe_url "$agent_hub_health"; then
    return
  fi

  if ! install_is_interactive; then
    echo "Detected optional Agent Hub locally at ${agent_hub_health}. Set AGENT_HUB_URL=${agent_hub_url} and NEXT_PUBLIC_AGENT_HUB_URL=${agent_hub_url} in .env.local if you want model catalog, prompt cleaning, and Agent Hub voice integration." >&2
    return
  fi

  step "Agent Hub mode"
  echo "Found Agent Hub running locally."
  echo "Agent Hub mode enables model catalog, prompt cleaning, and voice integration."
  if prompt_yes_no "Enable Agent Hub companion mode?" "Y"; then
    AGENT_HUB_URL="$agent_hub_url"
    NEXT_PUBLIC_AGENT_HUB_URL="$agent_hub_url"
    update_env_value "$ENV_FILE" "AGENT_HUB_URL" "$AGENT_HUB_URL"
    update_env_value "$ENV_FILE" "NEXT_PUBLIC_AGENT_HUB_URL" "$NEXT_PUBLIC_AGENT_HUB_URL"
  fi
}

display_host_for_url() {
  case "$1" in
    127.0.0.1|0.0.0.0|::1|localhost)
      printf 'localhost\n'
      ;;
    *)
      printf '%s\n' "$1"
      ;;
  esac
}

print_next_steps() {
  local frontend_host="$1"
  local frontend_port="$2"
  local backend_host="$3"
  local backend_port="$4"
  local display_frontend_host=""
  local display_backend_host=""

  display_frontend_host="$(display_host_for_url "$frontend_host")"
  display_backend_host="$(display_host_for_url "$backend_host")"

  echo
  echo "Open A-Term:"
  echo "  Frontend: http://${display_frontend_host}:${frontend_port}"
  echo "  Backend:  http://${display_backend_host}:${backend_port}/health"
  echo
  if [[ -n "${SUMMITFLOW_API_BASE:-}" ]]; then
    echo "Mode: companion API (${SUMMITFLOW_API_BASE})"
  else
    echo "Mode: standalone local storage"
  fi
  echo "For secure remote access, see docs/remote-access.md:"
  echo "  - Tailscale"
  echo "  - Cloudflare Tunnel"
  echo "  - Caddy reverse proxy"
  if [[ "${A_TERM_AUTH_MODE:-none}" == "none" ]]; then
    echo "Before exposing A-Term beyond localhost, set A_TERM_AUTH_MODE=password and provide A_TERM_AUTH_PASSWORD plus A_TERM_AUTH_SECRET."
  fi
}

stop_existing_user_services() {
  if [[ "$SKIP_SYSTEMD" -eq 1 ]]; then
    return
  fi
  if ! command_exists systemctl; then
    return
  fi

  local stopped_any=0
  for service in "$BACKEND_SERVICE" "$FRONTEND_SERVICE"; do
    if systemctl --user list-unit-files "$service" >/dev/null 2>&1; then
      systemctl --user stop "$service" >/dev/null 2>&1 || true
      stopped_any=1
    fi
  done

  if [[ "$stopped_any" -eq 1 ]]; then
    sleep 1
  fi
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
  local bootstrap_output=""

  if ! docker_available; then
    if ! bash "$REPO_ROOT/scripts/managed-postgres.sh" local-tools-ready; then
      install_system_role postgresql_server
    fi
    bootstrap_mode="local"
  fi

  step "Bootstrapping managed PostgreSQL (${bootstrap_mode})"
  bootstrap_output="$(
    bash "$REPO_ROOT/scripts/managed-postgres.sh" bootstrap "$bootstrap_mode"
  )" || fail "Managed PostgreSQL bootstrap failed."
  [[ -n "$bootstrap_output" ]] || fail "Managed PostgreSQL bootstrap returned no configuration."
  eval "$bootstrap_output"
  [[ -n "${DATABASE_URL:-}" ]] || fail "Managed PostgreSQL bootstrap did not produce DATABASE_URL."
  [[ "${DATABASE_URL}" != "$DATABASE_URL_PLACEHOLDER" ]] || fail "Managed PostgreSQL bootstrap left the placeholder DATABASE_URL in place."
  [[ -n "${A_TERM_MANAGED_POSTGRES_MODE:-}" ]] || fail "Managed PostgreSQL bootstrap did not report its runtime mode."

  update_env_value "$ENV_FILE" "DATABASE_URL" "$DATABASE_URL"
  update_env_value "$ENV_FILE" "A_TERM_MANAGED_POSTGRES_MODE" "$A_TERM_MANAGED_POSTGRES_MODE"
  update_env_value "$ENV_FILE" "A_TERM_POSTGRES_CONTAINER_NAME" "${A_TERM_POSTGRES_CONTAINER_NAME:-}"
  update_env_value "$ENV_FILE" "A_TERM_POSTGRES_DATA_DIR" "${A_TERM_POSTGRES_DATA_DIR:-}"
  update_env_value "$ENV_FILE" "A_TERM_POSTGRES_PORT" "${A_TERM_POSTGRES_PORT:-}"
  export DATABASE_URL

  echo "Configured managed PostgreSQL at ${DATABASE_URL} (${A_TERM_MANAGED_POSTGRES_MODE})"
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

remove_blank_env_keys "$REPO_ROOT/.env.local" \
  "SUMMITFLOW_API_BASE" \
  "NEXT_PUBLIC_AGENT_HUB_URL" \
  "AGENT_HUB_URL"
remove_blank_env_keys "$REPO_ROOT/.env" \
  "SUMMITFLOW_API_BASE" \
  "NEXT_PUBLIC_AGENT_HUB_URL" \
  "AGENT_HUB_URL"

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
    "SUMMITFLOW_API_BASE",
    "NEXT_PUBLIC_AGENT_HUB_URL",
    "AGENT_HUB_URL",
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
    value = values.get(key, "")
    print(f"{key}={shlex.quote(value)}")
PY
)"

configure_companion_api
configure_agent_hub_companion
configure_database_choice

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

stop_existing_user_services

BACKEND_PORT="$(resolve_service_port "$BACKEND_HOST" "$BACKEND_PORT" "Backend" "A_TERM_PORT")"
FRONTEND_PORT="$(resolve_service_port "$FRONTEND_HOST" "$FRONTEND_PORT" "Frontend" "A_TERM_FRONTEND_PORT")"

update_env_value "$ENV_FILE" "A_TERM_PORT" "$BACKEND_PORT"
update_env_value "$ENV_FILE" "A_TERM_BIND_HOST" "$BACKEND_HOST"
update_env_value "$ENV_FILE" "A_TERM_FRONTEND_PORT" "$FRONTEND_PORT"
update_env_value "$ENV_FILE" "A_TERM_FRONTEND_HOST" "$FRONTEND_HOST"
sync_default_cors_origin "$ENV_FILE" "$FRONTEND_HOST" "$FRONTEND_PORT"

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
  echo "When you start A-Term, it will use:"
  echo "  Frontend: http://$(display_host_for_url "$FRONTEND_HOST"):${FRONTEND_PORT}"
  echo "  Backend:  http://$(display_host_for_url "$BACKEND_HOST"):${BACKEND_PORT}/health"
  echo
  if [[ -n "${SUMMITFLOW_API_BASE:-}" ]]; then
    echo "Mode: companion API (${SUMMITFLOW_API_BASE})"
  else
    echo "Mode: standalone local storage"
  fi
  echo "For secure remote access, see docs/remote-access.md:"
  echo "  - Tailscale"
  echo "  - Cloudflare Tunnel"
  echo "  - Caddy reverse proxy"
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
port_is_available "$BACKEND_HOST" "$BACKEND_PORT" || fail "Backend port ${BACKEND_PORT} on ${BACKEND_HOST} is still busy after installer port selection."
port_is_available "$FRONTEND_HOST" "$FRONTEND_PORT" || fail "Frontend port ${FRONTEND_PORT} on ${FRONTEND_HOST} is still busy after installer port selection."

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
    if curl --silent --fail "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  fail "$label did not become healthy at $url"
}

step "Verifying runtime"
wait_for_url "http://$(display_host_for_url "$BACKEND_HOST"):${BACKEND_PORT}/health" "backend"
wait_for_url "http://$(display_host_for_url "$FRONTEND_HOST"):${FRONTEND_PORT}" "frontend"

echo
echo "${PRODUCT_NAME} is ready."
print_next_steps "$FRONTEND_HOST" "$FRONTEND_PORT" "$BACKEND_HOST" "$BACKEND_PORT"
