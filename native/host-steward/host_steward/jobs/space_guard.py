"""host-steward space-guard: the disk pressure guard (every 15 minutes) for each internal Btrfs disk.

Port of space_guard in ns/housekeeping.py, same behavior:
- while free space is under SummitFlow's reserve plus the capture peak, a ladder, safest first, each tier
  re-measured and the ladder stopped once the line is restored: T0 release the disk's ballast, T1 SummitFlow's
  reclaim commands as the owner (agent temp, caches, scratch retention, snapshot thinning), T2 the journal.
  Models and work directories are never touched here;
- bounded data balances (never a full balance, never profile/device/snapshot changes) toward the allocation
  target once unallocated space drops below the trigger; with too little room the released ballast buys one pass;
- the ballast: a preallocated NOCOW file in its own top-level subvolume, mounted only while checked or changed,
  recreated once free space is back above the line by more than its size;
- where the space goes: direct children of the configured roots measured with du, cached daily (every 2 hours
  under the warning line) for the largest/fastest-growing list.
Lines, margins and the balance trigger come from the storage check's table; this job's own settings are
[jobs.space-guard]. Not ported: the receipts and the SummitFlow ~/.env.local reserve (credentials file).

Every change goes through acts.Actor. With [acting] space_guard off it measures, decides and says what it
would do ("Dry run: ..."); it mounts nothing, balances nothing, deletes nothing and keeps the ballast record.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import shutil
import stat
import time
from collections.abc import Callable, Generator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import aico_status
from host_steward import acts, core
from host_steward.checks.storage import parse_btrfs_usage

NAME = "space-guard"
HELP = "disk pressure guard: reclaim ladder, bounded balances, ballast (dry run until [acting] space_guard is on)"
GIB = 1024**3


def add_args(parser: argparse.ArgumentParser) -> None:
    """The only switch is [acting] space_guard in checks.toml; --no-post just keeps the row off the Status board."""
    parser.add_argument(
        "--no-post", action="store_true", help="print the result, post no Status row"
    )


@dataclass(frozen=True)
class Lines:
    """Free-space lines of one internal disk, GiB."""

    reserve: float
    warn: float  # warning below
    crit: float  # critical below; the reclaim tiers run below it
    floor: float  # critical at or below, whatever the reserve

    def pressured(self, free_gib: float) -> bool:
        return free_gib < self.crit or free_gib <= self.floor


def lines_from(storage: dict[str, Any]) -> Lines:
    reserve = float(storage["reserve_gib"])
    return Lines(
        reserve,
        reserve + float(storage["warn_margin_gib"]),
        reserve + float(storage["capture_peak_gib"]),
        float(storage["critical_floor_gib"]),
    )


def free_default(path: str) -> int:
    return shutil.disk_usage(path).free


@dataclass
class Env:
    """What a run works with. `run` is the read-only command runner; changes go through actor."""

    cfg: dict[str, Any]
    storage: dict[str, Any]
    actor: acts.Actor
    owner: str
    now: float
    free: Callable[[str], int] = field(default_factory=lambda: free_default)
    notes: list[str] = field(default_factory=list)

    @property
    def run(self) -> core.Runner:
        return self.actor.run

    @property
    def live(self) -> bool:
        return self.actor.live


def _gib(n: float) -> float:
    return round(n / GIB, 1)


def fs_device(env: Env, path: str) -> str:
    """Block device holding `path` ("" when unknown): findmnt's SOURCE without its [/subvolume] suffix."""
    res = env.run(["findmnt", "-n", "-o", "SOURCE", "--target", path], timeout=30)
    found = res.out.strip().splitlines() if res.rc == 0 else []
    return found[0].split("[", 1)[0].strip() if found else ""


def fs_sync(env: Env, path: str) -> None:
    """Commit the transaction so deleted files show up as free space before the next measurement."""
    env.actor.do(["btrfs", "filesystem", "sync", path], timeout=120, quiet=True)


