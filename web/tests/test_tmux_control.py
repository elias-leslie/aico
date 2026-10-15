"""tmux control-mode view: protocol parsing, seed building and a real tmux server."""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from a_term.services.tmux_control import (
    SEED_FLAGS,
    ControlProtocol,
    ControlTerminal,
    build_seed,
    control_argv,
    decode_output_value,
    input_commands,
    parse_seed_flags,
    socket_args,
)

# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def _flags(**values: int) -> str:
    defaults = {name: 0 for name in SEED_FLAGS[1:]}
    defaults.update(pane_height=3, cursor_flag=1, wrap_flag=1, scroll_region_lower=2)
    defaults.update(values)
    return " ".join(["%3", *(str(defaults[name]) for name in SEED_FLAGS[1:])])


def test_decode_output_value_unescapes_octal_bytes() -> None:
    assert decode_output_value(b"a\\033[1mb\\134c\\015\\012") == b"a\x1b[1mb\\c\r\n"
    assert decode_output_value("é".encode()) == "é".encode()


def test_parse_seed_flags() -> None:
    flags = parse_seed_flags(_flags(cursor_x=4, alternate_on=1))
    assert flags is not None
    assert flags.pane_id == "%3"
    assert (flags.cursor_x, flags.alternate_on, flags.pane_height) == (4, 1, 3)
    assert parse_seed_flags("%3 1 2") is None
    assert parse_seed_flags(_flags().replace("%3", "3")) is None
    assert parse_seed_flags(_flags().replace(" 0 ", " x ", 1)) is None


def test_build_seed_normal_screen() -> None:
    flags = parse_seed_flags(_flags(cursor_x=2, cursor_y=1, mouse_standard_flag=1, mouse_sgr_flag=1))
    assert flags is not None
    seed = build_seed(flags, ["one", "two"], [])
    assert seed.startswith("\x1bcone\x1b[0m\r\ntwo\x1b[0m")
    assert "\x1b[1;3r" in seed
    assert seed.index("\x1b[2;3H") > seed.index("two")
    assert "\x1b[?1000h" in seed and "\x1b[?1006h" in seed
    assert "\x1b[?1049h" not in seed and "\x1b[?25l" not in seed


def test_build_seed_puts_saved_normal_screen_under_the_alternate_one() -> None:
    flags = parse_seed_flags(_flags(alternate_on=1, alternate_saved_x=1, alternate_saved_y=2, cursor_flag=0))
    assert flags is not None
    seed = build_seed(flags, ["h1", "h2", "a1", "a2", "a3"], ["n0", "n1", "n2", "n3"])
    normal, alt = seed.split("\x1b[?1049h")
    assert "h1" in normal and "h2" in normal and "n1" in normal and "n0" not in normal
    assert "a1" not in normal and "a1" in alt
    assert normal.endswith("\x1b[3;2H")
    assert "\x1b[?25l" in alt


def test_control_argv_and_socket_args() -> None:
    argv = ["/usr/bin/tmux", "-S", "/tmp/s", "attach-session", "-t", "$1"]
    assert control_argv(argv) == ["/usr/bin/tmux", "-C", "-S", "/tmp/s", "attach-session", "-t", "$1", "-f", "pause-after=5"]
    assert socket_args(argv) == ["-S", "/tmp/s"]
    with pytest.raises(ValueError):
        control_argv(["tmux", "new-session"])


def test_input_commands_chunk_as_hex() -> None:
    assert input_commands("%1", b"a\x1b") == ["send-keys -t %1 -H 61 1b"]
    commands = input_commands("%1", b"x" * 1100)
    assert len(commands) == 3 and commands[-1].count(" 78") == 76


def test_protocol_routes_replies_output_and_notifications() -> None:
    outputs: list[tuple[str, bytes]] = []
    pauses: list[str] = []
    exits: list[bool] = []
    protocol = ControlProtocol(lambda p, b: outputs.append((p, b)), pauses.append, lambda: exits.append(True))
    replies: list[list[str]] = []
    protocol.expect(2, lambda blocks: replies.append([line for b in blocks for line in b.lines]))
    stream = (
        b"%begin 1 1 0\n%end 1 1 0\n"  # the session-open block is not ours
        b"%output %1 hi\\012\n"
        b"%begin 2 2 1\nfirst\n%pause %1\n%end not ours\n%end 2 2 1\n"
        b"%begin 3 3 1\n\xc3\xa9\n%end 3 3 1\n"
        b"%extended-output %1 7 : late\n%pause %1\n%exit\n"
    )
    for at in range(0, len(stream), 7):  # arbitrary chunking
        protocol.feed(stream[at : at + 7])
    assert replies == [["first", "%end not ours", "é"]]
    assert outputs == [("%1", b"hi\n"), ("%1", b"late")]
    assert pauses == ["%1"] and exits == [True]


