"""host-steward housekeeping: the daily bounded cleanup of caches and garbage that never touches user data.

Port of `maintain` in ns/housekeeping.py: the journal size cap, apt and snap caches, an inactive Spotify cache above
its size, a stale libguestfs appliance, old versions in the families marked prune (Playwright browsers), and
package-manager caches above their configured caps. Broader scratch, model and project-artifact retention is
left to the consolidation audit; there is no delegate to the retired cleanup namespace.

Everything that changes the host goes through acts.Actor. With [acting] housekeeping off it only lists what it
would do and the row says "Dry run: ..."; the read-only looks (snap list, pgrep, directory sizes) still run.
"""

from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path
from typing import Any

import aico_status
from host_steward import acts, core, versioned

NAME = "housekeeping"
HELP = "daily cache and garbage cleanup (dry run until [acting] housekeeping is on)"
GIB = 1024**3


def add_args(parser: argparse.ArgumentParser) -> None:
    """The only switch is [acting] housekeeping in checks.toml; --no-post just keeps the row off the Status board."""
    parser.add_argument(
        "--no-post", action="store_true", help="print the result, post no Status row"
    )


def disabled_snap_revisions(text: str) -> list[tuple[str, str]]:
    """(name, revision) of the disabled snaps in `snap list --all`."""
    out = []
    for line in text.splitlines()[1:]:
        fields = line.split()
        if len(fields) >= 6 and fields[-1] == "disabled":
            out.append((fields[0], fields[2]))
    return out


def package_caches(cfg: dict[str, Any], owner: str, actor: acts.Actor, notes: list[str], home: str) -> bool:
    """Measure only configured tool caches; each tool prunes its own cache above its cap."""
    failed = False
    wrapper = acts.as_owner(owner, [])
    if wrapper is None:
        notes.append("package cache owner is unavailable")
        return True
    for spec in cfg.get("package_caches", []):
        name = spec["name"]
        path = Path(spec["path"].format(owner=owner)).resolve()
        if not path.is_dir():
            continue

        def command(argv: list[str], name: str = name) -> list[str]:
            # The clean home cwd avoids reading project config; admission keeps scans and prunes bounded.
            return [*wrapper, "env", f"--chdir={home}", "st", "tools", "run", "--label",
                    f"Housekeeping {name} cache", "--", *argv]

        query = command(spec["query"])
        location = actor.run(query, timeout=float(cfg["cache_timeout_s"]))
        lines = location.out.strip().splitlines()
        actual = Path(lines[-1]) / spec.get("suffix", "") if lines else None
        if location.rc or actual is None or not actual.is_absolute() or actual.resolve() != path:
            notes.append(f"{name} cache location is unavailable or changed")
            failed = True
            continue
        measure = command(["du", "--bytes", "--summarize", "--one-file-system", "--", str(path)])
        size = actor.run(measure, timeout=float(cfg["cache_timeout_s"]))
        try:
            count = int(size.out.split()[0]) if size.rc == 0 else -1
        except (ValueError, IndexError):
            count = -1
        if count < 0:
            notes.append(f"{name} cache size is unavailable")
            failed = True
            continue
        if count <= float(spec["max_gib"]) * GIB:
            continue
        clean = command(spec["clean"])
        result = actor.do(clean, label=f"prune {name} cache ({count / GIB:.1f} GiB, cap {spec['max_gib']:g} GiB)",
                          timeout=float(cfg["cache_timeout_s"]))
        if result is not None:
            if result.rc:
                notes.append(f"{name} cache cleanup failed (exit {result.rc})")
                failed = True
            else:
                notes.append(f"pruned {name} cache")
    return failed


