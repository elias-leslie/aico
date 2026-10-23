"""scripts/install.sh: --dry-run reports every step and changes nothing."""

import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
INSTALL = REPO / "scripts" / "install.sh"
REAL_HOST = Path("/usr/bin/tmux").exists() and Path("/sys/fs/cgroup/cgroup.controllers").exists()


def stub(bin_dir: Path, name: str, body: str) -> None:
    path = bin_dir / name
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(0o755)


@pytest.fixture
def home(tmp_path: Path) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    return home


@pytest.fixture
def env(tmp_path: Path, home: Path) -> dict[str, str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    stub(bin_dir, "node", 'case "$1" in -p) echo 24 ;; *) echo v24.0.0 ;; esac')
    for name in ("npm", "git"):
        stub(bin_dir, name, f'echo "{name} must not run in a dry run" >&2; exit 99')
    stub(
        bin_dir,
        "systemctl",
        'case "$1" in --version) echo "systemd 255 (255)" ;; *) exit 99 ;; esac',
    )
    stub(bin_dir, "loginctl", "echo yes")
    return {
        "PATH": f"{bin_dir}:/usr/bin:/bin",
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "USER": "tester",
    }


def install(env: dict[str, str], *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(INSTALL), *args],
        check=False,
        capture_output=True,
        env=env,
        text=True,
        timeout=60,
    )


def files_under(path: Path) -> list[Path]:
    return [item for item in path.rglob("*") if not item.is_dir()]


def test_dry_run_prints_each_step_and_writes_nothing(env: dict[str, str], home: Path) -> None:
    result = install(env, "--dry-run", "--skip-systemd")
    assert result.returncode == 0, result.stderr
    out = result.stdout
    for line in (
        "would run: npm ci --no-audit --no-fund",
        "would run: npm run build",
        f"would run: env TETHER_LIB_DIR={home}/.local/lib/tether tether/scripts/install-release.sh",
        f"would run: ln -sfn {home}/.local/lib/tether/bin/tether {home}/.local/bin/tether",
        f"would write {home}/.local/share/applications/aico.desktop",
        "Dry run: nothing was changed.",
    ):
        assert line in out
    assert "systemd" not in out  # --skip-systemd: no units
    assert "st-coord" not in out  # no SummitFlow here
    assert files_under(home) == []


@pytest.mark.skipif(not REAL_HOST, reason="needs /usr/bin/tmux and cgroup v2")
def test_dry_run_lists_every_unit(env: dict[str, str], home: Path) -> None:
    result = install(env, "--dry-run", "--start")
    assert result.returncode == 0, result.stderr
    units = sorted(path.name for path in (REPO / "scripts" / "systemd").glob("*.service"))
    for unit in [*units, "tether@.service"]:
        assert f"would write {home}/.config/systemd/user/{unit}" in result.stdout
    assert "would run: systemctl --user daemon-reload" in result.stdout
    assert (
        "would run: systemctl --user restart tether@default.service aico-web.service"
        in result.stdout
    )
    assert files_under(home) == []


def test_pi_extension_links_only_when_summitflow_has_it(
    env: dict[str, str], home: Path, tmp_path: Path
) -> None:
    source = tmp_path / "pi-coord-extension.ts"
    source.write_text("// fixture\n")
    result = install({**env, "ST_PI_COORD_EXTENSION": str(source)}, "--dry-run", "--skip-systemd")
    assert result.returncode == 0, result.stderr
    assert f"would run: ln -sfn {source} {home}/.pi/agent/extensions/st-coord.ts" in result.stdout


def test_an_existing_file_is_never_replaced_by_a_link(env: dict[str, str], home: Path) -> None:
    (home / ".local/bin").mkdir(parents=True)
    (home / ".local/bin/tether").write_text("someone else's tether\n")
    result = install(env, "--dry-run", "--skip-systemd")
    assert result.returncode == 1
    assert "is not a symlink; move it aside" in result.stderr


@pytest.mark.parametrize("args", [("--start", "--skip-systemd"), ("--bogus",)])
def test_bad_arguments_exit_2(env: dict[str, str], args: tuple[str, ...]) -> None:
    assert install(env, *args).returncode == 2


def test_old_node_is_refused(env: dict[str, str], tmp_path: Path) -> None:
    stub(tmp_path / "bin", "node", 'case "$1" in -p) echo 20 ;; *) echo v20.0.0 ;; esac')
    result = install(env, "--dry-run", "--skip-systemd")
    assert result.returncode == 1
    assert "Node.js 22+ required" in result.stderr
