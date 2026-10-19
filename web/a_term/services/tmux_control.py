"""Control-mode terminal view: the browser's xterm reads the pane's own output.

With a plain ``tmux attach``, xterm only ever sees a tmux client repainting
its screen from inside the alternate screen, so it holds no scrollback and
none of the program's modes; history had to come from tmux pages in an
overlay. In control mode (``tmux -C``) tmux streams each pane's raw output
(``%output``), so xterm parses exactly what the program wrote: native
scrollback, native selection and the program's real mouse/alt-screen state.

On attach (and after a resize, a backlog pause or a refresh) the view reads
the pane in one atomic tmux command list -- mode flags, history plus screen,
and the saved normal screen under an alternate one -- and sends it ahead of
the stream as a terminal reset plus repaint. Output tmux sends before that
list's last ``%end`` is already in the captures and is dropped; output after
it is newer and follows the seed.

Ported from Aico's ``electron/main/tmux-control.ts``.
"""

from __future__ import annotations

import asyncio
import contextlib
import re
from collections.abc import Callable, Collection
from dataclasses import dataclass, field

from ..logging_config import get_logger
from .tmux_sandbox import client_pid, sandboxed

logger = get_logger(__name__)

__all__ = [
    "SEED_FLAGS",
    "SEED_HISTORY_LINES",
    "ControlProtocol",
    "ControlTerminal",
    "SeedFlags",
    "build_seed",
    "control_argv",
    "decode_output_value",
    "input_commands",
    "parse_seed_flags",
]

# History lines carried into xterm on attach. The browser sizes its scrollback
# from this (sent with the transport message), so this is the only copy.
SEED_HISTORY_LINES = 20_000
# Seconds tmux may fall behind before it pauses the pane (then we reseed).
PAUSE_AFTER_SECONDS = 5
# Wait after the last resize before re-reading the pane from tmux.
RESEED_AFTER_RESIZE_SECONDS = 0.3
# Bytes per send-keys command; keeps each command line short.
INPUT_CHUNK_BYTES = 512
# How long start() waits for the first seed before streaming without one.
FIRST_SEED_TIMEOUT_SECONDS = 5.0

ESC = "\x1b"

# Pane state read with every seed, in this order.
SEED_FLAGS = (
    "pane_id",
    "pane_height",
    "alternate_on",
    "alternate_saved_x",
    "alternate_saved_y",
    "cursor_x",
    "cursor_y",
    "cursor_flag",
    "insert_flag",
    "keypad_cursor_flag",
    "keypad_flag",
    "wrap_flag",
    "origin_flag",
    "mouse_standard_flag",
    "mouse_button_flag",
    "mouse_any_flag",
    "mouse_sgr_flag",
    "scroll_region_upper",
    "scroll_region_lower",
)

_PANE_ID = re.compile(r"^%\d+$")
_PAUSE_OR_CONTINUE = re.compile(rb"^%(pause|continue) %\d+$")
_OCTAL = re.compile(rb"\\([0-7]{3})")


@dataclass(frozen=True)
class SeedFlags:
    pane_id: str
    values: dict[str, int]

    def __getattr__(self, name: str) -> int:
        try:
            return self.values[name]
        except KeyError as error:
            raise AttributeError(name) from error


def parse_seed_flags(line: str) -> SeedFlags | None:
    parts = line.strip().split(" ")
    if len(parts) != len(SEED_FLAGS) or not _PANE_ID.match(parts[0]):
        return None
    values: dict[str, int] = {}
    for name, raw in zip(SEED_FLAGS[1:], parts[1:], strict=True):
        if not raw.isdigit():
            return None
        values[name] = int(raw)
    return SeedFlags(parts[0], values)


def decode_output_value(value: bytes) -> bytes:
    """Decode a ``%output`` value: tmux escapes control bytes and backslash as \\ooo."""
    return _OCTAL.sub(lambda m: bytes([int(m.group(1), 8) & 0xFF]), value)