# ---------------------------------------------------------------------------
# Live: a real tmux server
# ---------------------------------------------------------------------------

pytestmark_live = pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux not installed")


@pytest.fixture()
def tmux_server():
    # Unix socket paths must stay short; keep the server under /tmp.
    directory = tempfile.mkdtemp(prefix="aterm-ct-", dir="/tmp")
    sock = str(Path(directory) / "s")
    env = {k: v for k, v in os.environ.items() if k not in {"TMUX", "TMUX_PANE"}}

    def tmux(*args: str) -> str:
        return subprocess.run(["tmux", "-S", sock, *args], capture_output=True, text=True, env=env, check=False).stdout

    tmux("-f", "/dev/null", "new-session", "-d", "-s", "t", "-x", "80", "-y", "24", "bash", "--norc", "--noprofile")
    tmux("set-option", "-g", "history-limit", "50000")
    yield tmux, ["tmux", "-S", sock, "attach-session", "-t", "t"], env
    tmux("kill-server")
    shutil.rmtree(directory, ignore_errors=True)


async def _drain(term: ControlTerminal, quiet: float = 0.6) -> bytes:
    out = b""
    while True:
        try:
            item = await asyncio.wait_for(term.queue.get(), quiet)
        except TimeoutError:
            return out
        if item is None:
            return out
        out += item


async def _until(tmux, text: str, timeout: float = 5.0) -> None:
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while text not in tmux("capture-pane", "-p", "-t", "t", "-S", "-"):
        if loop.time() > end:
            raise AssertionError(f"{text!r} never appeared")
        await asyncio.sleep(0.05)


@pytestmark_live
@pytest.mark.asyncio
async def test_live_seed_carries_history_then_streams_input_and_paste(tmux_server) -> None:
    tmux, argv, env = tmux_server
    tmux("send-keys", "-t", "t", "seq 1 300", "Enter")
    await _until(tmux, "\n300\n")
    term = await ControlTerminal.start(argv, env, 80, 24)
    try:
        assert term.pane_id is not None
        seed = await _drain(term)
        assert seed.startswith(b"\x1bc")
        assert b"\r\n1\x1b[0m" in seed and b"300" in seed  # history and screen

        term.write("echo héllo-$((6*7))\r".encode())
        streamed = await _drain(term)
        assert "héllo-42".encode() in streamed
        assert b"\x1bc" not in streamed  # stream, not a reseed

        await term.paste("line1\nline2")
        await _until(tmux, "line2")
        screen = tmux("capture-pane", "-p", "-t", "t")
        assert "line1" in screen and "line2" in screen
        assert "line1: command not found" not in screen  # bracketed: not run
    finally:
        await term.close()


@pytest.mark.asyncio
@pytestmark_live
async def test_live_alternate_screen_seed_and_resize_reseed(tmux_server) -> None:
    tmux, argv, env = tmux_server
    tmux("send-keys", "-t", "t", "echo before-alt; printf '\\033[?1049h\\033[Halt-screen'; sleep 30", "Enter")
    await _until(tmux, "alt-screen")
    term = await ControlTerminal.start(argv, env, 80, 24)
    try:
        seed = await _drain(term)
        normal, alt = seed.split(b"\x1b[?1049h", 1)
        assert b"before-alt" in normal and b"alt-screen" in alt

        term.resize(100, 30)
        reseed = await _drain(term)
        assert reseed.count(b"\x1bc") == 1
        assert "100" in tmux("list-clients", "-F", "#{client_width}")
    finally:
        await term.close()


@pytest.mark.asyncio
@pytestmark_live
async def test_live_unsized_client_leaves_window_size_and_exit_ends_stream(tmux_server) -> None:
    tmux, argv, env = tmux_server
    term = await ControlTerminal.start(argv, env, 120, 30, sized=False)
    try:
        assert tmux("display-message", "-p", "-t", "t", "#{window_width}").strip() == "80"
        await _drain(term)
        tmux("kill-session", "-t", "t")
        end = await asyncio.wait_for(term.queue.get(), 3)
        while end is not None:
            end = await asyncio.wait_for(term.queue.get(), 3)
        assert term.closed
    finally:
        await term.close()
