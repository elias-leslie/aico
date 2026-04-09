from __future__ import annotations

import os
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def _write_executable(path: Path, contents: str) -> None:
    path.write_text(contents)
    path.chmod(0o755)


def test_install_script_bootstraps_managed_postgres_instead_of_failing_after_env_copy() -> None:
    text = (REPO_ROOT / "scripts" / "install.sh").read_text()

    assert "bootstrap_managed_postgres" in text
    assert "Created .env.local from .env.example. Set DATABASE_URL" not in text
    assert "A_TERM_MANAGED_POSTGRES_MODE" in text
    assert "A_TERM_POSTGRES_CONTAINER_NAME" in text
    assert "A_TERM_POSTGRES_DATA_DIR" in text


def test_managed_postgres_runtime_uses_single_helper() -> None:
    start_text = (REPO_ROOT / "scripts" / "start.sh").read_text()
    stop_text = (REPO_ROOT / "scripts" / "shutdown.sh").read_text()

    assert 'bash "$REPO_ROOT/scripts/managed-postgres.sh" start' in start_text
    assert 'bash "$REPO_ROOT/scripts/managed-postgres.sh" stop' in stop_text
    assert 'source "$REPO_ROOT/.env.local"' not in start_text
    assert "FRONTEND_ENV=" in start_text


def test_env_example_documents_installer_managed_database_path() -> None:
    text = (REPO_ROOT / ".env.example").read_text()

    assert "Leave the placeholder DATABASE_URL below" in text
    assert "bootstrap managed PostgreSQL automatically" in text
    assert "prefers Docker" in text


def test_install_script_supports_non_systemd_smoke_runs() -> None:
    text = (REPO_ROOT / "scripts" / "install.sh").read_text()
    readme = (REPO_ROOT / "README.md").read_text()

    assert "--skip-systemd" in text
    assert 'if [[ "$SKIP_SYSTEMD" -eq 1 ]]; then' in text
    assert "Install smoke passed without systemd integration." in text
    assert "--skip-systemd" in readme


def test_install_script_syncs_optional_dev_extra() -> None:
    text = (REPO_ROOT / "scripts" / "install.sh").read_text()

    assert "uv sync --extra dev" in text
    assert "uv sync --dev" not in text


def test_frontend_service_path_includes_local_bin_for_bootstrapped_node() -> None:
    text = (REPO_ROOT / "scripts" / "systemd" / "a-term-frontend.service").read_text()

    assert '%h/.local/bin' in text


def test_managed_postgres_helper_can_bootstrap_local_mode_with_fake_binaries(tmp_path: Path) -> None:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    data_dir = tmp_path / "postgres"

    _write_executable(
        fake_bin / "initdb",
        """#!/usr/bin/env bash
set -euo pipefail
data_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -D)
      data_dir="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$data_dir"
printf '16\\n' > "$data_dir/PG_VERSION"
""",
    )
    _write_executable(
        fake_bin / "pg_ctl",
        """#!/usr/bin/env bash
set -euo pipefail
data_dir=""
command_name=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -D)
      data_dir="$2"
      shift 2
      ;;
    -l|-o|-m)
      shift 2
      ;;
    start|stop|status)
      command_name="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
pid_file="$data_dir/postmaster.pid"
case "$command_name" in
  start)
    mkdir -p "$data_dir"
    printf '%s\\n' "$$" > "$pid_file"
    ;;
  stop)
    rm -f "$pid_file"
    ;;
  status)
    [[ -f "$pid_file" ]] || exit 1
    ;;
  *)
    exit 1
    ;;
esac
""",
    )
    _write_executable(
        fake_bin / "createdb",
        """#!/usr/bin/env bash
exit 0
""",
    )
    _write_executable(
        fake_bin / "pg_isready",
        """#!/usr/bin/env bash
exit 0
""",
    )

    env = os.environ.copy()
    env["PATH"] = f"{fake_bin}:{env['PATH']}"
    env["HOME"] = str(tmp_path)
    env["A_TERM_POSTGRES_DATA_DIR"] = str(data_dir)
    env["A_TERM_POSTGRES_PORT"] = "55432"

    result = subprocess.run(
        ["bash", str(REPO_ROOT / "scripts" / "managed-postgres.sh"), "bootstrap", "local"],
        capture_output=True,
        check=True,
        env=env,
        text=True,
    )

    assert "A_TERM_MANAGED_POSTGRES_MODE=local" in result.stdout
    assert f"A_TERM_POSTGRES_DATA_DIR={data_dir}" in result.stdout
    assert "A_TERM_POSTGRES_PORT=55432" in result.stdout
    assert (data_dir / "PG_VERSION").exists()
    assert (data_dir / "postmaster.pid").exists()
