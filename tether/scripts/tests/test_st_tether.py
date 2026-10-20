"""ST always executes the installed Tether, preserving argv and exit status."""
import os
import shutil
import subprocess
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "st-tether"


def test_installed_selection_and_arguments(tmp_path):
    checkout = tmp_path / "checkout"
    (checkout / "scripts").mkdir(parents=True)
    (checkout / "bin").mkdir()
    entry = checkout / "scripts/st-tether"
    shutil.copy2(SOURCE, entry)
    decoy = checkout / "bin/tether"
    decoy.write_text('#!/bin/sh\necho checkout\nexit 99\n')
    decoy.chmod(0o755)
    home = tmp_path / "home with spaces"
    installed = home / ".local/lib/tether/bin/tether"
    installed.parent.mkdir(parents=True)
    installed.write_text('#!/bin/sh\nprintf "<%s>\\n" "$@"\nexit 23\n')
    installed.chmod(0o755)
    result = subprocess.run([str(entry), "sessions", "", "two words", "--json", "$(literal)", "*"],
                            cwd=tmp_path, env={**os.environ, "HOME": str(home), "PATH": str(checkout / "bin")},
                            capture_output=True, text=True, check=False)
    assert result.returncode == 23
    assert result.stdout == '<sessions>\n<>\n<two words>\n<--json>\n<$(literal)>\n<*>\n'
    installed.unlink()
    missing = subprocess.run([str(entry), "version"], cwd=tmp_path,
                             env={**os.environ, "HOME": str(home), "PATH": str(checkout / "bin")},
                             capture_output=True, text=True, check=False)
    assert missing.returncode == 127
    assert not missing.stdout
    assert str(installed) in missing.stderr
