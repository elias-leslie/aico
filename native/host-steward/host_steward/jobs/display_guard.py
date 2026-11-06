"""host-steward display-guard (user unit host-steward-display-guard, only while the owner's graphical session runs; GNOME on Wayland).

GNOME blanks the monitor after the session idle delay, but agents driving the desktop (st ui: keys through ydotoold's
uinput device, clicks through the desktop bridge's virtual pointer) send input that counts as activity, so the monitor
stayed on for hours overnight (2026-10-14: 21:20-02:08, 02:24-06:11).
This guard tracks physical input only. GNOME Shell cannot be asked that (Mutter hands key and pointer events for focused
Wayland clients straight to the client, so no shell extension sees them; measured 2026-10-25), so the root unit
host-steward-input-watch (jobs/input_watch.py) reads the kernel's real input devices, not virtual ones like ydotoold's,
and touches its stamp (/run/host-steward-input/physical-input). The guard reads that file's mtime. Once there has been
no input for the idle delay (GNOME's own idle-delay, at least min_idle_s in data/watch.toml) the guard sets mutter's
PowerSaveMode to off. Nothing in GNOME wakes a monitor that was blanked this way (measured 2026-10-25: neither ydotool
nor the owner's own input does; gsd-power only wakes what it blanked itself), so the guard also wakes it: while dark it
polls fast and sets PowerSaveMode back on at the first physical input, at once if the stamp disappears, and on exit.
Agent input does not wake it, which is the point. Screen locking is untouched (agents need the unlocked desktop). It
respects GNOME's setting (idle-delay 0 = never blank) and apps inhibiting idle (video). Without the stamp (input watch
stopped, no devices) it only waits: never blanks on a guess, never exits, so systemd has no crash loop to run.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import os
import re
import signal
import subprocess
import sys
import time
from collections.abc import Callable
from typing import Any

from host_steward.jobs.input_watch import stamp_path
from host_steward.watch_settings import settings

NAME = "display-guard"
HELP = "monitor off after the idle delay without physical input (user unit; agents' injected input does not count)"

DISPLAY_CONFIG = ("org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig")
POWER_ON = 0  # mutter PowerSaveMode values: 0 on, 1 standby, 2 suspend, 3 off
POWER_OFF = 3
PROPERTY_INT = re.compile(r"<(?:int32 )?(-?\d+)>")


def _gdbus(*argv: str) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(
            ["gdbus", "call", "--session", *argv],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None


def _out(*argv: str) -> str:
    done = _gdbus(*argv)
    return done.stdout if done and done.returncode == 0 else ""


def effective_delay(gnome_delay: int, min_idle_s: int) -> int:
    """GNOME's idle delay lifted to min_idle_s; 0 stays 0, the owner chose never to blank."""
    return 0 if gnome_delay == 0 else max(gnome_delay, min_idle_s)