def build_seed(flags: SeedFlags, screen_and_history: list[str], saved_normal: list[str]) -> str:
    """The pane's terminal state as one string for xterm.

    A full reset, the history and screen (with the saved normal screen under
    an alternate one), then the cursor and the modes tmux reports. Lines
    arrive as tmux printed them with -e (one row each, colour escapes kept).
    """

    def lines(rows: list[str]) -> str:
        return "\r\n".join(f"{row}{ESC}[0m" for row in rows)

    rows = flags.pane_height
    seed = f"{ESC}c"
    if flags.alternate_on:
        split = max(0, len(screen_and_history) - rows)
        history = screen_and_history[:split]
        alt_screen = screen_and_history[split:]
        normal = saved_normal[-rows:] if rows else []
        seed += lines([*history, *normal])
        seed += f"{ESC}[{flags.alternate_saved_y + 1};{flags.alternate_saved_x + 1}H"
        seed += f"{ESC}[?1049h{ESC}[H"
        seed += lines(alt_screen)
    else:
        seed += lines(screen_and_history)
    seed += f"{ESC}[0m{ESC}[{flags.scroll_region_upper + 1};{flags.scroll_region_lower + 1}r"
    if flags.origin_flag:
        seed += f"{ESC}[?6h"
    seed += f"{ESC}[{flags.cursor_y + 1};{flags.cursor_x + 1}H"
    if not flags.cursor_flag:
        seed += f"{ESC}[?25l"
    if not flags.wrap_flag:
        seed += f"{ESC}[?7l"
    if flags.insert_flag:
        seed += f"{ESC}[4h"
    if flags.keypad_cursor_flag:
        seed += f"{ESC}[?1h"
    if flags.keypad_flag:
        seed += f"{ESC}="
    if flags.mouse_standard_flag:
        seed += f"{ESC}[?1000h"
    if flags.mouse_button_flag:
        seed += f"{ESC}[?1002h"
    if flags.mouse_any_flag and not flags.mouse_standard_flag and not flags.mouse_button_flag:
        seed += f"{ESC}[?1003h"
    if flags.mouse_sgr_flag:
        seed += f"{ESC}[?1006h"
    return seed


def control_argv(attach_argv: list[str]) -> list[str]:
    """``tmux … attach-session -t X`` as a control-mode client."""
    at = next((i for i, arg in enumerate(attach_argv) if arg in {"attach-session", "attach"}), -1)
    if at < 1:
        raise ValueError("attach argv has no attach-session command")
    return [attach_argv[0], "-C", *attach_argv[1:], "-f", f"pause-after={PAUSE_AFTER_SECONDS}"]


def socket_args(argv: list[str]) -> list[str]:
    """The ``-S socket`` / ``-L name`` arguments of a tmux argv."""
    out: list[str] = []
    for i in range(1, len(argv) - 1):
        if argv[i] in {"-S", "-L"}:
            out.extend(argv[i : i + 2])
    return out


def input_commands(pane_id: str, data: bytes) -> list[str]:
    """send-keys commands typing ``data`` into ``pane_id`` as hex key codes."""
    return [
        f"send-keys -t {pane_id} -H " + " ".join(f"{b:02x}" for b in data[at : at + INPUT_CHUNK_BYTES])
        for at in range(0, len(data), INPUT_CHUNK_BYTES)
    ]


@dataclass
class Block:
    lines: list[str] = field(default_factory=list)
    error: bool = False


BlockHandler = Callable[[Block], None] | None


class ControlProtocol:
    """Line protocol of a control client: replies (%begin…%end/%error) and notifications.

    Every command we send produces one reply block flagged 1; the block tmux
    opens the session with (flag 0) is not ours. Reply lines are raw UTF-8 and
    could look like ``%end``, so a block only closes on the ``%end``/``%error``
    that repeats its ``%begin`` header.
    """

    def __init__(
        self,
        on_output: Callable[[str, bytes], None],
        on_pause: Callable[[str], None],
        on_exit: Callable[[], None],
    ) -> None:
        self._on_output = on_output
        self._on_pause = on_pause
        self._on_exit = on_exit
        self._buffer = b""
        self._block: Block | None = None
        self._block_tail = b""
        self._block_ours = False
        self._block_notifies = False
        # One (handler, reply may carry %pause/%continue) per expected reply.
        self._handlers: list[tuple[BlockHandler, bool]] = []

    def expect(
        self,
        count: int,
        handler: Callable[[list[Block]], None] | None = None,
        notifying: Collection[int] = (),
    ) -> None:
        """Register reply handlers for a command list of ``count`` commands.

        ``notifying`` lists the commands (by index) whose reply tmux can
        interleave a pane's %pause/%continue into (``refresh-client -A``).
        """
        if handler is None:
            self._handlers.extend((None, i in notifying) for i in range(count))
            return
        blocks: list[Block] = []

        def collect(block: Block) -> None:
            blocks.append(block)
            if len(blocks) == count:
                handler(blocks)

        self._handlers.extend((collect, i in notifying) for i in range(count))

    def feed(self, chunk: bytes) -> None:
        self._buffer += chunk
        *lines, self._buffer = self._buffer.split(b"\n")
        for line in lines:
            self._line(line)

    def _line(self, raw: bytes) -> None:
        if self._block is not None:
            if raw.startswith((b"%end ", b"%error ")) and raw.split(b" ", 1)[1] == self._block_tail:
                done = self._block
                self._block = None
                done.error = raw.startswith(b"%error ")
                # Handlers run here, before the next line is parsed, so a
                # handler can switch how the output after its reply is treated.
                if self._block_ours and self._handlers:
                    handler, _ = self._handlers.pop(0)
                    if handler is not None:
                        handler(done)
                return
            # tmux can report a pause/continue from inside the reply of the
            # command that caused it; neither is reply text. Elsewhere (a
            # capture) the same text is pane content.
            if self._block_notifies and _PAUSE_OR_CONTINUE.match(raw):
                return
            self._block.lines.append(raw.decode("utf-8", errors="replace"))
            return
        if raw.startswith(b"%begin "):
            self._block = Block()
            self._block_tail = raw.split(b" ", 1)[1]
            fields = raw.split(b" ")
            self._block_ours = len(fields) > 3 and fields[3] == b"1"
            self._block_notifies = self._block_ours and bool(self._handlers) and self._handlers[0][1]
            return
        if raw.startswith(b"%output "):
            space = raw.find(b" ", 8)
            if space > 0:
                self._on_output(raw[8:space].decode("ascii", "replace"), decode_output_value(raw[space + 1 :]))
            return
        if raw.startswith(b"%extended-output "):
            colon = raw.find(b" : ")
            if colon > 0:
                pane = raw.split(b" ")[1].decode("ascii", "replace")
                self._on_output(pane, decode_output_value(raw[colon + 3 :]))
            return
        if raw.startswith(b"%pause "):
            self._on_pause(raw[7:].strip().decode("ascii", "replace"))
            return
        if raw.startswith(b"%exit"):
            self._on_exit()


