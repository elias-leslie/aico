"""The push path: can the owner's alerts still leave this host?

Port of the detection in ns/floorpush.py (observe, causes, confirmed). Nightshift's root floor also sent a push of
its own when the owner-side path was down; that sending belongs to the Proxmox sender (M5b), so here the row is the
signal and nothing is sent. The drill (floor-drill) is not ported.

Each [[checks.floor.paths]] entry in checks.toml is one push path: the user and system units it needs, an optional
heartbeat unit (its last good finish must be recent) and an optional delivery heartbeat file. A path with
down_signal names its own meaning when it is no phone path; skip_when_absent is not judged until one of its units exists (Aico's before it is installed); optional_units are
judged only when installed. A cause that is already time-based (a stale heartbeat) counts at once; the others must
hold on two passes confirm_min apart, so a restart never fails the row. The clock for "stale" starts at the latest of
the last success, a run in progress, boot and when this check first watched.
"""

from __future__ import annotations

import json
import math
import os
from typing import Any

from host_steward.checks.workstation import user_systemctl
from host_steward.core import Ctx, Signal

ID = "floor"
PROPS = "LoadState,ActiveState,Result,ExecMainStatus,ExecMainExitTimestamp,ExecMainStartTimestamp"


def unix_stamp(value: str) -> float | None:
    """`systemctl show --timestamp=unix` times: "@1793756736"; "@0" and anything else is no time."""
    v = value.strip()
    if v.startswith("@") and v[1:].replace(".", "", 1).isdigit() and v != "@0":
        return float(v[1:])
    return None


def parse_show(text: str) -> dict[str, dict[str, str]]:
    """`systemctl show` output (blank-line separated blocks) -> {Id: properties}."""
    out: dict[str, dict[str, str]] = {}
    for block in text.split("\n\n"):
        props = dict(line.partition("=")[::2] for line in block.splitlines() if "=" in line)
        if props.get("Id"):
            out[props["Id"]] = props
    return out


def show(ctx: Ctx, prefix: list[str], units: list[str]) -> dict[str, dict[str, str]] | None:
    """None when systemctl could not answer (an unreadable user manager)."""
    if not units:
        return {}
    result = ctx.run(
        [*prefix, "show", "--timestamp=unix", "-p", f"Id,{PROPS}", "--", *units], timeout=30
    )
    got = parse_show(result.out)
    return got if result.rc == 0 and got else None


