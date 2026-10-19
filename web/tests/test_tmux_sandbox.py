"""The tmux sandbox: what A-Term accepts from Tether and how the client is confined."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from a_term.services import tmux_sandbox as sandbox

AGENT_SOCKET = "/run/tether/agent/default/tmux/" + "0123456789abcdef" * 2 + "/server.sock"


def _target(socket_path: str, target: str = "$2", **extra: object) -> dict:
    return {"argv": ["/usr/bin/tmux", "-S", socket_path, "attach-session", "-t", target], **extra}


@pytest.fixture()
def own_state(monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setenv("XDG_STATE_HOME", "/home/me/.local/state")
    return "/home/me/.local/state/tether/default/tmux/" + "ab" * 16 + "/server.sock"


def test_agent_and_own_instance_sockets_are_trusted(own_state: str) -> None:
    assert sandbox.trusted_socket(AGENT_SOCKET)
    assert sandbox.trusted_socket(own_state)


@pytest.mark.parametrize(
    "path",
    [
        "/run/tether/agent/other/tmux/" + "ab" * 16 + "/server.sock",
        "/run/tether/agent/default/tmux/" + "ab" * 15 + "/server.sock",
        "/run/tether/agent/default/tmux/" + "ab" * 16 + "/../server.sock",
        "/run/tether/Agent/default/tmux/" + "ab" * 16 + "/server.sock",
        "/home/someone/.local/state/tether/default/tmux/" + "ab" * 16 + "/server.sock",
        "/tmp/x.sock",
        "tmux/" + "ab" * 16 + "/server.sock",
        None,
    ],
)
def test_other_sockets_are_not_trusted(path: object, own_state: str) -> None:
    assert not sandbox.trusted_socket(path)


def test_argv_is_rebuilt_from_socket_and_target_only() -> None:
    answer = _target(AGENT_SOCKET, "$12", env={"LD_PRELOAD": "/x.so"})
    answer["argv"][0] = "/bin/sh"  # whatever Tether says about the program is ignored
    assert sandbox.attach_argv(answer, AGENT_SOCKET) == [
        "/usr/bin/tmux",
        "-S",
        AGENT_SOCKET,
        "attach-session",
        "-t",
        "$12",
    ]


@pytest.mark.parametrize("target", ["", "$1; rm -rf /", "a b", "-d", "x" * 65, "$(id)", "a\nb"])
def test_hostile_targets_are_refused(target: str) -> None:
    with pytest.raises(ValueError, match="unexpected attach target"):
        sandbox.attach_argv(_target(AGENT_SOCKET, target), AGENT_SOCKET)


def test_extra_argv_words_and_foreign_sockets_are_refused() -> None:
    with pytest.raises(ValueError):
        sandbox.attach_argv({"argv": [*_target(AGENT_SOCKET)["argv"], "-d"]}, AGENT_SOCKET)
    with pytest.raises(ValueError):
        sandbox.attach_argv(_target("/tmp/evil.sock"), "/tmp/evil.sock")
    with pytest.raises(ValueError):
        sandbox.attach_argv(
            _target(AGENT_SOCKET), "/run/tether/agent/default/tmux/" + "cd" * 16 + "/server.sock"
        )


def test_environment_is_a_fixed_allowlist() -> None:
    env = sandbox.sandbox_env(
        {
            "TERM": "tmux-256color",
            "COLORTERM": "truecolor",
            "LD_PRELOAD": "/x.so",
            "CLICOLOR": "1; id",
            "PATH": "/x",
        }
    )
    assert env == {"TERM": "tmux-256color", "LANG": "C.UTF-8", "COLORTERM": "truecolor"}
    assert sandbox.sandbox_env(None) == {"TERM": "xterm-256color", "LANG": "C.UTF-8"}


needs_bwrap = pytest.mark.skipif(
    not (os.access(sandbox.BWRAP_BIN, os.X_OK) and os.access(sandbox.TMUX_BIN, os.X_OK)),
    reason="bubblewrap and /usr/bin/tmux needed",
)


def test_sandbox_argv_shape(own_state: str) -> None:
    argv = (
        sandbox.sandboxed(["/usr/bin/tmux", "-S", AGENT_SOCKET, "attach-session", "-t", "$1"])
        if (os.access(sandbox.TMUX_BIN, os.X_OK))
        else pytest.skip("no tmux")
    )
    assert argv[0] == sandbox.BWRAP_BIN
    assert "--die-with-parent" in argv and "--unshare-net" in argv and "--unshare-pid" not in argv
    assert "--new-session" not in argv
    assert argv[-6:] == ["/usr/bin/tmux", "-S", AGENT_SOCKET, "attach-session", "-t", "$1"]
    socket_dir = os.path.dirname(AGENT_SOCKET)
    assert ["--ro-bind", socket_dir, socket_dir, "--"] == argv[-10:-6]
    # Nothing but tmux, its libraries and data is bound; never a shell or a writable path.
    assert "--bind" not in argv and "--dev-bind" not in argv
    assert not any(arg in {"/bin", "/usr/bin", "/usr", "/bin/sh"} for arg in argv)


def test_sandbox_refuses_other_programs_and_sockets() -> None:
    with pytest.raises(ValueError):
        sandbox.sandboxed(["/bin/sh", "-S", AGENT_SOCKET])
    with pytest.raises(ValueError):
        sandbox.sandboxed(["/usr/bin/tmux", "-S", "/tmp/x.sock", "attach-session"])
    with pytest.raises(ValueError):
        sandbox.sandboxed(["/usr/bin/tmux", "attach-session"])


@needs_bwrap
def test_no_shell_or_other_program_exists_inside(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    state = Path(tempfile.mkdtemp(prefix="at-sbx-", dir="/tmp"))
    try:
        monkeypatch.setenv("XDG_STATE_HOME", str(state))
        socket_dir = state / "tether" / "default" / "tmux" / ("ab" * 16)
        socket_dir.mkdir(parents=True)
        argv = sandbox.sandboxed(["/usr/bin/tmux", "-S", str(socket_dir / "server.sock"), "-V"])
        separator = argv.index("--")
        for program in ("/bin/sh", "/usr/bin/sh", "/bin/bash", "/usr/bin/env", "/usr/bin/id"):
            result = subprocess.run(
                [*argv[:separator], "--", program, "-c", "true"], capture_output=True
            )
            assert result.returncode != 0, program
        version = subprocess.run(argv, capture_output=True, text=True, env={"TERM": "xterm"})
        assert version.returncode == 0 and version.stdout.startswith("tmux ")
    finally:
        shutil.rmtree(state, ignore_errors=True)


@needs_bwrap
def test_detach_client_e_cannot_run_a_command_as_the_user(monkeypatch: pytest.MonkeyPatch) -> None:
    """A server asking the sandboxed client to run a command (``detach-client -E``) runs nothing."""
    import pty
    import time

    state = Path(tempfile.mkdtemp(prefix="at-sbx-", dir="/tmp"))
    try:
        monkeypatch.setenv("XDG_STATE_HOME", str(state))
        socket_dir = state / "tether" / "default" / "tmux" / ("cd" * 16)
        socket_dir.mkdir(parents=True)
        socket_path = str(socket_dir / "server.sock")
        tmux = ["tmux", "-S", socket_path]
        subprocess.run(
            [*tmux, "-f", "/dev/null", "new-session", "-d", "-s", "t", "-x", "80", "-y", "24"],
            check=True,
        )
        pid, master = pty.fork()
        if pid == 0:  # pragma: no cover - child
            argv = sandbox.sandboxed(sandbox.attach_argv(_target(socket_path, "t"), socket_path))
            os.execve(argv[0], argv, sandbox.sandbox_env({}))
        try:
            clients = ""
            for _ in range(50):
                clients = subprocess.run(
                    [*tmux, "list-clients", "-F", "#{client_pid}"], capture_output=True, text=True
                ).stdout.strip()
                if clients:
                    break
                time.sleep(0.1)
            assert clients == str(sandbox.client_pid(pid))  # the pid Tether's resize claim names
            marker = state / "pwned"
            subprocess.run([*tmux, "detach-client", "-E", f"touch {marker}"], check=False)
            time.sleep(1)
            assert not marker.exists()
        finally:
            os.close(master)
            subprocess.run([*tmux, "kill-server"], check=False)
            os.waitpid(pid, 0)
    finally:
        shutil.rmtree(state, ignore_errors=True)
