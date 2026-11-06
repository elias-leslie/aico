"""Declarations and lab use: an agent session says a change a check watches was its own, or that it is using a parked lab
machine.

`host-steward declare --host H --what KIND --hours N --reason TEXT [--since H]` says "what
changes on host H in this window are mine, and why". KIND is one of KINDS; --since covers a change already made (at
most SINCE_MAX_H hours back). A check that finds a matching change calls `covering()` and turns it into an ok note that
names the session and its reason instead of a problem. Nothing is granted or changed by a declaration, and it ends by
itself (at most MAX_HOURS). The files are writable by the owner, so every name is shown as the declaration's own
account, never as verified; the reader trusts nothing in them: a regular file of at most MAX_BYTES owned by root, the
reader or the site owner and not world-writable, with kinds, hosts, times and text validated and capped.

Where the files live is the [site.declarations] table in checks.toml (`cfg` below): the declaration and lab-use
files and the first-seen file the root reader keeps.

For other checks, the small API:
    covering(cfg, host, kind, at, last_at=None, now=None, owner_uid=None) -> declaration dict or None
        The newest declaration of KIND (or `any`) that covers `host` (a host name, or a role name resolved through
        cfg["roles"]) from `at` to `last_at`. Reads the files; never raises.
    said(declaration) -> "An agent said this was them (<name>, by its own account: <reason>)"
    lab_use(cfg, now=None) -> {asset or vmid: {at, until, reason, by}}   unexpired lab-use declarations
    kind_of_paths(paths) -> "listeners" | "keys" | "config" | "other"   the kind a tripwire change belongs to
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import time
from pathlib import Path
from typing import Any

from host_steward import attribution, core

KINDS = ("listeners", "units", "vm", "firewall", "packages", "keys", "config", "any")
HOST_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}")
ASSET_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,47}|[0-9]{3,9}")
WIDGET_RE = re.compile(r"[0-9a-f]{4,64}")
_TEXT = re.compile(r"[^A-Za-z0-9 _.,:;()/@+#'-]")
WHO_VARS = (
    "HOST_STEWARD_AGENT",
    "AICO_TITLE",
    "TETHER_SESSION",
    "CLAUDE_SESSION_ID",
    "CODEX_SESSION_ID",
)


def _num(cfg: dict[str, Any], key: str) -> float:
    return float(cfg[key])


def _text(value: Any, limit: int) -> str:
    return " ".join(_TEXT.sub("", str(value or "")).split())[:limit]


def _owner_uid(cfg: dict[str, Any]) -> int | None:
    import pwd

    try:
        return pwd.getpwnam(str(cfg["owner_user"])).pw_uid
    except (KeyError, TypeError, ValueError):
        return None


def _read_raw(path: str | Path, cfg: dict[str, Any], owner_uid: int | None) -> dict[str, Any]:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError:
        return {}
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(fd)
        allowed = {0, os.geteuid(), owner_uid}
        too_big = info.st_size > int(cfg["max_bytes"])
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_mode & 0o002
            or info.st_uid not in allowed
            or too_big
        ):
            return {}
        try:
            data = json.loads(handle.read(int(cfg["max_bytes"]) + 1))
        except (ValueError, RecursionError):
            return {}
    return data if isinstance(data, dict) else {}


def _write(path: str | Path, data: dict[str, Any]) -> None:
    core.write_json(path, data, mode=0o644)


def _who() -> str:
    for var in WHO_VARS:
        if os.environ.get(var):
            return f"{var.lower().split('_')[0]} {os.environ[var]}"
    return os.environ.get("USER", "") or "an agent session"


# ---------------------------------------------------------------- lab use


def lab_use(
    cfg: dict[str, Any], now: float | None = None, owner_uid: int | None = None
) -> dict[str, dict[str, Any]]:
    """Valid, unexpired lab-use declarations: asset id or vmid -> entry."""
    now = time.time() if now is None else now
    uid = owner_uid if owner_uid is not None else _owner_uid(cfg)
    rows: dict[str, Any] = {}
    rows.update(_read_raw(cfg["lab_use_file"], cfg, uid))
    out: dict[str, dict[str, Any]] = {}
    for asset, e in list(rows.items())[: int(cfg["max_entries"])]:
        if not isinstance(asset, str) or not ASSET_RE.fullmatch(asset) or not isinstance(e, dict):
            continue
        at, until = e.get("at"), e.get("until")
        if not all(isinstance(x, int | float) and not isinstance(x, bool) for x in (at, until)):
            continue
        if at > now + 60 or until <= now or until - at > _num(cfg, "max_hours") * 3600:
            continue
        out[asset] = {
            "at": float(at),
            "until": float(until),
            "reason": _text(e.get("reason"), 120) or "no reason given",
            "by": _text(e.get("by"), 60) or "an agent session",
        }
    return out


def start_lab_use(
    cfg: dict[str, Any],
    asset: str,
    hours: float,
    reason: str,
    by: str = "",
    now: float | None = None,
) -> dict[str, Any]:
    now = time.time() if now is None else now
    asset = asset.strip().lower()
    if not ASSET_RE.fullmatch(asset):
        raise ValueError("asset: a registry id (lowercase name) or a PVE vmid")
    if not reason.strip():
        raise ValueError("--reason: say what the machine is used for")
    hours = max(0.1, min(float(hours), _num(cfg, "max_hours")))
    data = lab_use(cfg, now)
    data[asset] = {
        "at": now,
        "until": now + hours * 3600,
        "reason": _text(reason, 120),
        "by": _text(by or _who(), 60),
    }
    _write(cfg["lab_use_file"], data)
    return data[asset]


def end_lab_use(cfg: dict[str, Any], asset: str, now: float | None = None) -> bool:
    now = time.time() if now is None else now
    data = lab_use(cfg, now)
    found = data.pop(asset.strip().lower(), None) is not None
    _write(cfg["lab_use_file"], data)
    return found


# ---------------------------------------------------------------- declarations


def _actor_now(site: dict[str, Any]) -> dict[str, Any] | None:
    """The agent session (or our service) running this command, read from the kernel; None when none is found."""
    try:
        return attribution.of_pid(os.getpid(), attribution.owner(site))
    except Exception:  # noqa: BLE001 - attribution only ever adds a name
        return None


def _clean_actor(a: Any) -> dict[str, str] | None:
    if not isinstance(a, dict):
        return None
    out = {
        "kind": _text(a.get("kind"), 16),
        "label": _text(a.get("label"), 80),
        "tool": _text(a.get("tool"), 24),
    }
    if isinstance(a.get("widget"), str) and WIDGET_RE.fullmatch(a["widget"]):
        out["widget"] = a["widget"]
    return out if out["label"] else None


def _entry_id(e: dict[str, Any]) -> str:
    keep = {k: e.get(k) for k in ("host", "what", "at", "made", "until", "reason", "by")}
    return hashlib.sha256(json.dumps(keep, sort_keys=True, default=str).encode()).hexdigest()[:20]


def _raw_rows(cfg: dict[str, Any], owner_uid: int | None) -> list[dict[str, Any]]:
    got = _read_raw(cfg["file"], cfg, owner_uid).get("declarations")
    rows: list[Any] = got if isinstance(got, list) else []
    return list({_entry_id(e): e for e in rows if isinstance(e, dict)}.values())


def declare(
    cfg: dict[str, Any],
    site: dict[str, Any],
    host: str,
    what: str,
    hours: float,
    reason: str,
    since_h: float = 0.0,
    by: str = "",
    now: float | None = None,
    actor: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Record a declaration (the `vm` kind also records lab use of asset `host`). Grants nothing."""
    now = time.time() if now is None else now
    host, what = host.strip(), what.strip().lower()
    what = "vm" if what == "lab-use" else what
    if what not in KINDS:
        raise ValueError(f"--what: one of {', '.join(KINDS)}")
    if not HOST_RE.fullmatch(host):
        raise ValueError(
            "--host: a host name or a role (workstation, pve, router); for vm the lab asset"
        )
    if not reason.strip():
        raise ValueError("--reason: say what you changed and why")
    hours = max(0.1, min(float(hours), _num(cfg, "max_hours")))
    since_h = max(0.0, min(float(since_h or 0), _num(cfg, "since_max_h")))
    if what == "vm":
        start_lab_use(cfg, host, hours, reason, by, now)
    a = _clean_actor(actor if actor is not None else _actor_now(site))
    entry: dict[str, Any] = {
        "host": host,
        "what": what,
        "at": now - since_h * 3600,
        "made": now,
        "until": now + hours * 3600,
        "reason": _text(reason, 160),
        "by": _text(by, 60) or (a["label"] if a else _text(_who(), 60)),
    }
    if a:
        entry["actor"] = a
    keep_after = now - _num(cfg, "retain_h") * 3600
    rows = [
        e
        for e in _raw_rows(cfg, _owner_uid(cfg))
        if isinstance(e.get("until"), int | float) and e["until"] > keep_after
    ]
    _write(cfg["file"], {"declarations": [*rows, entry][-int(cfg["max_entries"]) :]})
    return entry