class ControlTerminal:
    """One view's tmux control-mode client.

    Output (seed, then the pane's raw bytes) goes to ``queue``; ``None`` marks
    the end. ``pid`` is the control client's pid, which Tether's resize claim
    accepts like any other client's.
    """

    def __init__(
        self,
        process: asyncio.subprocess.Process,
        attach_argv: list[str],
        env: dict[str, str],
        cols: int,
        rows: int,
        queue: asyncio.Queue[bytes | None],
        sandbox: bool = False,
    ) -> None:
        self._process = process
        self._attach_argv = attach_argv
        self._sandbox = sandbox
        self.client_pid = process.pid  # the sandbox's tmux child, once known (see start)
        self._env = env
        self.cols = cols
        self.rows = rows
        self.queue = queue
        self.pane_id: str | None = None
        self._phase = "starting"  # starting | seeding | live | closed
        self._reseed_queued: bool | None = None  # pending reseed's continue flag
        self._reseed_handle: asyncio.TimerHandle | None = None
        self._ready = asyncio.Event()
        self._pending: list[bytes | None] = []
        self._paste_seq = 0
        self._protocol = ControlProtocol(self._output, self._pause, self._exit)
        self._reader = asyncio.create_task(self._read())

    @classmethod
    async def start(
        cls,
        attach_argv: list[str],
        env: dict[str, str],
        cols: int,
        rows: int,
        cwd: str | None = None,
        sized: bool = True,
        sandbox: bool = False,
    ) -> ControlTerminal:
        """Start the client and wait (briefly) for its first seed.

        An unsized client (``sized=False``: a view that must not size the
        window) sends no ``refresh-client -C``, so tmux ignores its size.
        """
        argv = control_argv(attach_argv)
        if sandbox:
            argv, cwd = sandboxed(argv), None
        process = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=env,
            cwd=cwd,
        )
        term = cls(process, attach_argv, env, cols, rows, asyncio.Queue(maxsize=256), sandbox)
        try:
            if sandbox:
                term.client_pid = await asyncio.to_thread(client_pid, process.pid)
            if sized:
                term._send([f"refresh-client -C {cols}x{rows}"])
            else:
                term.cols = term.rows = 0  # the first real size is always sent
            term.reseed()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(term._ready.wait(), FIRST_SEED_TIMEOUT_SECONDS)
        except BaseException:
            # Cancelled before the caller owns it: nobody else would close it.
            await asyncio.shield(term.close())
            raise
        return term

    @property
    def pid(self) -> int:
        return self._process.pid

    @property
    def closed(self) -> bool:
        return self._phase == "closed"

    def write(self, data: bytes) -> None:
        if self.pane_id and data:
            self._send(input_commands(self.pane_id, data))

    async def paste(self, text: str) -> None:
        """Paste through tmux, which brackets it only when the program asked (2004)."""
        if not self.pane_id or self.closed or not text:
            return
        self._paste_seq += 1
        name = f"a-term-paste-{self.pid}-{self._paste_seq}"
        load_argv = [self._attach_argv[0], *socket_args(self._attach_argv), "load-buffer", "-b", name, "-"]
        if self._sandbox:
            load_argv = sandboxed(load_argv)
        load = await asyncio.create_subprocess_exec(
            *load_argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            env=self._env,
        )
        await load.communicate(text.encode("utf-8"))
        if load.returncode == 0:
            self._send([f"paste-buffer -p -d -b {name} -t {self.pane_id}"])

    def resize(self, cols: int, rows: int) -> None:
        if (cols, rows) == (self.cols, self.rows):
            return
        self.cols, self.rows = cols, rows
        self._send([f"refresh-client -C {cols}x{rows}"])
        # tmux and xterm rewrap old lines differently; once the size settles,
        # take the pane from tmux again so the two agree.
        if self._reseed_handle is not None:
            self._reseed_handle.cancel()
        self._reseed_handle = asyncio.get_running_loop().call_later(RESEED_AFTER_RESIZE_SECONDS, self.reseed)

    def reseed(self, continue_pane: bool = False) -> None:
        """Re-read the pane from tmux and repaint the terminal from it."""
        if self._phase == "closed":
            return
        if self._phase == "seeding":
            self._reseed_queued = continue_pane or bool(self._reseed_queued)
            return
        self._phase = "seeding"
        fmt = " ".join(f"#{{{name}}}" for name in SEED_FLAGS)
        history = f"-S -{SEED_HISTORY_LINES}"
        resume = [f"refresh-client -A '{self.pane_id}:continue'"] if continue_pane and self.pane_id else []
        commands = [
            *resume,
            f"display-message -p '{fmt}'",
            f"capture-pane -p -e {history} -E -",
            f"capture-pane -p -e -q -a {history} -E -",
            # The start of an escape sequence the pane has not finished yet:
            # its end streams after the seed and must not land as text.
            "capture-pane -p -P",
        ]
        seed_at = len(resume)

        # Runs on the list's last %end: output parsed after it is newer than
        # the captures and streams straight after the seed.
        def on_reply(blocks: list[Block]) -> None:
            flags_block, main_block, alt_block, partial_block = blocks[seed_at:]
            flags = None if flags_block.error else parse_seed_flags(flags_block.lines[0] if flags_block.lines else "")
            if flags is None or main_block.error:
                self._go_live("")  # pane not readable: stream rather than stall
                return
            self.pane_id = flags.pane_id
            seed = build_seed(flags, main_block.lines, [] if alt_block.error else alt_block.lines)
            partial = "" if partial_block.error else "".join(partial_block.lines)
            self._go_live(seed + partial)

        self._send_list(commands, on_reply, notifying=range(len(resume)))

    async def close(self) -> None:
        if self._phase != "closed":
            self._phase = "closed"
            if self._reseed_handle is not None:
                self._reseed_handle.cancel()
            with contextlib.suppress(Exception):
                self._process.stdin.close()  # type: ignore[union-attr]
        # Stop the reader first: it may be blocked on a full queue, and an
        # unread stdout pipe can keep the client from exiting.
        self._reader.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._reader
        if self._process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), 1.0)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    self._process.kill()
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._process.wait(), 1.0)

    # -- internals ---------------------------------------------------------

    def _go_live(self, seed: str) -> None:
        if self._phase == "closed":
            return
        if seed:
            self._pending.append(seed.encode("utf-8"))
        self._phase = "live"
        self._ready.set()
        queued, self._reseed_queued = self._reseed_queued, None
        if queued is not None:
            self.reseed(queued)

    def _output(self, pane_id: str, data: bytes) -> None:
        # While seeding, these bytes are already in the captures being read.
        if self._phase == "live" and pane_id == self.pane_id and data:
            self._pending.append(data)

    def _pause(self, pane_id: str) -> None:
        if pane_id == self.pane_id:
            self.reseed(continue_pane=True)

    def _exit(self) -> None:
        self._phase = "closed"

    def _send(self, commands: list[str]) -> None:
        for command in commands:
            self._send_list([command])

    def _send_list(
        self,
        commands: list[str],
        handler: Callable[[list[Block]], None] | None = None,
        notifying: Collection[int] = (),
    ) -> None:
        stdin = self._process.stdin
        if self._phase == "closed" or stdin is None or stdin.is_closing():
            return
        self._protocol.expect(len(commands), handler, notifying)
        stdin.write((" ; ".join(commands) + "\n").encode("utf-8"))

    async def _read(self) -> None:
        stdout = self._process.stdout
        assert stdout is not None
        try:
            while True:
                chunk = await stdout.read(65536)
                if not chunk:
                    break
                self._protocol.feed(chunk)
                pending, self._pending = self._pending, []
                for item in pending:
                    # Blocks while the browser falls behind; tmux then pauses
                    # the pane after PAUSE_AFTER_SECONDS and we reseed.
                    await self.queue.put(item)
                if self._phase == "closed":
                    break
        except Exception as error:  # pragma: no cover - defensive
            logger.warning("tmux_control_read_error", error=str(error))
        finally:
            self._phase = "closed"
            self._ready.set()
        await self.queue.put(None)
