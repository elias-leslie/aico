"""tclaude/tcodex project launcher: Tether project discovery and tmux handoff."""

from __future__ import annotations

import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = REPO_ROOT / "scripts" / "lib" / "project-launcher.sh"


def _executable(path: Path, text: str) -> Path:
    path.write_text(text)
    path.chmod(0o755)
    return path


def _stubs(tmp_path: Path, projects_tsv: str) -> tuple[Path, Path, Path]:
    """A tsession stub that logs its argv and environment, and a tmux trap."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "tsession.log"
    tmux_log = tmp_path / "tmux.log"
    projects = tmp_path / "projects.tsv"
    projects.write_text(projects_tsv)
    tsession = _executable(
        tmp_path / "tsession",
        f"""#!/usr/bin/env bash
if [ "$1" = projects ]; then
  cat {str(projects)!r}
  exit 0
fi
if [ "$1" = list ]; then
  exit 0
fi
printf 'argv=%s\\n' "$*" >> {str(log)!r}
printf 'TMUX=%s\\n' "${{TMUX:-}}" >> {str(log)!r}
""",
    )
    # The launcher must never drive tmux itself: switch-client cannot cross
    # tmux servers, so the handoff belongs to `tsession open --attach`.
    _executable(
        bin_dir / "tmux",
        f"""#!/usr/bin/env bash
printf '%s\\n' "$*" >> {str(tmux_log)!r}
exit 1
""",
    )
    return tsession, log, tmux_log


def _launch(tmp_path: Path, tsession: Path, tool: str, project: str, tmux: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "-c", f'source "{LAUNCHER}"; launch_a_term_project_tool "$0" "$1"', tool, project],
        capture_output=True,
        text=True,
        env={
            "PATH": f"{tmp_path / 'bin'}:/usr/bin:/bin",
            "HOME": str(tmp_path / "home"),
            "A_TERM_TSESSION": str(tsession),
            "ST_WORKSPACES_ROOT": str(tmp_path / "none"),
            "TMUX": tmux,
        },
    )


def test_launcher_resolves_project_root_from_tether_and_defers_attach_to_tsession(
    tmp_path: Path,
) -> None:
    root = tmp_path / "work" / "demo"
    root.mkdir(parents=True)
    tsession, log, tmux_log = _stubs(tmp_path, f"other\t/nowhere\ndemo\t{root}\n")
    foreign = "/home/u/.local/state/tether/default/tmux/abc/server.sock,4242,0"

    result = _launch(tmp_path, tsession, "codex", "demo", foreign)

    assert result.returncode == 0, result.stderr
    lines = log.read_text().splitlines()
    assert lines == [
        f"argv=open --tool codex --project demo --cwd {root} --attach",
        f"TMUX={foreign}",
    ]
    assert not tmux_log.exists()


def test_launcher_falls_back_to_home_checkout_when_tether_does_not_know_the_project(
    tmp_path: Path,
) -> None:
    home_checkout = tmp_path / "home" / "solo"
    home_checkout.mkdir(parents=True)
    tsession, log, _ = _stubs(tmp_path, "")

    result = _launch(tmp_path, tsession, "claude-code", "solo", "")

    assert result.returncode == 0, result.stderr
    assert log.read_text().splitlines()[0] == (
        f"argv=open --tool claude-code --project solo --cwd {home_checkout} --attach"
    )


def test_launcher_reports_unknown_projects(tmp_path: Path) -> None:
    tsession, log, _ = _stubs(tmp_path, "")

    result = _launch(tmp_path, tsession, "codex", "ghost", "")

    assert result.returncode == 1
    assert "Project 'ghost' not found" in result.stderr
    assert not log.exists()


def test_tclaude_launches_the_canonical_claude_code_tool() -> None:
    text = (REPO_ROOT / "scripts" / "tclaude").read_text()

    assert 'launch_a_term_project_tool "claude-code"' in text


def test_tsession_no_longer_strips_database_url() -> None:
    text = (REPO_ROOT / "scripts" / "tsession").read_text()

    assert "DATABASE_URL" not in text