def sane_stamp(value: Any, now: float) -> float | None:
    """A unix time from a file the owner can write: finite, after 1970, not in the future."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    try:
        stamp = float(value)
    except (OverflowError, ValueError):
        return None
    return stamp if math.isfinite(stamp) and 0 < stamp <= now + 300 else None


def delivery_heartbeat(ctx: Ctx, path: str) -> dict[str, float] | bool | None:
    """{"at": time} from the delivery heartbeat file; None when there is no such delivery here; False when it cannot
    be read or its time is not sane (that counts as stale)."""
    if not path or not os.path.isdir(os.path.dirname(path)):
        return None
    text = ctx.read(path)
    if text is None:
        return False
    try:
        got = json.loads(text)
    except (ValueError, RecursionError):
        return False
    at = sane_stamp(got.get("at"), ctx.now) if isinstance(got, dict) else None
    return False if at is None else {"at": at}


def boot_time(ctx: Ctx, uptime_file: str) -> float:
    text = ctx.read(uptime_file)
    try:
        return ctx.now - float((text or "").split()[0])
    except (ValueError, IndexError):
        return 0.0


def unit_causes(
    units: list[str], seen: dict[str, dict[str, str]], optional: bool
) -> list[tuple[str, str, bool]]:
    out: list[tuple[str, str, bool]] = []
    for unit in units:
        props = seen.get(unit)
        if props is None or props.get("LoadState") == "not-found":
            if not optional:
                out.append((f"missing:{unit}", f"{unit} is not installed", False))
        elif props.get("LoadState") == "masked":
            out.append((f"masked:{unit}", f"{unit} is masked", False))
        elif unit.endswith((".path", ".timer")) and props.get("ActiveState") in (
            "inactive",
            "deactivating",
        ):
            out.append((f"stopped:{unit}", f"{unit} is stopped", False))
        elif props.get("ActiveState") == "failed":
            status = props.get("ExecMainStatus") or ""
            extra = f", status {status}" if status not in ("", "0") else ""
            out.append(
                (
                    f"failed:{unit}",
                    f"{unit} failed ({props.get('Result') or 'failed'}{extra})",
                    False,
                )
            )
    return out


def causes(
    obs: dict[str, Any], conf: dict[str, Any], state: dict[str, Any], now: float
) -> list[tuple[str, str, bool]]:
    """[(code, plain cause, immediate)] for one path; updates state last_ok / last_result / watch_since."""
    out: list[tuple[str, str, bool]] = []
    user = obs.get("user")
    if user is None and conf["user_units"] + conf.get("optional_user_units", []):
        out.append(("user-manager", "the owner's systemd user manager cannot be read", False))
    if user is not None:
        out += unit_causes(conf["user_units"], user, False)
        out += unit_causes(conf.get("optional_user_units", []), user, True)
    system = obs.get("system") or {}
    out += unit_causes(conf["system_units"], system, False)
    out += unit_causes(conf.get("optional_system_units", []), system, True)
    stale = float(conf["stale_min"]) * 60
    heartbeat = conf.get("heartbeat_unit")
    if heartbeat:
        hb = (user or {}).get(heartbeat) or {}
        exit_ts = unix_stamp(hb.get("ExecMainExitTimestamp", ""))
        good = hb.get("Result") == "success" and hb.get("ActiveState") != "failed"
        if exit_ts and good:
            state["last_ok"] = max(float(state.get("last_ok") or 0), exit_ts)
        if exit_ts and hb.get("ActiveState") not in (
            "activating",
            "active",
        ):  # a run starting resets Result
            state["last_result"] = "success" if good else str(hb.get("Result") or "failed")
        last_ok = float(state.get("last_ok") or 0)
        # A run in progress is the scan working: its start counts like a success (the check pass and the scan both
        # start on the quarter hour, so a look often lands mid-run), but not while its last finished run failed.
        running = (
            unix_stamp(hb.get("ExecMainStartTimestamp", ""))
            if hb.get("ActiveState") in ("activating", "active")
            else None
        )
        if running and state.get("last_result", "success") != "success":
            running = None
        watch = float(state.setdefault("watch_since", now))
        since = max(last_ok, running or 0, float(obs.get("boot") or 0), watch)
        if now - since > stale:
            if running and running > last_ok:
                what = f"has been running for {int((now - running) // 60)} min"
            elif last_ok:
                what = f"last finished {int((now - last_ok) // 60)} min ago"
            else:
                origin = "boot" if since == obs.get("boot") else "this check started watching"
                what = f"has not finished in the {int((now - since) // 60)} min since {origin}"
            out.append(("stale", f"the critical scan {what}", True))
    delivery = obs.get("delivery")
    if delivery is not None:
        at = float(delivery["at"]) if isinstance(delivery, dict) else 0.0
        watch = float(state.setdefault("delivery_watch_since", now))  # its own clock
        since = max(at, float(obs.get("boot") or 0), watch)
        if now - since > stale:
            if at:
                what = f"last ran {int((now - at) // 60)} min ago"
            else:
                origin = "boot" if since == obs.get("boot") else "this check started watching"
                what = f"has not run in the {int((now - since) // 60)} min since {origin}"
            out.append(("delivery", f"the delivery pass {what}", True))
    return out


def confirmed(
    found: list[tuple[str, str, bool]], state: dict[str, Any], conf: dict[str, Any], now: float
) -> list[tuple[str, str]]:
    """The causes that hold now and held on an earlier pass at least confirm_min ago (or are immediate)."""
    previous = state.get("pending")
    previous = previous if isinstance(previous, dict) else {}
    pending = {code: float(previous.get(code, now)) for code, _text, _immediate in found}
    state["pending"] = pending
    hold = float(conf["confirm_min"]) * 60
    return [
        (code, text) for code, text, immediate in found if immediate or now - pending[code] >= hold
    ]


def absent(obs: dict[str, Any], conf: dict[str, Any]) -> bool:
    """A skip_when_absent path none of whose units exist yet."""
    units = conf["user_units"] + conf.get("optional_user_units", [])
    system = conf["system_units"] + conf.get("optional_system_units", [])
    seen = [((obs.get("user") or {}).get(u) or {}).get("LoadState") for u in units]
    seen += [((obs.get("system") or {}).get(u) or {}).get("LoadState") for u in system]
    return all(state in (None, "not-found") for state in seen)


def observe(ctx: Ctx, conf: dict[str, Any]) -> dict[str, Any]:
    uid = int(ctx.cfg["owner_uid"])
    prefix = ["systemctl", "--user"] if os.geteuid() == uid else user_systemctl(uid)
    user_units = conf["user_units"] + conf.get("optional_user_units", [])
    system_units = conf["system_units"] + conf.get("optional_system_units", [])
    return {
        "user": show(ctx, prefix, user_units),
        "system": show(ctx, ["systemctl"], system_units) or {},
        "boot": boot_time(ctx, ctx.cfg["uptime_file"]),
        "delivery": delivery_heartbeat(ctx, conf.get("delivery_file", "")),
    }


def run(ctx: Ctx) -> list[Signal]:
    signals: list[Signal] = []
    for conf in ctx.cfg["paths"]:
        name = conf["name"]
        merged = {**{k: ctx.cfg[k] for k in ("stale_min", "confirm_min")}, **conf}
        obs = observe(ctx, merged)
        if conf.get("skip_when_absent") and absent(obs, merged):
            continue
        state = ctx.state.setdefault(name, {})
        found = causes(obs, merged, state, ctx.now)
        held = confirmed(found, state, merged, ctx.now)
        if held:
            signals.append(
                Signal(
                    conf.get("down_signal", "floor.down"),
                    "failed",
                    {"path": name, "why": "; ".join(text for _c, text in held)},
                )
            )
        elif found:
            signals.append(
                Signal(
                    "floor.watching",
                    "ok",
                    {"path": name, "why": "; ".join(t for _c, t, _i in found)},
                    note=True,
                )
            )
        else:
            signals.append(Signal("floor.ok", "ok", {"path": name}))
    if not signals:
        signals.append(Signal("floor.none", "warn"))
    return signals
