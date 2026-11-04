"""host-steward housekeeping: the daily bounded cleanup of caches and garbage that never touches user data.

Port of `maintain` in ns/housekeeping.py: the journal size cap, apt and snap caches, an inactive Spotify cache above
its size, a stale libguestfs appliance, old versions in the families marked prune (Playwright browsers), and
SummitFlow's own daily retention commands as the owner (`st cleanup host --if-stale`), so a stopped scheduler of its
own never lets them stop. Not ported: executor receipt retention and the monthly ledger bundle (both go with
the executor and ledger Nightshift drops). A failing or missing SummitFlow command makes the row warn.

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


def daily_commands(cfg: dict[str, Any], owner: str, actor: acts.Actor, notes: list[str]) -> bool:
    """SummitFlow's own retention commands as the owner. True when one failed or is missing."""
    failed = False
    for cmd in cfg.get("daily_commands") or []:
        wrapped = acts.as_owner(owner, cmd)
        if wrapped is None:
            continue
        result = actor.do(
            wrapped, label=f"run as {owner}: {' '.join(cmd)}", timeout=float(cfg["daily_timeout_s"])
        )
        if result is None:
            continue
        name = " ".join(cmd[:3])
        if core.command_absent(result):
            notes.append(f"{name} is missing from this SummitFlow")
            failed = True
        elif result.rc:
            tail = (
                (result.err or result.out).strip().splitlines()[-1][:160]
                if (result.err or result.out).strip()
                else ""
            )
            notes.append(f"{name} failed (exit {result.rc}){': ' + tail if tail else ''}")
            failed = True
        else:
            try:
                done = json.loads(result.out)
                gone = int(done.get("items_deleted") or 0)
            except (ValueError, TypeError, AttributeError):
                continue
            if done.get("status") != "skipped" and gone:
                notes.append(
                    f"{name}: removed {gone} item(s), {round(int(done.get('bytes_reclaimed') or 0) / GIB, 1)} GiB"
                )
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
        failed = daily_commands(cfg, owner, actor, notes)
    except Exception as error:  # noqa: BLE001 - the backstop must never stop the rest of housekeeping
        notes.append(f"daily retention commands failed: {type(error).__name__}")
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
    ), f"Dry run: would {text}. Nightshift still does this until cutover."


def job_actions() -> list[dict[str, str]]:
    return [
        {"kind": "run", "ref": f"sudo -n systemctl start host-steward-{NAME}.service"},
        {"kind": "log", "ref": f"journalctl -u host-steward-{NAME}.service"},
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
