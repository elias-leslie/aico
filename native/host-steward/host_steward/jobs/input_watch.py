"""host-steward input-watch (root system unit host-steward-input-watch): stamps when the owner last used a physical input device.

The display guard (jobs/display_guard.py) needs to know when a person last touched a keyboard or mouse. GNOME on Wayland
cannot say: Mutter hands key and pointer events for focused client windows straight to the client, so nothing inside the
shell sees them, and agents' input (ydotoold's uinput device, the desktop bridge's virtual pointer) counts as activity.
The kernel can: every real device is an /dev/input/eventN node, and injected input comes from a virtual device.

This service opens every event node whose sysfs device is not virtual, waits for them with select(), and touches the
stamp (at most once a second) when one reports a key, button, or movement. It never keeps what it reads: the bytes are
not stored or logged, only their event type is looked at, and the only output is the stamp file's mtime.
The stamp is created when the first device is watched and removed when none is, and its directory is the unit's runtime
directory, so it vanishes when the watch stops: a missing stamp means "unknown", never "idle".
Port of Nightshift's input_watch; stdlib only, the unit keeps its sandbox (no network, no home, read-only /dev/input).
"""

from __future__ import annotations

import argparse
import contextlib
import ctypes
import ctypes.util
import os
import select
import signal
import struct
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from host_steward.watch_settings import settings

NAME = "input-watch"
HELP = "stamp when a physical keyboard or mouse was last used (root unit; display-guard reads it)"

INPUT_DIR = Path("/dev/input")
SYS_INPUT = Path("/sys/class/input")
EV_KEY, EV_REL, EV_ABS = (
    0x01,
    0x02,
    0x03,
)  # linux/input-event-codes.h: keys and buttons, relative and absolute movement
HUMAN = (EV_KEY, EV_REL, EV_ABS)
EVENT = struct.Struct(
    "@llHHi"
)  # struct input_event on 64-bit Linux: timeval (2 longs), type, code, value
IN_CREATE, IN_ATTRIB = 0x100, 0x4
# Bluetooth keyboards and mice are userspace-created (uhid) devices, so they sit under /devices/virtual too.
PHYSICAL_VIRTUAL = "/devices/virtual/misc/uhid/"


def stamp_path() -> Path:
    return Path(settings("input-watch")["stamp"])


def is_physical(sysdir: Path) -> bool:
    """A device someone can touch: its sysfs path is not under /devices/virtual (uinput, ydotoold), uhid aside."""
    try:
        real = os.path.realpath(sysdir).removeprefix("/sys")
    except OSError:
        return False
    return not real.startswith("/devices/virtual/") or real.startswith(PHYSICAL_VIRTUAL)


def physical_nodes() -> list[Path]:
    return [INPUT_DIR / link.name for link in sorted(SYS_INPUT.glob("event*")) if is_physical(link)]


def human_events(data: bytes) -> bool:
    """True when the read bytes hold a key, button, or movement event (sync, misc, switch and LED events are not)."""
    return any(
        EVENT.unpack_from(data, i)[2] in HUMAN
        for i in range(0, len(data) - EVENT.size + 1, EVENT.size)
    )


def _inotify(path: Path) -> int | None:
    try:
        libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6", use_errno=True)
        fd = libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        if fd >= 0 and libc.inotify_add_watch(fd, os.fsencode(path), IN_CREATE | IN_ATTRIB) >= 0:
            return fd
        if fd >= 0:
            os.close(fd)
    except (OSError, AttributeError):
        pass
    return None


class Watch:
    def __init__(self, stamp: Path | None = None) -> None:
        cfg = settings("input-watch")
        self.stamp = stamp or stamp_path()
        self.touch_every = float(cfg["touch_every_s"])
        self.rescan = float(cfg["rescan_s"])
        self.fds: dict[int, Path] = {}  # open event node -> its path
        self.touched = float("-inf")
        self.listed = float("-inf")

    def scan(self, now: float) -> None:
        """Open nodes that appeared, forget ones that went; the stamp exists only while something is watched."""
        self.listed = now
        want = set(physical_nodes())
        for fd, path in list(self.fds.items()):
            if path not in want:
                self.drop(fd)
        have = set(self.fds.values())
        for path in want - have:
            try:
                self.fds[os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)] = path
            except OSError:
                continue  # not readable yet, or gone again; the next scan retries
        if not self.fds:
            with contextlib.suppress(OSError):
                self.stamp.unlink()
            self.touched = float("-inf")

    def drop(self, fd: int) -> None:
        self.fds.pop(fd, None)
        with contextlib.suppress(OSError):
            os.close(fd)

    def touch(self, now: float, force: bool = False) -> None:
        if not force and now - self.touched < self.touch_every:
            return
        self.touched = now
        try:
            if self.stamp.is_symlink():
                self.stamp.unlink()
            fd = os.open(self.stamp, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
        except OSError as exc:
            print(f"input-watch: cannot write the stamp: {type(exc).__name__}", flush=True)
            return
        try:
            os.utime(fd)
        finally:
            os.close(fd)

    def handle(self, fd: int, now: float) -> None:
        try:
            data = os.read(fd, EVENT.size * 64)
        except BlockingIOError:
            return
        except OSError:  # the device was unplugged
            self.drop(fd)
            return
        if human_events(data):  # looked at for its type only, then discarded
            self.touch(now)

    def step(self, ready: list[int], now: float) -> None:
        for fd in ready:
            if fd in self.fds:
                self.handle(fd, now)

    def run(self) -> None:
        notify = _inotify(INPUT_DIR)
        was = 0
        try:
            while True:
                now = time.monotonic()
                if now - self.listed >= self.rescan:
                    self.scan(now)
                    if (
                        self.fds and not was
                    ):  # the first device: the stamp starts at "just now", never at a stale time
                        self.touch(now, force=True)
                    if len(self.fds) != was:
                        print(
                            f"input-watch: watching {len(self.fds)} physical input devices",
                            flush=True,
                        )
                    was = len(self.fds)
                waits: list[int] = [*self.fds, *([notify] if notify is not None else [])]
                try:
                    ready, _, _ = select.select(
                        waits, [], [], max(0.1, self.rescan - (now - self.listed))
                    )
                except (OSError, ValueError):  # a descriptor closed under us
                    self.listed = float("-inf")
                    continue
                if notify is not None and notify in ready:
                    with contextlib.suppress(OSError):
                        os.read(notify, 4096)
                    self.listed = float("-inf")  # something appeared in /dev/input: look again now
                    time.sleep(0.2)  # let udev finish the node's group before the open
                self.step([fd for fd in ready if fd != notify], time.monotonic())
        finally:
            with contextlib.suppress(OSError):
                self.stamp.unlink()


def add_args(parser: argparse.ArgumentParser) -> None:
    del parser


def main(
    args: argparse.Namespace, data: dict[str, Any], post: Callable[..., bool] | None = None
) -> int:
    del args, data, post
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    with contextlib.suppress(KeyboardInterrupt):
        Watch().run()
    return 0