def unallocated(env: Env, path: str) -> int | None:
    return parse_btrfs_usage(
        env.run(["btrfs", "filesystem", "usage", "-b", path], timeout=60).out
    ).get("unallocated")


def mount_ok(env: Env, path: str) -> str | None:
    """Why a bounded balance must not run on `path` (None when it may)."""
    res = env.run(
        ["findmnt", "--json", "--mountpoint", path, "--output", "TARGET,FSTYPE,OPTIONS"], timeout=30
    )
    try:
        [mount] = json.loads(res.out)["filesystems"]
    except (ValueError, KeyError, TypeError):
        return "not a single mount point"
    if mount.get("fstype") != "btrfs":
        return "not Btrfs"
    if "rw" not in str(mount.get("options", "")).split(","):
        return "read-only"
    if not re.search(
        r"Total devices\s+1\b", env.run(["btrfs", "filesystem", "show", path], timeout=60).out
    ):
        return "not a healthy single-device filesystem"
    return None


def guard(
    env: Env, path: str, trigger: int, target: int, room: Callable[[], bool] | None = None
) -> dict[str, Any]:
    """Bounded balances toward `target` unallocated once it drops below `trigger`. room(): True when the disk's
    ballast was (or now is) released, which allows one pass despite too little free space."""
    cfg = env.cfg
    report: dict[str, Any] = {"path": path, "passes": []}

    def usage() -> dict[str, int]:
        found = parse_btrfs_usage(
            env.run(["btrfs", "filesystem", "usage", "-b", path], timeout=60).out
        )
        if not {"size", "unallocated", "missing", "free"} <= found.keys():
            raise RuntimeError("Btrfs usage unreadable")
        return found

    before = usage()
    report["before_gib"] = _gib(before["unallocated"])
    if before["missing"]:
        raise RuntimeError("a device is missing")
    if before["unallocated"] >= trigger:
        return report
    if why := mount_ok(env, path):
        raise RuntimeError(f"balance not allowed: {why}")
    if "No balance found" not in env.run(["btrfs", "balance", "status", path], timeout=60).out:
        report["deferred"] = "another balance is active or paused"
        return report
    roomy = False
    for percent in cfg["balance_percents"]:
        current = usage()
        if current["unallocated"] >= target:
            break
        if percent and (
            current["unallocated"] < float(cfg["near_full_unallocated_gib"]) * GIB
            or current["free"] < float(cfg["near_full_free_gib"]) * GIB
        ):
            # Near full: the released ballast buys room for exactly one bounded pass, then the guard stops.
            if not roomy and room is not None and room():
                roomy = True
                current = usage()
            if not roomy or current["unallocated"] < float(cfg["near_full_unallocated_gib"]) * GIB:
                report["warning"] = "too little working space for a bounded balance"
                break
        argv = [
            "btrfs",
            "balance",
            "start",
            f"-dusage={percent},limit={cfg['balance_limit']}",
            path,
        ]
        result = env.actor.do(
            argv,
            f"balance data chunks on {path} (usage {percent}%, up to {cfg['balance_limit']} chunks)",
            float(cfg["balance_timeout_s"]),
        )
        if (
            result is None
        ):  # dry run: the first pass is all it can say; the next one depends on what it frees
            report["passes"].append({"usage_percent": percent, "dry_run": True})
            break
        report["passes"].append(
            {"usage_percent": percent, "rc": result.rc, **({"ballast_room": True} if roomy else {})}
        )
        if result.rc == 124:
            env.run(["btrfs", "balance", "cancel", path], timeout=120)
            report["warning"] = "bounded balance timed out and was cancelled"
            break
        if result.rc:
            report["warning"] = (result.err or result.out).strip()[-300:]
            break
        if roomy:
            break
    report["after_gib"] = _gib(usage()["unallocated"])
    return report


# ---------------------------------------------------------------------------------------------------- ballast


