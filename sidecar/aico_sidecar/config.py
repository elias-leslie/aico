"""Sidecar configuration, resolved from environment with XDG defaults.

Mirrors the keys documented in .env.example. Read once via `Settings.from_env()`;
tests construct `Settings(...)` directly with a tmp `state_dir`.
"""

from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8005


def _is_loopback(host: str) -> bool:
    """True if `host` is a loopback address (or the `localhost` name)."""
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _resolve_port() -> int:
    """`$AICO_SIDECAR_PORT` as a valid TCP port, else the default. A bad value is a
    config error worth failing loudly on, not a bare `int()` ValueError/crash."""
    raw = os.environ.get("AICO_SIDECAR_PORT")
    if raw is None:
        return DEFAULT_PORT
    try:
        port = int(raw)
    except ValueError:
        raise ValueError(f"invalid AICO_SIDECAR_PORT {raw!r}: must be an integer") from None
    if not 1 <= port <= 65535:
        raise ValueError(f"AICO_SIDECAR_PORT {port} out of range (expected 1-65535)")
    return port


def _default_state_dir() -> Path:
    """`$AICO_STATE_DIR`, else `$XDG_STATE_HOME/aico`, else `~/.local/state/aico`."""
    override = os.environ.get("AICO_STATE_DIR")
    if override:
        return Path(override).expanduser()
    xdg = os.environ.get("XDG_STATE_HOME")
    base = Path(xdg).expanduser() if xdg else Path.home() / ".local" / "state"
    return base / "aico"


@dataclass(frozen=True)
class Settings:
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    state_dir: Path = None  # type: ignore[assignment]  # filled in __post_init__

    def __post_init__(self) -> None:
        if self.state_dir is None:
            object.__setattr__(self, "state_dir", _default_state_dir())

    @property
    def logs_dir(self) -> Path:
        return self.state_dir / "logs"

    @property
    def selections_db(self) -> Path:
        """Selection-bus ring buffer. Separate file from Electron's `aico.db` so
        the sidecar is the sole writer (no cross-process write contention)."""
        return self.state_dir / "selections.db"

    @classmethod
    def from_env(cls) -> Settings:
        # The bus has no authentication; a non-loopback bind would expose the
        # selection-injection + widget-log endpoints to the whole network. Refuse
        # it unless the operator explicitly opts in via AICO_SIDECAR_ALLOW_REMOTE.
        host = os.environ.get("AICO_SIDECAR_HOST", DEFAULT_HOST)
        allow_remote = os.environ.get("AICO_SIDECAR_ALLOW_REMOTE") == "1"
        if not _is_loopback(host) and not allow_remote:
            raise ValueError(
                f"refusing non-loopback bind host {host!r}: the sidecar is "
                "unauthenticated. Set AICO_SIDECAR_ALLOW_REMOTE=1 to override."
            )
        return cls(
            host=host,
            port=_resolve_port(),
            state_dir=_default_state_dir(),
        )
