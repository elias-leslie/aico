from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def test_install_script_bootstraps_local_postgres_instead_of_failing_after_env_copy() -> None:
    text = (REPO_ROOT / "scripts" / "install.sh").read_text()

    assert "bootstrap_local_postgres" in text
    assert "Created .env.local from .env.example. Set DATABASE_URL" not in text
    assert "A_TERM_INSTALL_MANAGED_POSTGRES" in text
    assert "A_TERM_POSTGRES_CONTAINER_NAME" in text


def test_start_script_restarts_managed_postgres_when_enabled() -> None:
    text = (REPO_ROOT / "scripts" / "start.sh").read_text()

    assert 'MANAGED_POSTGRES="${A_TERM_INSTALL_MANAGED_POSTGRES:-false}"' in text
    assert 'docker start "$POSTGRES_CONTAINER_NAME"' in text


def test_env_example_documents_installer_managed_database_path() -> None:
    text = (REPO_ROOT / ".env.example").read_text()

    assert "Leave the placeholder DATABASE_URL below" in text
    assert "bootstrap a local Docker PostgreSQL automatically" in text