def _first_seen(
    rows: list[dict[str, Any]], path: Path, cfg: dict[str, Any], now: float
) -> dict[str, float]:
    """{entry id: when the root reader first saw it}. The writer's `made` is not trusted: an entry is never taken to
    exist before the reader saw it."""
    try:
        old = json.loads(path.read_text())
    except (OSError, ValueError):
        old = {}
    old = old if isinstance(old, dict) else {}
    ids = {_entry_id(e) for e in rows}
    keep_s = _num(cfg, "retain_h") * 3600 + _num(cfg, "max_hours") * 3600
    out = {
        k: float(v)
        for k, v in old.items()
        if isinstance(v, int | float) and not isinstance(v, bool) and (k in ids or now - v < keep_s)
    }
    new = {i: now for i in ids if i not in out}
    if new:
        out.update(new)
        try:
            _write(path, out)
        except OSError:
            pass  # unwritable: every entry counts as first seen now, which only narrows coverage
    return out


def declarations(
    cfg: dict[str, Any], now: float | None = None, owner_uid: int | None = None, track: bool = True
) -> list[dict[str, Any]]:
    """Valid declarations whose window ended less than retain_h ago. With `track` (the root check run) `made` is at
    most when the reader first saw the entry and the window never starts more than since_max_h before that."""
    now = time.time() if now is None else now
    uid = owner_uid if owner_uid is not None else _owner_uid(cfg)
    since_max = _num(cfg, "since_max_h") * 3600
    retain = _num(cfg, "retain_h") * 3600
    rows = _raw_rows(cfg, uid)[-int(cfg["max_entries"]) :]
    first = _first_seen(rows, Path(cfg["first_seen_file"]), cfg, now) if track else {}
    out = []
    for e in rows:
        if (
            e.get("what") not in KINDS
            or not isinstance(e.get("host"), str)
            or not HOST_RE.fullmatch(e["host"])
        ):
            continue
        raw = (e.get("at"), e.get("made", e.get("at")), e.get("until"))
        if not all(isinstance(x, int | float) and not isinstance(x, bool) for x in raw):
            continue
        at, made, until = (float(x) for x in raw)
        too_long = until - made > _num(cfg, "max_hours") * 3600 + 60
        if (
            made > now + 60
            or not at <= made <= until
            or made - at > since_max + 60
            or too_long
            or until <= now - retain
        ):
            continue
        if track:
            at = max(at, first.get(_entry_id(e), now) - since_max)
            if at > until:
                continue
        out.append(
            {
                "host": e["host"],
                "what": e["what"],
                "at": float(at),
                "until": float(until),
                "reason": _text(e.get("reason"), 160) or "no reason given",
                "by": _text(e.get("by"), 60) or "an agent session",
                "actor": _clean_actor(e.get("actor")),
            }
        )
    return out


