"""The OmniNull lock on this host: the agent's capability ceiling and whether signed scripts are on.

Port of ns/checks/ominull_lock.py. The ceiling file is set by the root installs from the site's per-host level; the
pinned authority file lists the keys that let signed scripts run, and the allow file how many packages may run
without a tap. A ceiling that differs from the data file's level warns; no ceiling at all is only a note.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from host_steward.core import Ctx, Signal

ID = "ominull-lock"


def read_ceiling(path: str) -> str:
    try:
        value = Path(path).read_text().strip()
    except OSError:
        return ""
    return value if re.fullmatch(r"[a-z][a-z-]{0,31}", value) else ""


def read_roles(path: str) -> set[str]:
    try:
        return {str(k.get("role")) for k in json.loads(Path(path).read_text()).get("keys") or []}
    except (OSError, ValueError, AttributeError):
        return set()


def read_auto(path: str) -> int:
    try:
        return len(json.loads(Path(path).read_text()).get("packages") or [])
    except (OSError, ValueError, AttributeError):
        return 0


def run(ctx: Ctx) -> list[Signal]:
    cfg = ctx.cfg
    ceiling = read_ceiling(cfg["ceiling_file"])
    signed = {"tap", "auto"} <= read_roles(cfg["authority_file"])
    scripts = f"signed scripts on, {read_auto(cfg['allow_file'])} packages without a tap" if signed else "signed scripts off"
    want = cfg.get("expected_ceiling", "")
    fields = {"ceiling": ceiling or "none", "want": want, "scripts": scripts}
    if want and ceiling != want:
        return [Signal("ominull.lock.differs", "warn", fields)]
    if not ceiling:
        return [Signal("ominull.lock", "ok", fields, note=True)]
    return [Signal("ominull.lock", "ok", fields)]
