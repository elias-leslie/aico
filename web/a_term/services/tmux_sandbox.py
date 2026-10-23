"""How A-Term attaches to a Tether session without trusting what Tether returns.

Tether may run as another user, so its attach answer is data, not a command.
A-Term takes only the tmux socket path and the target from it, builds the
``tmux`` argv itself and runs that client inside bubblewrap with nothing but
tmux in it. A tmux server can tell an attached client to run a command
(``detach-client -E``, via ``/bin/sh``); with no shell in the sandbox that
command cannot run as this user.
"""

from __future__ import annotations

import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any

__all__ = [
    "BWRAP_BIN",
    "SOCKET_PATTERNS",
    "TMUX_BIN",
    "attach_argv",
    "client_pid",
    "sandbox_env",
    "sandboxed",
]

TMUX_BIN = "/usr/bin/tmux"
BWRAP_BIN = "/usr/bin/bwrap"

# Sockets A-Term will attach to: the agent instance's runtime tree, or this
# user's own Tether instance state (``$XDG_STATE_HOME/tether/<instance>``).
_SERVER = r"tmux/[0-9a-f]{32}/server\.sock$"
SOCKET_PATTERNS: tuple[str, ...] = (
    rf"^/run/tether/[a-z]+/default/{_SERVER}",
    rf"^{{state}}/tether/[a-z0-9_-]+/{_SERVER}",
)
TARGET_PATTERN = re.compile(r"^[$%@]?[A-Za-z0-9_.:][A-Za-z0-9_.:-]{0,63}$")
# The only variables the client sees (Tether sets exactly these today).
ENV_KEYS = ("TERM", "COLORTERM", "CLICOLOR")
_ENV_VALUE = re.compile(r"^[A-Za-z0-9._-]{1,32}$")
# Read-only data the client needs besides tmux and its libraries.
_DATA_DIRS = ("/usr/share/terminfo", "/usr/lib/locale/C.utf8")

_libs_cache: tuple[tuple[float, int], list[str]] | None = None


def _state_root() -> str:
    return os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")


def trusted_socket(path: object) -> bool:
    """True when ``path`` is a Tether tmux server socket of the agent or of this user."""
    if not isinstance(path, str):
        return False
    state = re.escape(_state_root())
    return any(re.fullmatch(pattern.replace("{state}", state), path) for pattern in SOCKET_PATTERNS)


def attach_argv(target: dict[str, Any], socket_path: str) -> list[str]:
    """``tmux -S <socket> attach-session -t <target>`` from Tether's answer.

    Only the socket (which must be the session's own and a trusted one) and
    the target are taken; ``argv[0]`` and every other word are ours.
    """
    argv = target.get("argv")
    if (
        not isinstance(argv, list)
        or len(argv) != 6
        or not all(isinstance(arg, str) for arg in argv)
        or argv[1] != "-S"
        or argv[2] != socket_path
        or not trusted_socket(argv[2])
        or argv[3] not in {"attach-session", "attach"}
        or argv[4] != "-t"
        or not TARGET_PATTERN.fullmatch(argv[5])
    ):
        raise ValueError("Tether returned an unexpected attach target")
    return [TMUX_BIN, "-S", argv[2], "attach-session", "-t", argv[5]]


def sandbox_env(overrides: object) -> dict[str, str]:
    """The client's whole environment: Tether's allowed keys, else TERM only.

    ``LANG`` is ours: tmux marks a client UTF-8 from it (the sandbox has the
    C.UTF-8 locale), and without it non-ASCII text would show as underscores.
    """
    env = {"TERM": "xterm-256color", "LANG": "C.UTF-8"}
    if isinstance(overrides, dict):
        for key in ENV_KEYS:
            value = overrides.get(key)
            if isinstance(value, str) and _ENV_VALUE.fullmatch(value):
                env[key] = value
    return env


def _libraries() -> list[str]:
    """The files the dynamic loader maps for tmux (``ldd``), cached per tmux build."""
    global _libs_cache
    stat = os.stat(TMUX_BIN)
    key = (stat.st_mtime, stat.st_size)
    if _libs_cache and _libs_cache[0] == key:
        return _libs_cache[1]
    out = subprocess.run(
        ["/usr/bin/ldd", TMUX_BIN], capture_output=True, text=True, check=True, timeout=10
    ).stdout
    paths: list[str] = []
    for line in out.splitlines():
        words = line.split()
        found = [w for w in (words[2:3] if "=>" in words else words[:1]) if w.startswith("/")]
        paths.extend(found)
    if not paths:
        raise RuntimeError("could not list tmux's libraries")
    _libs_cache = (key, paths)
    return paths


def sandboxed(tmux_argv: list[str]) -> list[str]:
    """``tmux_argv`` (``/usr/bin/tmux -S <socket> …``) run under bubblewrap.

    Inside: tmux, its libraries, terminfo and the C.UTF-8 locale (read-only),
    a minimal /dev plus the host's /dev/pts (so the client names its tty), and
    the socket's directory (read-only; connecting needs no write). No shell, no
    network of its own, no other executable. The pid namespace stays shared so
    the client's pid is the one Tether's resize claim looks for (bubblewrap
    forks, so that is bwrap's child: see :func:`client_pid`).
    """
    if not tmux_argv or tmux_argv[0] != TMUX_BIN:
        raise ValueError("not a tmux argv")
    try:
        socket_path = tmux_argv[tmux_argv.index("-S") + 1]
    except (ValueError, IndexError) as error:
        raise ValueError("tmux argv has no socket") from error
    if not trusted_socket(socket_path):
        raise ValueError("tmux socket is not a Tether server socket")
    argv = [
        BWRAP_BIN,
        "--unshare-user",
        "--unshare-ipc",
        "--unshare-net",
        "--unshare-uts",
        "--unshare-cgroup-try",
        "--die-with-parent",
        "--chdir",
        "/",
        "--dev",
        "/dev",
        "--ro-bind",
        "/dev/pts",
        "/dev/pts",
        "--ro-bind",
        TMUX_BIN,
        TMUX_BIN,
    ]
    for lib in _libraries():
        argv += ["--ro-bind", os.path.realpath(lib), lib]
    for data in _DATA_DIRS:
        argv += ["--ro-bind-try", data, data]
    socket_dir = os.path.dirname(socket_path)
    argv += ["--ro-bind", socket_dir, socket_dir, "--", *tmux_argv]
    return argv


def client_pid(bwrap_pid: int, timeout: float = 2.0) -> int:
    """The tmux client's pid: the child bubblewrap forks to run it.

    Tether's resize claim names the client by pid, and tmux reports its own,
    not bubblewrap's. Falls back to ``bwrap_pid`` if no child appears.
    """
    deadline = time.monotonic() + timeout
    while True:
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            try:
                stat = Path(f"/proc/{entry}/stat").read_text()
            except OSError:
                continue
            # "pid (comm) state ppid ..."; comm may hold spaces and parens.
            fields = stat.rsplit(")", 1)[-1].split()
            if len(fields) > 1 and fields[1] == str(bwrap_pid):
                return int(entry)
        if time.monotonic() >= deadline:
            return bwrap_pid
        time.sleep(0.01)
