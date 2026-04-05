from __future__ import annotations

from pathlib import Path

SYSTEMD_DIR = Path(__file__).resolve().parents[1] / "scripts" / "systemd"
SERVICE_NAMES = [
    "aterm-backend.service",
    "aterm-frontend.service",
]


def test_aterm_units_use_project_root_placeholder() -> None:
    for service_name in SERVICE_NAMES:
        text = (SYSTEMD_DIR / service_name).read_text()
        assert "__PROJECT_ROOT__" in text
        assert "%h/aterm" not in text


def test_aterm_units_do_not_use_legacy_placeholder() -> None:
    legacy_placeholder = "__" + "TERMI" + "NAL_ROOT__"
    for service_name in SERVICE_NAMES:
        text = (SYSTEMD_DIR / service_name).read_text()
        assert legacy_placeholder not in text
