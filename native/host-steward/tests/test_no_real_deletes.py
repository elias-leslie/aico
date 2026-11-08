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
    for tool in ("ssh", "systemctl", "sudo", "tmux", "btrfs", "restic", "rclone"):
        with pytest.raises(PermissionError, match="real"):
            subprocess.run([tool, "--version"], check=False)
    with pytest.raises(PermissionError, match="real"):
        subprocess.run("tmux -V", shell=True, check=False)
    # Harmless if the guard breaks: a made-up tool's version, in shapes a plain word check would miss.
    for line in ("true;ssh -V", "$(ssh -V)", "cd /tmp && ssh -V", "A=1 ssh -V"):
        with pytest.raises(PermissionError, match="real ssh"):
            subprocess.run(line, shell=True, check=False)
    with pytest.raises(PermissionError, match="real ssh"):
        subprocess.run(["bash", "-lc", "ssh -V"], check=False)
    with pytest.raises(PermissionError, match="real ssh"):
        subprocess.run(["env", "ssh", "-V"], check=False)
    with pytest.raises(PermissionError, match="real ssh"):
        os.system("ssh -V")
    fake = tmp_path / "ssh"
    fake.write_text("#!/bin/sh\nexit 0\n")
    fake.chmod(0o755)
    assert subprocess.run([str(fake)], check=False).returncode == 0


def test_through_a_link_and_rename_targets_are_judged_by_what_they_hit(tmp_path):
    # Made-up names under a real folder: if the guard breaks, the call just fails on a missing path.
    real = "/srv/scratch/not-a-real-entry"
    link = tmp_path / "link"
    link.symlink_to("/srv/scratch")
    with pytest.raises(PermissionError, match="outside a temp"):
        os.rmdir(f"{link}/not-a-real-entry/")
    with pytest.raises(PermissionError, match="outside a temp"):
        os.remove(f"{link}/../not-a-real-entry")
    with pytest.raises(PermissionError, match="outside a temp"):
        os.replace(tmp_path / "missing", real)
    with pytest.raises(PermissionError, match="outside a temp"):
        open("/nonexistent-folder-for-guard/x", "w").close()
    with pytest.raises(PermissionError, match="outside a temp"):
        subprocess.run("rm -rf /nonexistent-folder-for-guard/x", shell=True, check=False)
