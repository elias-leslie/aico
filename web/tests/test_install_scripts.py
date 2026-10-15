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


def _sync_origins(tmp_path: Path, env_text: str, host: str, port: str) -> str:
    script = (REPO_ROOT / "scripts" / "install.sh").read_text()
    harness = tmp_path / "origins.sh"
    env_file = tmp_path / ".env.local"
    env_file.write_text(env_text)
    harness.write_text(
        "set -euo pipefail\n"
        + _extract_functions(script, "sync_default_allowed_origins")
        + f'\nsync_default_allowed_origins "{env_file}" "{host}" "{port}" 3002\n'
    )
    subprocess.run(["bash", str(harness)], check=True, capture_output=True, text=True)
    return env_file.read_text()


def test_install_drops_the_old_cors_default_so_the_code_default_applies(tmp_path: Path) -> None:
    text = _sync_origins(tmp_path, 'OTHER=1\nCORS_ORIGINS=["http://localhost:3002"]\n', "127.0.0.1", "3002")
    assert text == "OTHER=1\n"


def test_install_writes_the_one_list_for_a_lan_frontend(tmp_path: Path) -> None:
    text = _sync_origins(tmp_path, "OTHER=1\n", "192.168.1.5", "3005")
    assert 'A_TERM_ALLOWED_ORIGINS=["http://localhost:3005","http://127.0.0.1:3005","http://192.168.1.5:3005"]' in text


def test_install_keeps_an_owner_edited_list(tmp_path: Path) -> None:
    owned = 'A_TERM_ALLOWED_ORIGINS=["https://a-term.example.com"]\nCORS_ORIGINS=["https://a-term.example.com"]\n'
    assert _sync_origins(tmp_path, owned, "127.0.0.1", "3005") == owned
