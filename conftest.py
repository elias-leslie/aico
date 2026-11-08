"""No test deletes or moves anything outside a temp folder, whatever config or clock it runs with.

Added after a test ran the real scratch sweep on the real disk. An audit hook sees every delete
Python makes, including through mocks of everything else, and refuses before it happens.
"""

import os
import sys
import tempfile

ROOTS = tuple(os.path.realpath(p) for p in (tempfile.gettempdir(), "/tmp", "/var/tmp", "/dev/shm"))
PYTEST_OWN = ("/__pycache__/", "/.pytest_cache/", "/.ruff_cache/")
REAL_NEVER = frozenset("sudo systemctl ssh scp rsync qm pct reboot shutdown poweroff podman docker tmux pkill killall".split())
SHELLS = frozenset({"sh", "bash", "dash"})


def in_temp(real: str) -> bool:
    return any(real == root or real.startswith(root + "/") for root in ROOTS)


def refuse_outside_temp(path: str | bytes | os.PathLike[str] | int, what: str) -> None:
    if isinstance(path, int):
        return
    # The parent resolves links; the entry itself may be a link being removed, and only the link goes.
    full = os.path.abspath(os.fsdecode(path))
    real = os.path.join(os.path.realpath(os.path.dirname(full)), os.path.basename(full))
    if in_temp(real):
        return
    if any(part in real + "/" for part in PYTEST_OWN):
        return
    raise PermissionError(f"A test tried {what} on {real}, outside a temp folder.")


def guard(event: str, args: tuple) -> None:
    if event in ("os.remove", "os.rmdir", "shutil.rmtree"):
        if args[-1] in (None, -1):  # With a dir_fd it is inside an rmtree already checked.
            refuse_outside_temp(args[0], event)
    elif event == "os.rename":
        if args[2] in (None, -1):
            refuse_outside_temp(args[0], event)
    elif event == "subprocess.Popen":
        exe = os.fsdecode(args[0] or "")
        name = os.path.basename(exe)
        if name == "rm":
            for word in args[1][1:]:
                if not str(word).startswith("-"):
                    refuse_outside_temp(os.path.join(os.fsdecode(args[2] or os.getcwd()), str(word)), "rm")
        elif name in REAL_NEVER and not (os.path.isabs(exe) and in_temp(os.path.realpath(exe))):
            raise PermissionError(f"A test tried to run the real {name}; stub it or put a fake in a temp folder.")
        elif name in SHELLS and "-c" in args[1]:
            named = {os.path.basename(word) for word in str(args[1][-1]).split()} & REAL_NEVER
            if named:
                raise PermissionError(f"A test tried to run the real {sorted(named)[0]} through a shell.")


# A plain `tmux` inside a session reaches that session's server through $TMUX: tests never inherit it.
os.environ.pop("TMUX", None)
os.environ.pop("TMUX_PANE", None)
sys.addaudithook(guard)