def idle_delay() -> int:
    """The idle delay in seconds the guard waits for; 0 means never blank."""
    floor = int(settings("display-guard")["min_idle_s"])
    try:
        out = subprocess.run(
            ["gsettings", "get", "org.gnome.desktop.session", "idle-delay"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.split()
        return effective_delay(int(out[-1]), floor)
    except (OSError, subprocess.SubprocessError, IndexError, ValueError):
        return floor


def idle_inhibited() -> bool:
    """An app holds an idle inhibitor (GNOME SessionManager flag 8), e.g. a video playing."""
    return "true" in _out(
        "--dest",
        "org.gnome.SessionManager",
        "--object-path",
        "/org/gnome/SessionManager",
        "--method",
        "org.gnome.SessionManager.IsInhibited",
        "8",
    )


def physical_idle(stamp: str | os.PathLike[str] | None = None) -> tuple[float | None, str]:
    """Seconds since the input watch last saw a real device used, or (None, why not)."""
    try:
        return max(0.0, time.time() - os.stat(stamp or stamp_path()).st_mtime), ""
    except FileNotFoundError:
        return None, "input watch is not running (no stamp)"
    except OSError as exc:
        return None, f"stamp unreadable ({type(exc).__name__})"


def _power(*argv: str) -> subprocess.CompletedProcess[str] | None:
    return _gdbus(
        "--dest", DISPLAY_CONFIG[0], "--object-path", DISPLAY_CONFIG[1], "--method", *argv
    )


def monitor_on() -> bool:
    done = _power("org.freedesktop.DBus.Properties.Get", DISPLAY_CONFIG[0], "PowerSaveMode")
    m = PROPERTY_INT.search(done.stdout) if done and done.returncode == 0 else None
    return bool(m) and int(m.group(1)) == POWER_ON


def set_power(mode: int) -> bool:
    done = _power(
        "org.freedesktop.DBus.Properties.Set", DISPLAY_CONFIG[0], "PowerSaveMode", f"<int32 {mode}>"
    )
    return bool(done) and done.returncode == 0


def blank_monitor() -> bool:
    return set_power(POWER_OFF)


def wake_monitor() -> bool:
    return set_power(POWER_ON)


class Guard:
    def __init__(self, poll_s: float | None = None) -> None:
        self.poll_s = float(settings("display-guard")["poll_s"]) if poll_s is None else poll_s
        self.idle: float | None = (
            None  # physical idle seconds at the last poll; None while the input watch cannot say
        )
        self.announced = False  # already reported a blank in this stretch without the owner
        self.dark = False  # the guard blanked the monitor and has not woken it
        self.decided = float("-inf")  # monotonic time of the last full decision

    def tick(self, idle: float | None, now: float) -> bool:
        """Blank the monitor when nobody has touched a real device for the idle delay; wake it when somebody does.

        True when it blanked the first time in a stretch without the owner (agent input leaves the monitor dark, but
        a monitor something else woke is blanked again, and that is not news).
        """
        moved = idle is not None and self.idle is not None and idle < self.idle
        self.idle = idle
        if idle is None or moved:
            self.announced = False
        if (
            self.dark and (idle is None or moved) and wake_monitor()
        ):  # owner back, or nobody can tell: never stay dark
            self.dark = False
        if (
            self.dark and now - self.decided < self.poll_s
        ):  # fast polling only watches for the owner
            return False
        self.decided = now
        delay = idle_delay()
        if idle is None or not delay or idle < delay:
            return False
        if not monitor_on():
            return False
        self.dark = False  # it is on, whoever woke it
        if idle_inhibited():
            return False
        if not blank_monitor():
            print("display-guard: could not set PowerSaveMode")
            return False
        first, self.announced, self.dark = not self.announced, True, True
        return first


def run() -> int:
    cfg = settings("display-guard")
    poll_s, dark_poll_s = float(cfg["poll_s"]), float(cfg["dark_poll_s"])
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))  # systemd stop: still wake the monitor
    with contextlib.suppress(ValueError, OSError):
        if isinstance(sys.stdout, io.TextIOWrapper):
            sys.stdout.reconfigure(line_buffering=True)
    g = Guard(poll_s)
    unavailable = None
    try:
        while True:
            now = time.monotonic()
            idle, why = physical_idle()
            if why != unavailable:  # one line per change, not per poll
                unavailable = why
                print(
                    f"display-guard: cannot read physical input ({why}); not blanking"
                    if why
                    else "display-guard: reading physical input from the input watch"
                )
            if g.tick(idle, now):
                print(f"display-guard: no physical input for {int(idle or 0)} s; monitor off")
            time.sleep(dark_poll_s if g.dark else poll_s)
    finally:
        if g.dark:
            wake_monitor()


def add_args(parser: argparse.ArgumentParser) -> None:
    del parser


def main(
    args: argparse.Namespace, data: dict[str, Any], post: Callable[..., bool] | None = None
) -> int:
    del args, data, post
    with contextlib.suppress(KeyboardInterrupt):
        return run()
    return 0