def maintain(
    cfg: dict[str, Any], owner: str, actor: acts.Actor, now: float, home: str
) -> dict[str, Any]:
    run = actor.run
    notes: list[str] = []
    freed = 0
    actor.do(
        ["journalctl", f"--vacuum-size={cfg['journal_vacuum']}"],
        f"vacuum the journal to {cfg['journal_vacuum']}",
        300,
    )
    actor.do(["apt-get", "clean"], "clear the apt cache", 300)
    if shutil.which("snap"):
        for name, revision in disabled_snap_revisions(
            run(["snap", "list", "--all"], timeout=60).out
        ):
            result = actor.do(
                ["snap", "remove", name, f"--revision={revision}"],
                f"remove the disabled Snap {name} r{revision}",
                300,
            )
            if result is not None and result.rc == 0:
                notes.append(f"removed disabled Snap revision {name} r{revision}")
    spotify = Path(str(cfg["spotify_cache"]).format(owner=owner))
    if (
        spotify.is_dir()
        and run(["pgrep", "-u", owner, "-f", cfg["spotify_pattern"]], timeout=15).rc != 0
    ):
        size = versioned.tree_size(spotify)
        if size > float(cfg["spotify_min_gib"]) * GIB:

            def clear_spotify() -> None:
                for child in spotify.iterdir():
                    if child.is_dir() and not child.is_symlink():
                        shutil.rmtree(child, ignore_errors=True)
                    else:
                        child.unlink(missing_ok=True)

            done, _ = actor.apply(
                f"clear the inactive Spotify cache ({size / GIB:.1f} GiB)", clear_spotify
            )
            if done:
                freed += size
                notes.append(f"cleared the inactive Spotify cache ({size / GIB:.1f} GiB)")
    guestfs = Path(cfg["guestfs_dir"])
    if (
        guestfs.is_dir()
        and now - guestfs.stat().st_mtime > float(cfg["guestfs_stale_days"]) * 86400
        and run(["pgrep", "-f", cfg["guestfs_pattern"]], timeout=15).rc != 0
    ):
        done, _ = actor.apply(
            "remove the stale libguestfs appliance cache",
            lambda: shutil.rmtree(guestfs, ignore_errors=True),
        )
        if done:
            notes.append("removed a stale libguestfs appliance cache")
    try:
        for family in versioned.families(
            cfg["versioned"], home, int(cfg["keep_versions"]), versioned.in_use_paths()
        ):
            if not family["prune"]:
                continue
            root = Path(family["root"]).resolve()
            for text in family["excess"]:
                path = Path(text)
                if path.is_symlink() or path.parent.resolve() != root:
                    continue
                size = versioned.tree_size(path)
                done, _ = actor.apply(
                    f"remove the old {family['name']} version {path.name} ({size / GIB:.1f} GiB)",
                    lambda path=path: shutil.rmtree(path) if path.is_dir() else path.unlink(),
                )
                if done:
                    freed += size
                    notes.append(
                        f"removed the old {family['name']} version {path.name} ({size / GIB:.1f} GiB)"
                    )
    except OSError as error:  # cache retention must never stop the rest of housekeeping
        notes.append(f"versioned cache retention failed: {type(error).__name__}")
    failed = False
    try:
        failed = package_caches(cfg, owner, actor, notes, home)
    except Exception as error:  # noqa: BLE001 - the backstop must never stop the rest of housekeeping
        notes.append(f"package cache cleanup failed: {type(error).__name__}")
        failed = True
    return {
        "actions": notes,
        "would": list(actor.would),
        "freed_bytes": freed,
        **({"failed": True} if failed else {}),
    }


def row_text(result: dict[str, Any], live: bool) -> tuple[str, str]:
    """(state, meaning) for the run."""
    if live:
        text = "; ".join(result["actions"]) or "Nothing needed cleaning."
        if result.get("failed"):
            return "warn", "Housekeeping hit a problem: " + text
        return "ok", "Housekeeping ran: " + text if result["actions"] else text
    would = result.get("would") or []
    text = acts.say_would(would) if would else "nothing to do"
    return (
        "warn" if result.get("failed") else "ok"
    ), f"Dry run: would {text}."


def job_actions() -> list[dict[str, str]]:
    return [
        {"kind": "run", "ref": f"sudo -n systemctl start host-steward-{NAME}.service"},
        {"kind": "log", "ref": f"journalctl -u host-steward-{NAME}.service -n 200 --no-pager"},
    ]


def refuse(args: argparse.Namespace, cfg: dict[str, Any], why: str, now: float, post: Any) -> int:
    """Switched on but Nightshift's housekeeping timer still runs: change nothing, say so on the Status board."""
    row = core.job_row(
        NAME,
        cfg["what"],
        "warn",
        why,
        aico_status.machine_id(),
        now,
        cfg["every_min"],
        cfg["slack_min"],
        actions=job_actions(),
    )
    if not args.no_post:
        post(row)
    print(json.dumps({"live": False, "refused": why}, sort_keys=True))
    return 0


def main(args: argparse.Namespace, data: dict[str, Any], post: Any = aico_status.report) -> int:
    cfg = data["jobs"][NAME]
    live = core.acting(data, NAME)
    owner = data["site"]["owner"]["user"]
    now = time.time()
    if live and (why := core.refusal(data, NAME, core.run_command)):
        return refuse(args, cfg, why, now, post)
    with acts.single_run(NAME) as got:
        if not got:
            print("host-steward housekeeping: another run is still going")
            return 0
        actor = acts.Actor(live, run=core.run_command)
        home = acts.owner_env(owner)
        result = maintain(cfg, owner, actor, now, home[0] if home else str(Path.home()))
        acts.write_json(acts.job_dir() / f"{NAME}.json", {"at": now, "live": live, **result})
    state, meaning = row_text(result, live)
    row = core.job_row(
        NAME,
        cfg["what"],
        state,
        meaning,
        aico_status.machine_id(),
        now,
        cfg["every_min"],
        cfg["slack_min"],
        actions=job_actions(),
    )
    if not args.no_post:
        post(row)
    print(json.dumps({"live": live, **result}, sort_keys=True))
    return 1 if result.get("failed") else 0
