#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export REPO_ROOT
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

DEFAULT_POSTGRES_CONTAINER_NAME="a-term-postgres"
DEFAULT_POSTGRES_DATA_DIR="${HOME}/.local/share/a-term/postgres"
DEFAULT_POSTGRES_USER="a-term"
DEFAULT_POSTGRES_DB="a-term"
DEFAULT_POSTGRES_PASSWORD="a-term"

fail() {
  echo "Managed PostgreSQL failed: $1" >&2
  exit 1
}

docker_available() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
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

raise SystemExit("Managed PostgreSQL failed: no free local PostgreSQL port was available.")
PY
}

load_managed_postgres_env() {
  eval "$(
    python3 - <<'PY'
import os
import shlex
from pathlib import Path

repo_root = Path(os.environ["REPO_ROOT"])
keys = [
    "DATABASE_URL",
    "A_TERM_MANAGED_POSTGRES_MODE",
    "A_TERM_POSTGRES_CONTAINER_NAME",
    "A_TERM_POSTGRES_DATA_DIR",
    "A_TERM_POSTGRES_PORT",
    "A_TERM_INSTALL_MANAGED_POSTGRES",
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
}

resolve_managed_postgres_mode() {
  if [[ -n "${A_TERM_MANAGED_POSTGRES_MODE:-}" ]]; then
    printf '%s\n' "$A_TERM_MANAGED_POSTGRES_MODE"
    return
  fi

  if [[ "${A_TERM_INSTALL_MANAGED_POSTGRES:-false}" == "true" ]]; then
    printf 'docker\n'
    return
  fi

  printf 'none\n'
}

find_postgres_binary() {
  local name="$1"

  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return 0
  fi

  python3 - "$name" <<'PY'
from pathlib import Path
import sys

name = sys.argv[1]
patterns = [
    f"/usr/lib/postgresql/*/bin/{name}",
    f"/usr/pgsql-*/bin/{name}",
]

for pattern in patterns:
    matches = sorted(Path("/").glob(pattern.lstrip("/")))
    if matches:
        print(matches[-1])
        raise SystemExit(0)

raise SystemExit(1)
PY
}

ensure_local_postgres_binaries() {
  INITDB_BIN="$(find_postgres_binary initdb)" || fail "initdb is not installed."
  PG_CTL_BIN="$(find_postgres_binary pg_ctl)" || fail "pg_ctl is not installed."
  CREATEDB_BIN="$(find_postgres_binary createdb)" || fail "createdb is not installed."
  PG_ISREADY_BIN="$(find_postgres_binary pg_isready)" || fail "pg_isready is not installed."
}

wait_for_postgres() {
  local host="$1"
  local port="$2"
  local user="$3"
  local db_name="$4"
  local attempts="${5:-45}"

  for ((i = 1; i <= attempts; i += 1)); do
    if "$PG_ISREADY_BIN" -h "$host" -p "$port" -U "$user" -d "$db_name" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  fail "PostgreSQL on ${host}:${port} did not become ready."
}

emit_assignment() {
  local key="$1"
  local value="$2"
  python3 - "$key" "$value" <<'PY'
import shlex
import sys

print(f"{sys.argv[1]}={shlex.quote(sys.argv[2])}")
PY
}

emit_managed_postgres_env() {
  emit_assignment DATABASE_URL "$1"
  emit_assignment A_TERM_MANAGED_POSTGRES_MODE "$2"
  emit_assignment A_TERM_POSTGRES_CONTAINER_NAME "$3"
  emit_assignment A_TERM_POSTGRES_DATA_DIR "$4"
  emit_assignment A_TERM_POSTGRES_PORT "$5"
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

bootstrap_docker_postgres() {
  local container_name="${A_TERM_POSTGRES_CONTAINER_NAME:-$DEFAULT_POSTGRES_CONTAINER_NAME}"
  local host_port=""

  docker_available || fail "docker is not available."

  if docker container inspect "$container_name" >/dev/null 2>&1; then
    docker start "$container_name" >/dev/null 2>&1 || true
    host_port="$(
      docker inspect \
        -f '{{range (index .NetworkSettings.Ports "5432/tcp")}}{{.HostPort}}{{end}}' \
        "$container_name"
    )"
    [[ -n "$host_port" ]] || fail "Existing PostgreSQL container ${container_name} does not expose port 5432."
  else
    host_port="$(find_available_local_port 5432 55432 56432)"
    docker run \
      -d \
      --name "$container_name" \
      --restart unless-stopped \
      -e POSTGRES_DB="$DEFAULT_POSTGRES_DB" \
      -e POSTGRES_USER="$DEFAULT_POSTGRES_USER" \
      -e POSTGRES_PASSWORD="$DEFAULT_POSTGRES_PASSWORD" \
      -p "${host_port}:5432" \
      postgres:16 >/dev/null
  fi

  wait_for_postgres_container "$container_name" "$DEFAULT_POSTGRES_USER" "$DEFAULT_POSTGRES_DB"
  emit_managed_postgres_env \
    "postgresql://${DEFAULT_POSTGRES_USER}:${DEFAULT_POSTGRES_PASSWORD}@127.0.0.1:${host_port}/${DEFAULT_POSTGRES_DB}" \
    "docker" \
    "$container_name" \
    "" \
    "$host_port"
}

ensure_local_cluster_initialized() {
  local data_dir="$1"

  if [[ -f "$data_dir/PG_VERSION" ]]; then
    return
  fi

  mkdir -p "$(dirname "$data_dir")"
  local password_file
  password_file="$(mktemp)"
  printf '%s\n' "$DEFAULT_POSTGRES_PASSWORD" >"$password_file"
  "$INITDB_BIN" \
    -D "$data_dir" \
    -U "$DEFAULT_POSTGRES_USER" \
    --auth-local trust \
    --auth-host scram-sha-256 \
    --pwfile="$password_file" >/dev/null
  rm -f "$password_file"
}

local_cluster_running() {
  local data_dir="$1"

  [[ -f "$data_dir/PG_VERSION" ]] || return 1
  "$PG_CTL_BIN" -D "$data_dir" status >/dev/null 2>&1
}

start_local_postgres() {
  local data_dir="${A_TERM_POSTGRES_DATA_DIR:-$DEFAULT_POSTGRES_DATA_DIR}"
  local port="${A_TERM_POSTGRES_PORT:-}"

  ensure_local_postgres_binaries
  ensure_local_cluster_initialized "$data_dir"

  if [[ -z "$port" ]]; then
    port="$(find_available_local_port 5432 55432 56432)"
  fi

  mkdir -p "$data_dir"
  if ! local_cluster_running "$data_dir"; then
    "$PG_CTL_BIN" \
      -D "$data_dir" \
      -l "$data_dir/postgres.log" \
      -o "-h 127.0.0.1 -p ${port}" \
      start >/dev/null
  fi

  wait_for_postgres "127.0.0.1" "$port" "$DEFAULT_POSTGRES_USER" "postgres"

  PGPASSWORD="$DEFAULT_POSTGRES_PASSWORD" \
    "$CREATEDB_BIN" \
    -h 127.0.0.1 \
    -p "$port" \
    -U "$DEFAULT_POSTGRES_USER" \
    "$DEFAULT_POSTGRES_DB" >/dev/null 2>&1 || true

  emit_managed_postgres_env \
    "postgresql://${DEFAULT_POSTGRES_USER}:${DEFAULT_POSTGRES_PASSWORD}@127.0.0.1:${port}/${DEFAULT_POSTGRES_DB}" \
    "local" \
    "" \
    "$data_dir" \
    "$port"
}

local_tools_ready() {
  if ensure_local_postgres_binaries >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

stop_local_postgres() {
  local data_dir="${A_TERM_POSTGRES_DATA_DIR:-$DEFAULT_POSTGRES_DATA_DIR}"

  ensure_local_postgres_binaries
  if local_cluster_running "$data_dir"; then
    "$PG_CTL_BIN" -D "$data_dir" stop -m fast >/dev/null
  fi
}

start_managed_postgres() {
  load_managed_postgres_env
  local mode
  mode="$(resolve_managed_postgres_mode)"

  case "$mode" in
    docker)
      local container_name="${A_TERM_POSTGRES_CONTAINER_NAME:-$DEFAULT_POSTGRES_CONTAINER_NAME}"
      docker_available || fail "docker is not available."
      docker start "$container_name" >/dev/null 2>&1 || true
      ;;
    local)
      start_local_postgres >/dev/null
      ;;
    none)
      ;;
    *)
      fail "unknown managed postgres mode: $mode"
      ;;
  esac
}

