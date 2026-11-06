"""`st skills` (moved from Agent Hub): links canonical skills into a harness and reports drift."""

import json
import os
import shutil
from pathlib import Path

import pytest
from typer.testing import CliRunner

from aico_service import skills

# The installer lives in the agent-skills checkout; `st skills install` runs it.
INSTALLER = Path(os.environ.get("ST_AGENT_SKILLS_DIR", "~/agent-skills")).expanduser() / "install.sh"


@pytest.mark.skipif(not INSTALLER.is_file(), reason="agent-skills checkout not present")
def test_install_links_and_status_reports_drift(tmp_path: Path, monkeypatch) -> None:
    canon = tmp_path / "canon"
    (canon / "skills" / "demo").mkdir(parents=True)
    (canon / "skills" / "demo" / "SKILL.md").write_text("---\nname: demo\ndescription: Demo.\n---\n")
    (canon / "skills" / "_shared").mkdir()  # linked into every harness
    (canon / "commands").mkdir()
    dest = tmp_path / "harness" / "skills"
    (canon / "manifest.toml").write_text(
        f'[harness.test]\nskills_dir = "{dest}"\ninclude = ["demo"]\n\n[profile.default]\nexclude = []\n'
    )
    shutil.copy(INSTALLER, canon / "install.sh")
    monkeypatch.setenv("ST_AGENT_SKILLS_DIR", str(canon))
    runner = CliRunner()

    missing = runner.invoke(skills.app, ["status", "--json"])
    assert missing.exit_code == 0, missing.output
    assert json.loads(missing.output)["counts"]["missing"] == 2

    installed = runner.invoke(skills.app, ["install"])
    assert installed.exit_code == 0, installed.output
    assert os.readlink(dest / "demo") == str(canon / "skills" / "demo")

    linked = runner.invoke(skills.app, ["status", "--json"])
    assert json.loads(linked.output)["counts"] == {**json.loads(missing.output)["counts"], "ok": 2, "missing": 0}