@contextlib.contextmanager
def top_level(env: Env, device: str, label: str) -> Generator[Path]:
    """The filesystem's top level (subvolid 5), mounted root-only under /run only while the ballast is checked or
    changed, then unmounted again. Reached only when the job acts."""
    tops = Path(env.cfg["top_mounts"])
    if not re.fullmatch(r"/dev/[\w./-]+", device) or not re.fullmatch(r"[\w-]+", label):
        raise RuntimeError(f"unexpected device or label: {device!r} {label!r}")
    tops.mkdir(mode=0o700, exist_ok=True)
    info = tops.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise RuntimeError(f"{tops} is not a root-only directory")
    mount = tops / label
    mount.mkdir(mode=0o700, exist_ok=True)
    if os.path.ismount(mount):  # left over from an interrupted run
        env.run(["umount", str(mount)], timeout=120)
        if os.path.ismount(mount):
            raise RuntimeError(f"{mount} is still mounted")
    res = env.run(
        ["mount", "-t", "btrfs", "-o", "subvolid=5,noatime", device, str(mount)], timeout=60
    )
    if res.rc:
        raise RuntimeError(f"top-level mount failed: {(res.err or res.out).strip()[:200]}")
    try:
        yield mount
    finally:
        env.run(["umount", str(mount)], timeout=120)


def ballast_held(env: Env, top: Path) -> int:
    """Bytes the ballast holds on disk (0 when there is none), a temp file left by an interrupted creation included."""
    held = 0
    for name in (env.cfg["ballast_file"], f"{env.cfg['ballast_file']}.tmp"):
        try:
            info = (top / env.cfg["ballast_subvol"] / name).lstat()
        except FileNotFoundError:
            continue
        held += info.st_blocks * 512 if stat.S_ISREG(info.st_mode) else 0
    return held


def make_ballast(env: Env, top: Path, size: int) -> int:
    """Preallocate the ballast (written under a temporary name and renamed, so a full disk leaves no partial file)."""
    sub = top / env.cfg["ballast_subvol"]
    if not os.path.lexists(sub):
        res = env.run(["btrfs", "subvolume", "create", str(sub)], timeout=60)
        if res.rc:
            raise RuntimeError(
                f"ballast subvolume not created: {(res.err or res.out).strip()[:200]}"
            )
        env.run(
            ["chattr", "+C", str(sub)], timeout=30
        )  # files made inside are NOCOW: preallocated space is final
    if sub.is_symlink() or not sub.is_dir():
        raise RuntimeError(f"{sub} is not a directory")
    tmp = sub / f"{env.cfg['ballast_file']}.tmp"
    tmp.unlink(missing_ok=True)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        try:
            os.posix_fallocate(fd, 0, size)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, sub / env.cfg["ballast_file"])
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return ballast_held(env, top)


def drop_ballast(env: Env, top: Path) -> int:
    held = ballast_held(env, top)
    for name in (env.cfg["ballast_file"], f"{env.cfg['ballast_file']}.tmp"):
        (top / env.cfg["ballast_subvol"] / name).unlink(missing_ok=True)
    fs_sync(env, str(top))
    return held


def release_ballast(env: Env, disk: dict[str, Any]) -> str | None:
    """T0: give the ballast's space back (known absent: nothing to mount)."""
    if disk["ballast"] == 0 or not disk["device"]:
        return None
    known = disk["ballast"]
    size = f"{known / GIB:.1f} GiB ballast" if known else "ballast"

    def release() -> int:
        with top_level(env, disk["device"], disk["label"]) as top:
            return drop_ballast(env, top)

    done, freed = env.actor.apply(f"release the {size} on {disk['name']}", release)
    disk["ballast"], disk["checked"] = 0, env.now
    if not done:  # dry run: carry on as if it were released, so the rest of the plan reads the same
        disk["released"] = True
        return None
    disk["released"] = disk["released"] or freed > 0
    return f"released the {freed / GIB:.1f} GiB ballast" if freed else None


