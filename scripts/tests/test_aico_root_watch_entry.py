"""The `st aico` entry hands over to Tether's root-watch client unchanged."""

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

ENTRY = Path(__file__).resolve().parents[1] / "aico-root-watch.py"
SPEC = importlib.util.spec_from_file_location("aico_root_watch_entry", ENTRY)
assert SPEC and SPEC.loader
entry = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(entry)


def test_target_defaults_to_the_installed_tether_copy(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    assert entry.target({}) == tmp_path / ".local/lib/tether/scripts/aico-root-watch.py"
    assert entry.target({"TETHER_LIB_DIR": "/opt/tether"}) == Path(
        "/opt/tether/scripts/aico-root-watch.py")
    assert entry.target({"TETHER_ROOT_WATCH": "/x/watch.py"}) == Path("/x/watch.py")


def run(tmp_path, *args):
    env = {**os.environ, "TETHER_ROOT_WATCH": str(tmp_path / "missing.py")}
    return subprocess.run([sys.executable, str(ENTRY), *args], env=env, capture_output=True,
                          text=True, timeout=10, check=False)


def test_forwards_arguments_environment_and_exit_status(tmp_path):
    fake = tmp_path / "watch.py"
    fake.write_text(
        "import json, os, sys\n"
        "print(json.dumps({'argv': sys.argv[1:], 'widget': os.environ.get('AICO_WIDGET_ID')}))\n"
        "sys.exit(3)\n"
    )
    result = subprocess.run(
        [sys.executable, str(ENTRY), "roots", "fixture-root", "--watch", "5"],
        env={**os.environ, "TETHER_ROOT_WATCH": str(fake), "AICO_WIDGET_ID": "deadbeef"},
        capture_output=True, text=True, timeout=10, check=False,
    )
    assert result.returncode == 3
    assert json.loads(result.stdout) == {"argv": ["roots", "fixture-root", "--watch", "5"],
                                         "widget": "deadbeef"}


def test_missing_tether_copy_is_unavailable_not_a_traceback(tmp_path):
    result = run(tmp_path, "roots")
    assert result.returncode == 2
    body = json.loads(result.stdout)
    assert body["observation"] == "unavailable"
    assert body["reason"] == "tether_root_watch_missing"
    assert "Traceback" not in result.stderr
