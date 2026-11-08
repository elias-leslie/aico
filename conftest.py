"""No test deletes or moves anything outside a temp folder, whatever config or clock it runs with.

Added after a test ran the real scratch sweep on the real disk. An audit hook sees every delete
Python makes, including through mocks of everything else, and refuses before it happens.
"""

import os
import re
import shutil
import sys
import tempfile

ROOTS = tuple(os.path.realpath(p) for p in (tempfile.gettempdir(), "/tmp", "/var/tmp", "/dev/shm"))
PYTEST_OWN = ("/__pycache__/", "/.pytest_cache/", "/.ruff_cache/")
REAL_NEVER = frozenset("sudo systemctl ssh scp rsync qm pct reboot shutdown poweroff podman docker tmux pkill killall btrfs restic rclone apt-get snap runuser journalctl".split())
SHELLS = frozenset({"sh", "bash", "dash"})
WRAPPERS = frozenset({"env", "nice", "ionice", "nohup", "timeout", "setsid"})
WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND


def in_temp(real: str) -> bool:
    return any(real == root or real.startswith(root + "/") for root in ROOTS)


def refuse_outside_temp(path: str | bytes | os.PathLike[str] | int, what: str) -> None:
    if isinstance(path, int):
        return
    # The parent resolves links; the entry itself may be a link being removed, and only the link goes.
    raw = os.fsdecode(path)
    full = os.path.abspath(raw)
    # A trailing slash or a ".." walks through the link, so then the target is what gets hit.
    through = raw.endswith(("/", "/.")) or ".." in raw.split("/")
    real = os.path.realpath(raw) if through else os.path.join(os.path.realpath(os.path.dirname(full)), os.path.basename(full))
    if in_temp(real):
        return
    if any(part in real + "/" for part in PYTEST_OWN):
        return
    raise PermissionError(f"A test tried {what} on {real}, outside a temp folder.")


def refuse_script(script: str) -> None:
    """A one-liner a shell or wrapper will run: any blocked tool it names, anywhere in it, unless a fake in temp."""
    words = re.findall(r"[\w./+=@:~-]+", script)
    named = {os.path.basename(w) for w in words if not (os.path.isabs(w) and in_temp(os.path.realpath(w)))}
    if named & REAL_NEVER:
        raise PermissionError(f"A test tried to run the real {sorted(named & REAL_NEVER)[0]} through a shell.")
    if "rm" in named:
        for word in words:
            if os.path.isabs(word):
                refuse_outside_temp(word, "rm")


def refuse_spawn(program: str | bytes | None, argv: list, cwd: str | bytes | None, env: dict | None) -> None:
    exe = os.fsdecode(program or "")
    found = shutil.which(exe, path=(env or os.environ).get("PATH", os.defpath)) or exe
    if os.path.exists(found) and in_temp(os.path.realpath(found)):
        return  # A fake the test wrote.
    name = os.path.basename(exe)
    words = [os.fsdecode(word) if isinstance(word, bytes) else str(word) for word in argv[1:]]
    if name == "rm":
        for word in words:
            if not word.startswith("-"):
                refuse_outside_temp(os.path.join(os.fsdecode(cwd or os.getcwd()), word), "rm")
    elif name in REAL_NEVER:
        raise PermissionError(f"A test tried to run the real {name}; stub it or put a fake in a temp folder.")
    elif name in WRAPPERS:
        refuse_script(" ".join(words))
    elif name in SHELLS:
        flags = [i for i, word in enumerate(words[:-1]) if re.fullmatch(r"-[a-z]*c[a-z]*", word)]
        if flags:
            refuse_script(words[flags[0] + 1])


def guard(event: str, args: tuple) -> None:
    if event in ("os.remove", "os.rmdir", "shutil.rmtree"):
        if args[-1] in (None, -1):  # With a dir_fd it is inside an rmtree already checked.
            refuse_outside_temp(args[0], event)
    elif event == "os.rename":  # Also fires for os.replace; the destination is overwritten.
        if args[2] in (None, -1):
            refuse_outside_temp(args[0], event)
        if args[3] in (None, -1):
            refuse_outside_temp(args[1], event)
    elif event == "open":
        path, flags = args[0], args[2]
        writes = isinstance(path, (str, bytes, os.PathLike)) and isinstance(flags, int) and flags & WRITE_FLAGS
        # Absolute paths only: the hook can't see a dir_fd, so a bare name may be a lock in a folder already open.
        if writes and os.path.isabs(os.fsdecode(path)) and not os.fsdecode(path).startswith(("/dev/", "/proc/")):
            refuse_outside_temp(path, "writing")
    elif event == "subprocess.Popen":
        refuse_spawn(args[0], list(args[1]), args[2], args[3])
    elif event in ("os.exec", "os.posix_spawn"):
        refuse_spawn(args[0], list(args[1]), None, args[2])
    elif event == "os.system":
        refuse_script(os.fsdecode(args[0]))


# A plain `tmux` inside a session reaches that session's server through $TMUX: tests never inherit it.
os.environ.pop("TMUX", None)
os.environ.pop("TMUX_PANE", None)
sys.addaudithook(guard)
