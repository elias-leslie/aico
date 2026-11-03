#!/usr/bin/env python3
"""Claude Code's native puller for Tether's due lines (docs/api-v1.md "Deliveries").

Run as an asyncRewake hook (claude-config hooks/aico-due.sh) inside an Aico
session: long-polls `GET /v1/sessions/$AICO_WIDGET_ID/due?wait=55` on Tether's
socket and, when lines come, prints them on stderr and exits 2, which wakes
Claude with them. While it polls, Tether holds its own pane paste for the
session. One poller per session (a flock); stops when the Claude process that
started it is gone, after a 404 (no such session, or a Tether without the
route) or a shell session (409 delivery_unsupported). Never writes stdout.
"""

from __future__ import annotations

import fcntl
import http.client
import json
import os
import re
import select
import socket
import sys
import time

WAIT_SECONDS = 55
# Under the hook's 21600 s timeout, so Claude never kills it with a line in flight.
LIFETIME_SECONDS = 21_000
BACKOFF_SECONDS = 30
CHECK_SECONDS = 5
SESSION_ID = re.compile(r"[0-9a-f]{8}")


def runtime_dir() -> str:
    return os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"


def socket_path() -> str:
    return os.environ.get("TETHER_SOCKET") or os.path.join(runtime_dir(), "tether", "default", "control.sock")


def parent_of(pid: int) -> int | None:
    try:
        with open(f"/proc/{pid}/stat", "rb") as handle:
            stat = handle.read()
    except OSError:
        return None
    # Fields after the parenthesised command name: state, ppid, ...
    return int(stat[stat.rindex(b")") + 2 :].split()[1])


class Anchor:
    """The process chain that started this hook: Claude, and the shell between if there is one.
    Gone or reparented means Claude is gone."""

    def __init__(self) -> None:
        self.parent = os.getppid()
        self.grandparent = parent_of(self.parent)

    def alive(self) -> bool:
        return os.getppid() == self.parent and parent_of(self.parent) == self.grandparent


class Gone(Exception):
    """Claude went away while waiting."""


def poll(path: str, session: str, anchor: Anchor) -> tuple[int, dict]:
    """One long poll. Checks the anchor while Tether holds the request; closing it
    aborts the pull on Tether's side, so no line is handed to a dead session."""
    connection = http.client.HTTPConnection("tether", timeout=WAIT_SECONDS + 15)
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.sock = client
    try:
        client.settimeout(10)
        client.connect(path)
        connection.request("GET", f"/v1/sessions/{session}/due?wait={WAIT_SECONDS}",
                           headers={"Connection": "close"})
        deadline = time.monotonic() + WAIT_SECONDS + 15
        while not select.select([client], [], [], CHECK_SECONDS)[0]:
            if not anchor.alive():
                raise Gone
            if time.monotonic() > deadline:
                raise TimeoutError("due poll overran")
        client.settimeout(10)
        response = connection.getresponse()
        body = response.read()
    finally:
        connection.close()
    try:
        value = json.loads(body or b"{}")
    except ValueError:
        value = {}
    return response.status, value if isinstance(value, dict) else {}


def pause(seconds: float, anchor: Anchor) -> bool:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if not anchor.alive():
            return False
        time.sleep(min(CHECK_SECONDS, max(0.0, end - time.monotonic())))
    return anchor.alive()


def run() -> int:
    session = os.environ.get("AICO_WIDGET_ID", "")
    if not SESSION_ID.fullmatch(session):
        return 0
    anchor = Anchor()
    locks = os.path.join(runtime_dir(), "aico-due")
    os.makedirs(locks, mode=0o700, exist_ok=True)
    lock = open(os.path.join(locks, f"{session}.lock"), "w")  # noqa: SIM115 - held for the process lifetime
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return 0  # another poller already serves this session
    path = socket_path()
    end = time.monotonic() + LIFETIME_SECONDS
    while time.monotonic() < end and anchor.alive():
        try:
            status, value = poll(path, session, anchor)
        except Gone:
            return 0
        except (OSError, http.client.HTTPException):
            status, value = 0, {}  # Tether down or restarting
        if status == 200:
            text = value.get("text")
            if isinstance(text, str) and text:
                print(text, file=sys.stderr, flush=True)
                return 2  # asyncRewake: wake Claude with the lines
            continue
        if status == 404 or status == 400 or (status == 409 and value.get("error") == "delivery_unsupported"):
            return 0  # no such session or route, or a shell: nothing to pull here
        if not pause(BACKOFF_SECONDS, anchor):
            return 0
    return 0


def main() -> int:
    try:
        return run()
    except Exception:  # noqa: BLE001 - a hook fails open and quiet
        return 0


if __name__ == "__main__":
    sys.exit(main())
