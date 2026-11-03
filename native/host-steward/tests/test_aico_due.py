"""aico-due.py, Claude Code's native puller, against a fake Tether socket (never the live one)."""

from __future__ import annotations

import fcntl
import json
import os
import socketserver
import subprocess
import sys
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "aico-due.py"
SESSION = "0a1b2c3d"
DUE = f"/v1/sessions/{SESSION}/due?wait=55"


@contextmanager
def tether(tmp_path, answers):
    """Answers each request with the next (status, body); records the paths."""
    routes: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            routes.append(self.path)
            status, data = answers.pop(0) if answers else (200, {"text": None})
            raw = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, format: str, *args: object) -> None:
            pass

    path = str(tmp_path / "control.sock")
    with socketserver.ThreadingUnixStreamServer(path, Handler) as server:
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .01})
        thread.start()
        try:
            yield path, routes
        finally:
            server.shutdown()
            thread.join()


def run(tmp_path, sock, session=SESSION):
    env = {**os.environ, "TETHER_SOCKET": sock, "XDG_RUNTIME_DIR": str(tmp_path)}
    env.pop("AICO_WIDGET_ID", None)
    if session:
        env["AICO_WIDGET_ID"] = session
    return subprocess.run([sys.executable, "-I", str(SCRIPT)], env=env, capture_output=True, text=True,
                          timeout=30, check=False)


def test_due_lines_go_to_stderr_and_exit_2_wakes_claude(tmp_path):
    line = "[Message] 1 request from cc:1c7a9f"
    with tether(tmp_path, [(200, {"text": None}), (200, {"text": line})]) as (sock, routes):
        result = run(tmp_path, sock)
    assert result.returncode == 2
    assert result.stderr == line + "\n" and result.stdout == ""
    assert routes == [DUE, DUE]


@pytest.mark.parametrize("status, body", [
    (404, {"error": "not_found"}),
    (409, {"error": "delivery_unsupported"}),
    (400, {"error": "invalid_query", "field": "wait", "max": 55}),
])
def test_no_route_unknown_session_or_shell_exits_quietly(tmp_path, status, body):
    with tether(tmp_path, [(status, body)]) as (sock, routes):
        result = run(tmp_path, sock)
    assert (result.returncode, result.stdout, result.stderr) == (0, "", "")
    assert routes == [DUE]


def test_a_second_poller_for_the_session_exits_at_once(tmp_path):
    locks = tmp_path / "aico-due"
    locks.mkdir()
    with open(locks / f"{SESSION}.lock", "w") as held, tether(tmp_path, []) as (sock, routes):
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = run(tmp_path, sock)
    assert (result.returncode, result.stdout, result.stderr) == (0, "", "")
    assert routes == []


@pytest.mark.parametrize("session", [None, "", "not-a-session"])
def test_outside_an_aico_session_it_does_nothing(tmp_path, session):
    with tether(tmp_path, []) as (sock, routes):
        result = run(tmp_path, sock, session)
    assert (result.returncode, result.stdout, result.stderr) == (0, "", "")
    assert routes == []
