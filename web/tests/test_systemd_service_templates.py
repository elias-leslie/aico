from __future__ import annotations

from pathlib import Path

SYSTEMD_DIR = Path(__file__).resolve().parents[1] / "scripts" / "systemd"
SERVICE_NAMES = [
    "a-term-backend.service",
    "a-term-frontend.service",
]


def test_a_term_units_use_project_root_placeholder() -> None:
    for service_name in SERVICE_NAMES:
        text = (SYSTEMD_DIR / service_name).read_text()
        assert "__PROJECT_ROOT__" in text
        assert "%h/a_term" not in text
        assert "%h/.env.local" not in text


def test_a_term_units_do_not_use_legacy_placeholder() -> None:
    legacy_placeholder = "__" + "TERMI" + "NAL_ROOT__"
    for service_name in SERVICE_NAMES:
        text = (SYSTEMD_DIR / service_name).read_text()
        assert legacy_placeholder not in text


def test_a_term_units_load_repo_local_env_files() -> None:
    for service_name in SERVICE_NAMES:
        text = (SYSTEMD_DIR / service_name).read_text()
        assert "EnvironmentFile=-__PROJECT_ROOT__/.env.local" in text
        assert "EnvironmentFile=-__PROJECT_ROOT__/.env" in text


def test_a_term_units_default_to_localhost_bindings() -> None:
    backend = (SYSTEMD_DIR / "a-term-backend.service").read_text()
    frontend = (SYSTEMD_DIR / "a-term-frontend.service").read_text()

    assert 'A_TERM_BIND_HOST="${A_TERM_BIND_HOST:-127.0.0.1}"' in backend
    assert 'API_URL="${API_URL:-http://127.0.0.1:${A_TERM_PORT:-8002}}"' in frontend
    assert 'HOSTNAME="${A_TERM_FRONTEND_HOST:-127.0.0.1}"' in frontend


def test_a_term_backend_unit_has_no_forced_summitflow_dependency() -> None:
    backend = (SYSTEMD_DIR / "a-term-backend.service").read_text()
    assert "SUMMITFLOW_API_BASE=" not in backend


def test_a_term_frontend_unit_uses_direct_standalone_shutdown_path() -> None:
    frontend = (SYSTEMD_DIR / "a-term-frontend.service").read_text()

    assert "KillMode=process" in frontend
    assert "KillSignal=SIGKILL" in frontend
    assert "SuccessExitStatus=SIGKILL" in frontend
    assert "corepack pnpm start" not in frontend
    assert 'exec /usr/bin/node .next/standalone/server.js' in frontend
