"""Sidecar configuration, resolved from environment with XDG defaults.

Mirrors the keys documented in .env.example. Read once via `Settings.from_env()`;
tests construct `Settings(...)` directly with a tmp `state_dir`.
"""

from __future__ import annotations

import ipaddress
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8005

# Stable ID of the bundled MV3 extension, derived from the public `key` in
# extension/manifest.json (sha256 of the DER SubjectPublicKeyInfo, first 32 hex
# chars mapped 0-f -> a-p). Only this extension's origin is trusted by default;
# `$AICO_EXTENSION_IDS` (comma-separated) overrides it, e.g. for a fork that
# ships its own key.
DEFAULT_EXTENSION_ID = "oejadbpdecaenbbihglcnchnkmlilmjf"
_EXTENSION_ID_RE = re.compile(r"[a-p]{32}")


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


def _resolve_extension_ids() -> frozenset[str]:
    """`$AICO_EXTENSION_IDS` as a set of Chrome extension IDs, else the bundled
    extension's ID. A malformed ID fails loudly rather than silently widening or
    emptying the trusted-origin set."""
    raw = os.environ.get("AICO_EXTENSION_IDS")
    if raw is None or not raw.strip():
        return frozenset({DEFAULT_EXTENSION_ID})
    ids = [part.strip() for part in raw.split(",") if part.strip()]
    for ext_id in ids:
        if not _EXTENSION_ID_RE.fullmatch(ext_id):
            raise ValueError(
                f"invalid extension id {ext_id!r} in AICO_EXTENSION_IDS: expected 32 chars a-p"
            )
    return frozenset(ids)


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
    # Chrome extension IDs whose chrome-extension:// origin may reach the bus.
    extension_ids: frozenset[str] = field(default_factory=lambda: frozenset({DEFAULT_EXTENSION_ID}))
    # Operator opt-in to a non-loopback bind; also lifts the loopback-only Host
    # header check (remote clients address the sidecar by a LAN name/IP).
    allow_remote: bool = False

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
            extension_ids=_resolve_extension_ids(),
            allow_remote=allow_remote,
        )
