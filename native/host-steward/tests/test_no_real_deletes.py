"""The root conftest's guard: no test deletes outside a temp folder or runs the real machine tools.

Every probe here is harmless even if the guard breaks: made-up paths and read-only commands.
"""

import os
import shutil
import subprocess

import pytest


def test_a_delete_outside_temp_is_refused_before_it_happens(tmp_path):
    for call in (
        lambda: os.remove("/srv/scratch/not-a-real-entry"),
        lambda: shutil.rmtree("/srv/scratch/not-a-real-entry", ignore_errors=True),
    ):
        with pytest.raises(PermissionError, match="outside a temp folder"):
            call()
    (tmp_path / "mine").write_text("x")
    os.remove(tmp_path / "mine")


def test_removing_a_link_in_temp_only_judges_the_link(tmp_path):
    link = tmp_path / "link"
    link.symlink_to("/srv/scratch/not-a-real-entry")
    os.remove(link)


def test_the_real_machine_tools_are_refused_but_a_fake_in_temp_runs(tmp_path):
    assert "TMUX" not in os.environ
    for tool in ("ssh", "systemctl", "sudo", "tmux"):
        with pytest.raises(PermissionError, match="real"):
            subprocess.run([tool, "--version"], check=False)
    with pytest.raises(PermissionError, match="real"):
        subprocess.run("tmux -V", shell=True, check=False)
    fake = tmp_path / "ssh"
    fake.write_text("#!/bin/sh\nexit 0\n")
    fake.chmod(0o755)
    assert subprocess.run([str(fake)], check=False).returncode == 0
