from __future__ import annotations

import json
import shutil
import socketserver
import subprocess
import tempfile
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]


def _extract_functions(script: str, *names: str) -> str:
    """Return the named top-level bash function definitions from a script."""
    chunks = []
    for name in names:
        start = script.index(f"\n{name}() {{\n") + 1
        end = script.index("\n}\n", start) + 3
        chunks.append(script[start:end])
    return "\n".join(chunks)


class _VersionHandler(BaseHTTPRequestHandler):
    api_version: object = 1

    def do_GET(self) -> None:
        body = json.dumps({"name": "tether", "version": "0.0.1", "apiVersion": self.api_version})
        if self.path != "/v1/version":
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, format: str, *args: object) -> None:
        return


class _UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def get_request(self):
        request, _ = super().get_request()
        return request, ("tether", 0)


@contextmanager
def _fake_tether(socket_path: Path, api_version: object) -> Iterator[None]:
    handler = type("Handler", (_VersionHandler,), {"api_version": api_version})
    server = _UnixHTTPServer(str(socket_path), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture()
def short_dir() -> Iterator[Path]:
    """Unix socket paths are capped near 107 bytes; pytest's tmp_path can exceed that."""
    path = Path(tempfile.mkdtemp(prefix="at-", dir="/tmp"))
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


def _run_tether_check(tmp_path: Path, extra_env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    script = (REPO_ROOT / "scripts" / "install.sh").read_text()
    functions = _extract_functions(
        script,
        "command_exists",
        "step",
        "fail",
        "tether_socket_path",
        "tether_api_version",
        "ensure_tether_available",
    )
    harness = tmp_path / "harness.sh"
    harness.write_text(
        "set -euo pipefail\nA_TERM_MIN_TETHER_API=1\n" + functions + "\nensure_tether_available\n"
    )
    env = {
        "PATH": f"{tmp_path / 'bin'}:/usr/bin:/bin",
        "HOME": str(tmp_path),
        "XDG_RUNTIME_DIR": str(tmp_path / "runtime"),
        **extra_env,
    }
    (tmp_path / "bin").mkdir(exist_ok=True)
    return subprocess.run(["bash", str(harness)], capture_output=True, env=env, text=True)


def test_install_script_has_no_database_steps() -> None:
    text = (REPO_ROOT / "scripts" / "install.sh").read_text()

    for needle in ("DATABASE_URL", "managed-postgres", "alembic", "PostgreSQL", "postgres"):
        assert needle not in text
    assert not (REPO_ROOT / "scripts" / "managed-postgres.sh").exists()
    assert not (REPO_ROOT / "alembic").exists()
    assert not (REPO_ROOT / "alembic.ini").exists()


def test_start_and_shutdown_scripts_manage_only_a_term_services() -> None:
    start_text = (REPO_ROOT / "scripts" / "start.sh").read_text()
    stop_text = (REPO_ROOT / "scripts" / "shutdown.sh").read_text()

    for text in (start_text, stop_text):
        assert "postgres" not in text.lower()
    assert 'source "$REPO_ROOT/.env.local"' not in start_text
    assert "FRONTEND_ENV=" in start_text


def test_env_example_has_no_database_settings() -> None:
    text = (REPO_ROOT / ".env.example").read_text()

    assert "DATABASE_URL" not in text
    assert "DB_POOL_" not in text
    assert "A_TERM_AICO_STATE_DIR" not in text
    assert "# TETHER_SOCKET=" in text
    assert "\nNEXT_PUBLIC_AGENT_HUB_URL=\n" not in text
    assert "\nAGENT_HUB_URL=\n" not in text
    assert "SUMMITFLOW_API_BASE" not in text
    assert "# NEXT_PUBLIC_AGENT_HUB_URL=http://127.0.0.1:8003" in text
    assert "# AGENT_HUB_URL=http://127.0.0.1:8003" in text


def test_project_identity_has_no_database_section() -> None:
    identity = json.loads((REPO_ROOT / "project.identity.json").read_text())

    assert "database" not in identity


def test_ci_has_no_postgres_service_or_migrations() -> None:
    text = (REPO_ROOT / ".github" / "workflows" / "ci.yml").read_text()

    assert "postgres" not in text.lower()
    assert "DATABASE_URL" not in text
    assert "alembic" not in text


def test_install_script_checks_tether_before_installing() -> None:
    text = (REPO_ROOT / "scripts" / "install.sh").read_text()

    assert "A_TERM_MIN_TETHER_API=1" in text
    assert text.index("ensure_tether_available\n") < text.index('step "Installing Python dependencies"')


def test_tether_check_accepts_a_compatible_daemon(short_dir: Path) -> None:
    tmp_path = short_dir
    socket_path = tmp_path / "t.sock"
    with _fake_tether(socket_path, 1):
        result = _run_tether_check(tmp_path, {"TETHER_SOCKET": str(socket_path)})

    assert result.returncode == 0, result.stderr
    assert f"Tether API v1 at {socket_path}" in result.stdout


def test_tether_check_uses_the_instance_socket_under_xdg_runtime_dir(short_dir: Path) -> None:
    tmp_path = short_dir
    socket_dir = tmp_path / "runtime" / "tether" / "dev"
    socket_dir.mkdir(parents=True)
    with _fake_tether(socket_dir / "control.sock", 3):
        result = _run_tether_check(tmp_path, {"TETHER_INSTANCE": "dev"})

    assert result.returncode == 0, result.stderr
    assert "Tether API v3" in result.stdout


def test_tether_check_rejects_an_old_api(short_dir: Path) -> None:
    tmp_path = short_dir
    socket_path = tmp_path / "t.sock"
    with _fake_tether(socket_path, 0):
        result = _run_tether_check(tmp_path, {"TETHER_SOCKET": str(socket_path)})

    assert result.returncode != 0
    assert "serves API v0; A-Term needs v1 or later" in result.stderr


def test_tether_check_explains_how_to_install_when_missing(tmp_path: Path) -> None:
    result = _run_tether_check(tmp_path, {"TETHER_SOCKET": str(tmp_path / "missing.sock")})

    assert result.returncode != 0
    assert "github.com/elias-leslie/tether" in result.stderr
    assert "systemctl --user enable --now tether@default.service" in result.stderr


def test_tether_check_skips_only_when_explicitly_asked(tmp_path: Path) -> None:
    result = _run_tether_check(
        tmp_path,
        {"TETHER_SOCKET": str(tmp_path / "missing.sock"), "A_TERM_SKIP_TETHER_CHECK": "1"},
    )

    assert result.returncode == 0, result.stderr
    assert "Skipping the Tether check" in result.stdout


def test_install_script_supports_non_systemd_smoke_runs() -> None:
    text = (REPO_ROOT / "scripts" / "install.sh").read_text()
    readme = (REPO_ROOT / "README.md").read_text()

    assert "--skip-systemd" in text
    assert 'if [[ "$SKIP_SYSTEMD" -eq 1 ]]; then' in text
    assert "Install smoke passed without systemd integration." in text
    assert "--skip-systemd" in readme


def test_install_script_guides_ports_and_agent_hub_choice() -> None:
    text = (REPO_ROOT / "scripts" / "install.sh").read_text()
    frontend_package = (REPO_ROOT / "frontend" / "package.json").read_text()

    assert "install_is_interactive()" in text
    assert "stop_existing_user_services()" in text
    assert 'systemctl --user stop "$service"' in text
    assert "resolve_service_port" in text
    assert 'prompt_with_default "Choose a different ${label,,} port"' in text
    # Projects come from Tether now; the old SummitFlow catalog mode is gone.
    assert "configure_companion_api" not in text
    assert "SUMMITFLOW_API_BASE" not in text
    assert "configure_agent_hub_companion" in text
    assert "Enable Agent Hub companion mode?" in text
    assert "remove_blank_env_keys" in text
    assert '"NEXT_PUBLIC_AGENT_HUB_URL",' in text
    assert '"AGENT_HUB_URL",' in text
    assert "For secure remote access, see docs/remote-access.md" in text
    assert '"build": "node scripts/build-with-runtime.mjs"' in frontend_package


def test_install_script_syncs_optional_dev_extra() -> None:
    text = (REPO_ROOT / "scripts" / "install.sh").read_text()

    assert "uv sync --extra dev" in text
    assert "uv sync --dev" not in text


def test_frontend_service_path_includes_local_bin_for_bootstrapped_node() -> None:
    text = (REPO_ROOT / "scripts" / "systemd" / "a-term-frontend.service").read_text()

    assert '%h/.local/bin' in text