stop_managed_postgres() {
  load_managed_postgres_env
  local mode
  mode="$(resolve_managed_postgres_mode)"

  case "$mode" in
    docker)
      local container_name="${A_TERM_POSTGRES_CONTAINER_NAME:-$DEFAULT_POSTGRES_CONTAINER_NAME}"
      docker_available || fail "docker is not available."
      docker stop "$container_name" >/dev/null 2>&1 || true
      ;;
    local)
      stop_local_postgres
      ;;
    none)
      ;;
    *)
      fail "unknown managed postgres mode: $mode"
      ;;
  esac
}

bootstrap_managed_postgres() {
  local mode="${1:-auto}"

  case "$mode" in
    docker)
      bootstrap_docker_postgres
      ;;
    local)
      start_local_postgres
      ;;
    auto)
      if docker_available; then
        bootstrap_docker_postgres
      else
        start_local_postgres
      fi
      ;;
    *)
      fail "unknown bootstrap mode: $mode"
      ;;
  esac
}

case "${1:-}" in
  bootstrap)
    bootstrap_managed_postgres "${2:-auto}"
    ;;
  start)
    start_managed_postgres
    ;;
  stop)
    stop_managed_postgres
    ;;
  local-tools-ready)
    local_tools_ready
    ;;
  *)
    cat <<'EOF' >&2
Usage: bash scripts/managed-postgres.sh <bootstrap|start|stop|local-tools-ready> [docker|local|auto]
EOF
    exit 1
    ;;
esac
