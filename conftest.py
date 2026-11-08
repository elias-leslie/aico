"""No test deletes or moves anything outside a temp folder, whatever config or clock it runs with.

Added after a test ran the real scratch sweep on the real disk. An audit hook sees every delete
Python makes, including through mocks of everything else, and refuses before it happens.
"""

import os
import sys
import tempfile

ROOTS = tuple(os.path.realpath(p) for p in (tempfile.gettempdir(), "/tmp", "/var/tmp", "/dev/shm"))
PYTEST_OWN = ("/__pycache__/", "/.pytest_cache/", "/.ruff_cache/")


def refuse_outside_temp(path: str | bytes | os.PathLike[str] | int, what: str) -> None:
    if isinstance(path, int):
        return
    real = os.path.realpath(os.fsdecode(path))
    if any(real == root or real.startswith(root + "/") for root in ROOTS):
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
    elif event == "subprocess.Popen" and os.path.basename(os.fsdecode(args[0] or "")) == "rm":
        for word in args[1][1:]:
            if not str(word).startswith("-"):
                refuse_outside_temp(os.path.join(os.fsdecode(args[2] or os.getcwd()), str(word)), "rm")


sys.addaudithook(guard)