def kind_of_paths(paths: list[str]) -> str:
    """The declaration kind a tripwire change belongs to: the kind every path shares ("other" when they differ, so
    a declaration never closes the part it did not name)."""
    kinds = {
        "listeners" if p.startswith("listen ") else "keys" if "authorized_keys" in p else "config"
        for p in paths
    }
    return kinds.pop() if len(kinds) == 1 else "config" if not kinds else "other"


def _host_matches(decl_host: str, host: str, roles: dict[str, str]) -> bool:
    return decl_host == host or roles.get(decl_host) == host


def match(
    decls: list[dict[str, Any]],
    host: str,
    kind: str,
    at: float,
    last_at: float | None = None,
    roles: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    """The newest declaration covering this host, kind and time, or None. `any` covers every kind a declaration
    can name (not "other" or "")."""
    if kind in ("", "other"):
        return None
    last = at if last_at is None else max(at, last_at)
    hits = [
        d
        for d in decls
        if d["what"] in (kind, "any")
        and d["at"] <= at
        and last <= d["until"]
        and _host_matches(d["host"], host, roles or {})
    ]
    return max(hits, key=lambda d: d["at"]) if hits else None


def covering(
    cfg: dict[str, Any],
    host: str,
    kind: str,
    at: float,
    last_at: float | None = None,
    now: float | None = None,
    owner_uid: int | None = None,
) -> dict[str, Any] | None:
    try:
        return match(declarations(cfg, now, owner_uid), host, kind, at, last_at, cfg.get("roles"))
    except Exception:  # noqa: BLE001 - a broken declarations file never stops a check
        return None


def name(d: dict[str, Any]) -> str:
    """Who the declaration says made it (the session its writer named, else --by); never shown as verified."""
    a = d.get("actor")
    return a["label"] if isinstance(a, dict) and a.get("label") else d["by"]


def said(d: dict[str, Any]) -> str:
    return f"An agent said this was them ({name(d)}, by its own account: {d['reason']})"


def settings(data: dict[str, Any]) -> dict[str, Any]:
    """The [site.declarations] table of the loaded data, with the file locations overridable from the environment
    (HOST_STEWARD_DECLARATIONS, HOST_STEWARD_LAB_USE: tests and one-off runs)."""
    cfg = dict(data["site"]["declarations"])
    for env, key in (
        ("HOST_STEWARD_DECLARATIONS", "file"),
        ("HOST_STEWARD_LAB_USE", "lab_use_file"),
    ):
        if os.environ.get(env):
            cfg[key] = os.environ[env]
    return cfg
