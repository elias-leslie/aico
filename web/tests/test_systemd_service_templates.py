from __future__ import annotations

import shlex
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SYSTEMD_DIR = REPO_ROOT / "scripts" / "systemd"
# SummitFlow runs the code from a release copy (REPO_ROOT here) and points this
# placeholder at the owner's checkout, where the env files live.
HOST_CONFIG_ROOT = Path("/owner/checkout")


def _render(name: str) -> dict[str, list[tuple[str, str]]]:
    """Render a unit as SummitFlow's managed deploy does and parse it into ordered (key, value) pairs per section."""
    text = (
        (SYSTEMD_DIR / name)
        .read_text()
        .replace("__PROJECT_ROOT__", str(REPO_ROOT))
        .replace("__SUMMITFLOW_HOST_CONFIG_ROOT__", str(HOST_CONFIG_ROOT))
    )
    sections: dict[str, list[tuple[str, str]]] = {}
    current = None
    for line in text.splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        if line.startswith("["):
            current = sections.setdefault(line.strip("[]"), [])
            continue
        key, sep, value = line.partition("=")
        assert sep and current is not None, f"{name}: unparseable line {line!r}"
        current.append((key, value))
    return sections


def _values(section: list[tuple[str, str]], key: str) -> list[str]:
    return [value for k, value in section if k == key]


@pytest.mark.parametrize(
    ("name", "workdir", "exec_target"),
    [
        ("a-term-backend.service", REPO_ROOT, "uvicorn a_term.main:app"),
        ("a-term-frontend.service", REPO_ROOT / "frontend", "/usr/bin/node .next/standalone/server.js"),
    ],
)
def test_rendered_unit_runs_from_the_project_on_localhost(name: str, workdir: Path, exec_target: str) -> None:
    unit = _render(name)
    service = unit["Service"]

    assert set(unit) == {"Unit", "Service", "Install"}
    assert _values(service, "WorkingDirectory") == [str(workdir)]
    assert workdir.is_dir()
    # A release copy has no env files (git archive), so they come from the owner's checkout.
    assert _values(service, "EnvironmentFile") == [f"-{HOST_CONFIG_ROOT}/.env.local", f"-{HOST_CONFIG_ROOT}/.env"]
    assert "%h/.local/bin" in _values(service, "Environment")[0]

    (exec_start,) = _values(service, "ExecStart")
    argv = shlex.split(exec_start)
    assert argv[:2] == ["/bin/bash", "-lc"]
    script = argv[2]
    subprocess.run(["bash", "-n", "-c", script], check=True)
    assert exec_target in script
    # Default bindings stay on loopback; remote access is opt-in.
    assert ":-0.0.0.0" not in script
    assert "127.0.0.1" in script


def test_backend_prefers_agent_launchers_and_only_soft_depends_on_tether() -> None:
    unit = _render("a-term-backend.service")
    path = _values(unit["Service"], "Environment")[0]

    assert path.index("%h/.claude/bin") < path.index("%h/.local/bin")
    assert path.index("%h/.codex/bin") < path.index("%h/.local/bin")
    assert _values(unit["Unit"], "Wants") == ["tether@default.service"]
    assert "tether@default.service" in _values(unit["Unit"], "After")[0]
    assert not any(key in {"Requires", "BindsTo", "PartOf"} for key, _ in unit["Unit"])