def keep_ballast(
    env: Env, disk: dict[str, Any], size: int, lines: Lines, trigger: int
) -> str | None:
    """Create the ballast once free space is above the reclaim line by more than its size and allocation has room
    for it; check a held one daily. Never in the run that released it."""
    known = disk["ballast"]
    recheck = float(env.cfg["ballast_recheck_h"]) * 3600
    if disk["released"] or (
        known is not None and known >= size * 0.9 and env.now - disk["checked"] < recheck
    ):
        return None
    room = env.free(disk["path"]) - size > lines.crit * GIB
    if known == 0 and not room:
        return None
    unalloc = unallocated(env, disk["path"])
    can_make = room and unalloc is not None and unalloc - size >= trigger
    if not env.live:
        if (known is None or known < size * 0.9) and can_make:
            env.actor.would.append(f"create the {size / GIB:.1f} GiB ballast on {disk['name']}")
        elif known is not None and known >= size * 0.9:
            env.actor.would.append(
                f"re-check the ballast on {disk['name']} (mounts the top level for a moment)"
            )
        return None
    with top_level(env, disk["device"], disk["label"]) as top:
        held = ballast_held(env, top)
        disk["ballast"], disk["checked"] = held, env.now
        if held >= size * 0.9 or not can_make:
            return None
        disk["ballast"] = make_ballast(env, top, size)
    return f"created the {disk['ballast'] / GIB:.1f} GiB ballast"


# ------------------------------------------------------------------------------------------- reclaim tiers


def reclaim_commands(cfg: dict[str, Any], path: str, target_gib: float) -> list[list[str]]:
    """The reclaim commands for one disk: a plain list applies to every disk, {"cmd": [...], "paths": [...]} only to
    the disks named; {path} and {target_gib} are filled in (the disk and the free space to restore)."""
    out = []
    for item in cfg.get("reclaim_commands") or []:
        cmd, paths = (
            (item.get("cmd"), item.get("paths")) if isinstance(item, dict) else (item, None)
        )
        if not isinstance(cmd, list) or not cmd or not all(isinstance(x, str) for x in cmd):
            continue
        if isinstance(paths, list) and path not in paths:
            continue
        out.append(
            [x.replace("{path}", path).replace("{target_gib}", f"{target_gib:g}") for x in cmd]
        )
    return out


def owner_reclaim(
    env: Env, disk: dict[str, Any], ctx: dict[str, Any], pressured: Callable[[], bool]
) -> str | None:
    """T1: the configured reclaim commands for this disk as the owner, in order while the disk stays
    pressured, each at most once per run. A command the owner's tools do not have is skipped."""
    done = ctx.setdefault("reclaim_ran", set())
    notes = []
    for cmd in reclaim_commands(env.cfg, disk["path"], disk["lines"].crit):
        if tuple(cmd) in done or not pressured():
            continue
        done.add(tuple(cmd))
        wrapped = acts.as_owner(env.owner, cmd)
        if wrapped is None:
            return None
        before = env.free(disk["path"])
        res = env.actor.do(
            wrapped, f"run as {env.owner}: {' '.join(cmd)}", float(env.cfg["reclaim_timeout_s"])
        )
        if res is None:
            continue
        if core.command_absent(res):
            ctx.setdefault("reclaim_absent", []).append(" ".join(cmd))
            continue
        fs_sync(env, disk["path"])
        gained = env.free(disk["path"]) - before
        text = f"{res.out}\n{res.err}"
        tail = text.strip().splitlines()[-1][:160] if text.strip() else ""
        disk.setdefault("reclaim_runs", []).append(
            {
                "cmd": " ".join(cmd),
                "rc": res.rc,
                "freed_gib": _gib(gained),
                **({"tail": tail} if res.rc and tail else {}),
            }
        )
        if gained >= GIB // 10:
            notes.append(f"{' '.join(cmd)} freed {_gib(gained)} GiB")
    return "; ".join(notes) or None


def journal_tier(env: Env) -> str | None:
    size = env.cfg["journal_vacuum"]
    res = env.actor.do(
        ["journalctl", f"--vacuum-size={size}"], f"vacuum the journal to {size}", 300
    )
    if res is None:
        return None
    found = re.search(r"freed ([\d.]+)([KMGT]?)", res.out + res.err)
    return f"vacuumed the journal to {size}" if found and float(found.group(1)) > 0 else None


