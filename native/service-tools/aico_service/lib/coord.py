"""Use Aico's existing shared holds for service preflight and acceptance."""

from __future__ import annotations

import contextvars
import os
import subprocess
from contextlib import contextmanager
from pathlib import Path

_ACK: contextvars.ContextVar[str | None] = contextvars.ContextVar("service_ack", default=None)


class CoordBlocked(RuntimeError):
    """A project hold or unavailable coordination store refused deployment."""


def guard(root: Path, operation: str, *, with_ack: str | None = None) -> None:
    args = [os.environ.get("AICO_HOOK_BIN") or "aico-hook", "lease", "--guard", operation]
    if with_ack:
        args.extend(["--with-ack", with_ack])
    try:
        result = subprocess.run(args, cwd=root, capture_output=True, text=True, check=False)
    except OSError as exc:
        raise CoordBlocked("Aico coordination store is unavailable") from exc
    if result.returncode:
        raise CoordBlocked(result.stdout.strip() or f"Aico coordination refused {operation} (exit {result.returncode})")


@contextmanager
def acked(value: str | None):
    token = _ACK.set(value)
    try:
        yield
    finally:
        _ACK.reset(token)


def current_ack() -> str | None:
    return _ACK.get()