def tiers_for(
    env: Env, disk: dict[str, Any], ctx: dict[str, Any]
) -> list[tuple[str, Callable[[], str | None]]]:
    """The ladder for one disk, safest first: only the tiers whose data lives on this disk."""
    device = disk["device"]

    def pressured() -> bool:
        return disk["lines"].pressured(env.free(disk["path"]) / GIB)

    tiers: list[tuple[str, Callable[[], str | None]]] = []
    if device and env.cfg.get("ballast_gib"):
        tiers.append(("ballast", lambda: release_ballast(env, disk)))
    if env.cfg.get("reclaim_commands"):
        tiers.append(("reclaim", lambda: owner_reclaim(env, disk, ctx, pressured)))
    if device and device == ctx["devices"].get(env.cfg["journal_path"]):
        tiers.append(("journal", lambda: journal_tier(env)))
    return tiers


def ladder(env: Env, disk: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """Run the tiers in order while the disk is under its reclaim line; stop once it is restored. Each tier's effect is
    measured (free space before and after). A dry run cannot see a tier's effect, so it lists every tier it would try."""
    path, lines = disk["path"], disk["lines"]
    report: dict[str, Any] = {"free_before_gib": _gib(env.free(path)), "tiers": []}
    for name, tier in tiers_for(env, disk, ctx):
        before = env.free(path)
        if not lines.pressured(before / GIB):
            break
        try:
            note = tier()
        except (OSError, RuntimeError, ValueError) as error:
            report.setdefault("errors", []).append(f"{name}: {str(error)[:200]}")
            note = None
        fs_sync(env, path)
        report["tiers"].append(name)
        if note:
            disk["actions"].append(
                f"{disk['name']}: {note} (free {_gib(before)} -> {_gib(env.free(path))} GiB)"
            )
    free = env.free(path)
    report["free_after_gib"] = _gib(free)
    report["exhausted"] = free / GIB < lines.reserve
    if disk.get("reclaim_runs"):
        report["reclaim_runs"] = disk["reclaim_runs"]
    if ctx.get("reclaim_absent"):
        report["reclaim_absent"] = sorted(set(ctx["reclaim_absent"]))
    return report


# ------------------------------------------------------------------------------------ where the space goes


def measure_children(env: Env, root: Path, timeout: float = 300) -> dict[str, int] | None:
    """du of each direct child of `root` on root's own filesystem (no links, no mounts or subvolumes)."""
    try:
        dev = root.stat().st_dev
        names = sorted(root.iterdir())
    except OSError:
        return None
    kids = []
    for child in names:
        with contextlib.suppress(OSError):
            if not child.is_symlink() and child.lstat().st_dev == dev:
                kids.append(str(child))
    if not kids or len(kids) > 5000:
        return {} if not kids else None
    nice = ["ionice", "-c", "3"] if shutil.which("ionice") else []
    res = env.run([*nice, "du", "-x", "-s", "--block-size=1", "--", *kids], timeout=timeout)
    if res.rc == 124:
        return None
    out = {}
    for line in res.out.splitlines():
        size, sep, name = line.partition("\t")
        if sep and size.isdigit():
            out[name] = int(size)
    return out


def refresh_growers(env: Env, warned: set[str], path: Path) -> None:
    """Measure where the space goes on each balance disk (daily, every 2 h while under the warning line) and keep
    the largest and fastest-growing directories. Read-only on the disks; the cache is this job's own file."""
    cfg, now = env.cfg, env.now
    full_s, pressure_s, top_n = (
        float(cfg["grow_full_h"]) * 3600,
        float(cfg["grow_pressure_h"]) * 3600,
        int(cfg["grow_top"]),
    )
    prev = acts.read_json(path)
    filesystems = dict(prev.get("filesystems") or {})
    roots = [r.format(owner=env.owner) for r in cfg["grow_roots"]]
    devices = {r: fs_device(env, r) for r in roots if os.path.isdir(r)}
    changed = False
    for disk in cfg["disks"]:
        p, old = disk["path"], filesystems.get(disk["path"]) or {}
        age = now - float(old.get("at") or 0)
        if old.get("at") and age < full_s and not (p in warned and age >= pressure_s):
            continue
        device = fs_device(env, p)
        sizes: dict[str, int] = {}
        for root, root_dev in devices.items():
            if device and root_dev == device and (measured := measure_children(env, Path(root))):
                sizes.update(measured)
        if not sizes:
            continue
        before = old.get("sizes") or {}
        grew = {k: v - int(before.get(k, 0)) if before else None for k, v in sizes.items()}
        by_size = sorted(sizes, key=lambda k: -sizes[k])[:top_n]
        by_growth = [
            k for k in sorted(sizes, key=lambda k: -(grew[k] or 0))[:top_n] if (grew[k] or 0) >= GIB
        ]
        top = [
            {"path": k, "bytes": sizes[k], "grew": grew[k]}
            for k in dict.fromkeys([*by_size, *by_growth])
        ]
        filesystems[p] = {"at": now, "prev_at": old.get("at"), "sizes": sizes, "top": top}
        changed = True
    if changed:
        acts.write_json(path, {"filesystems": filesystems})


# --------------------------------------------------------------------------------------------- the run


def space_guard(env: Env, prev: dict[str, Any]) -> dict[str, Any]:
    cfg = env.cfg
    lines = lines_from(env.storage)
    trigger, target = (
        int(float(env.storage["alloc_trigger_gib"]) * GIB),
        int(float(env.storage["alloc_target_gib"]) * GIB),
    )
    size = int(float(cfg.get("ballast_gib") or 0) * GIB)
    recheck = float(cfg["ballast_recheck_h"]) * 3600
    ctx: dict[str, Any] = {"devices": {p: fs_device(env, p) for p in (cfg["journal_path"],)}}
    reports: list[dict[str, Any]] = []
    actions = env.notes
    failed, warned = False, set()
    ballast: dict[str, int] = {}
    checked: dict[str, float] = {}
    for entry in cfg["disks"]:
        path = entry["path"]
        at = float((prev.get("ballast_checked") or {}).get(path) or 0)
        known = (prev.get("ballast") or {}).get(path)
        known = (
            int(known) if isinstance(known, int | float) and not isinstance(known, bool) else None
        )
        if known == 0 and env.now - at >= recheck and size:
            known = None  # absent, but not checked today: look again
        disk: dict[str, Any] = {
            "path": path,
            "name": entry["name"],
            "label": entry["label"],
            "lines": lines,
            "actions": actions,
            "device": fs_device(env, path),
            "released": False,
            "checked": at,
            "ballast": known if known is not None or size else 0,
        }
        report: dict[str, Any] = {"path": path}
        try:
            free = env.free(path)
        except OSError as error:
            reports.append({**report, "error": str(error)})
            failed = True
            continue
        report["free_gib"] = _gib(free)
        if free / GIB < lines.warn:
            warned.add(path)
        if lines.pressured(free / GIB):
            report["pressured"] = True
            report["ladder"] = ladder(env, disk, ctx)
            failed |= bool(report["ladder"].get("errors"))

        def room(disk: dict[str, Any] = disk) -> bool:
            if not disk["released"]:
                with contextlib.suppress(OSError, RuntimeError):
                    if note := release_ballast(env, disk):
                        actions.append(f"{disk['name']}: {note} for one bounded balance")
            return bool(disk["released"])

        try:
            report.update(guard(env, path, trigger, target, room if size else None))
        except (OSError, RuntimeError) as error:
            report["error"] = str(error)
        failed |= "error" in report or "warning" in report
        if report.get("passes") and env.live:
            actions.append(
                f"{entry['name']}: bounded Btrfs balance, unallocated {report['before_gib']} -> {report.get('after_gib')} GiB"
            )
        if size and disk["device"]:
            try:
                if note := keep_ballast(env, disk, size, lines, trigger):
                    actions.append(f"{entry['name']}: {note}")
            except (OSError, RuntimeError) as error:
                report["ballast_error"] = str(error)[:200]
                failed = True
        if env.live and disk["ballast"] is not None:
            ballast[path], checked[path] = disk["ballast"], disk["checked"]
        reports.append(report)
    try:
        refresh_growers(env, warned, acts.job_dir() / "growers.json")
    except Exception as error:  # noqa: BLE001 - measuring must never fail the guard
        print(f"growers not measured: {type(error).__name__}")
    return {
        "filesystems": reports,
        "actions": actions,
        "would": list(env.actor.would),
        "failed": failed,
        "reserve_gib": lines.reserve,
        "ballast": ballast,
        "ballast_checked": checked,
    }


def row_text(result: dict[str, Any], live: bool) -> tuple[str, str]:
    """(state, meaning) for the run."""
    reports = result["filesystems"]
    where = ", ".join(
        f"{r['path']} {r['free_gib']:.0f} GiB free" for r in reports if "free_gib" in r
    )
    if live:
        if result["failed"]:
            problem = next(
                (
                    r.get("error") or r.get("warning") or r.get("ballast_error")
                    for r in reports
                    if r.get("error") or r.get("warning") or r.get("ballast_error")
                ),
                "a tier failed",
            )
            return "warn", f"The space guard hit a problem: {problem}. {where}."
        if result["actions"]:
            return "ok", "Space guard acted: " + "; ".join(result["actions"][:3]) + "."
        return "ok", f"Nothing needed: {where}."
    would = result["would"]
    under = [r["path"] for r in reports if r.get("pressured")]
    lead = f"{', '.join(under)} is under the free-space line; " if under else ""
    if result["failed"]:
        problem = next(
            (
                r.get("error") or r.get("warning") or r.get("ballast_error")
                for r in reports
                if r.get("error") or r.get("warning") or r.get("ballast_error")
            ),
            "a tier failed",
        )
        also = f"; it would {acts.say_would(would)}" if would else ""
        return "warn", f"Dry run: hit a problem ({problem}){also}. {where}."
    if would:
        return (
            "ok",
            f"Dry run: {lead}would {acts.say_would(would)}.",
        )
    return "ok", f"Dry run: {lead}nothing to do ({where})."


def status_row(cfg: dict[str, Any], state: str, meaning: str, now: float) -> dict[str, Any]:
    return core.job_row(
        NAME,
        cfg["what"],
        state,
        meaning,
        aico_status.machine_id(),
        now,
        cfg["every_min"],
        cfg["slack_min"],
        actions=[
            {"kind": "run", "ref": "sudo -n systemctl start host-steward-space-guard.service"},
            {"kind": "log", "ref": "journalctl -u host-steward-space-guard.service -n 200 --no-pager"},
        ],
    )


def main(args: argparse.Namespace, data: dict[str, Any], post: Any = aico_status.report) -> int:
    cfg = data["jobs"][NAME]
    live = core.acting(data, "space_guard")
    now = time.time()
    with acts.single_run(NAME) as got:
        if not got:
            print("host-steward space-guard: another run is still going")
            return 0
        env = Env(
            cfg,
            data["checks"]["storage"],
            acts.Actor(live, run=core.run_command),
            data["site"]["owner"]["user"],
            now,
        )
        prev = acts.read_json(acts.job_dir() / "space-guard.json")
        result = space_guard(env, prev)
        saved = {"at": core.iso_time(now), "live": live, **result}
        if not live:  # a dry run keeps the ballast record
            saved["ballast"], saved["ballast_checked"] = (
                prev.get("ballast", {}),
                prev.get("ballast_checked", {}),
            )
        acts.write_json(acts.job_dir() / "space-guard.json", saved)
    state, meaning = row_text(result, live)
    if not args.no_post:
        post(status_row(cfg, state, meaning, now))
    print(json.dumps({"live": live, **result}, sort_keys=True, default=str))
    return 1 if result["failed"] else 0
