"""What every host check shares: the data files, one command runner, signals and the row they make.

A check is a module in host_steward/checks with ID and run(ctx) -> list[Signal]. It reads its
thresholds from ctx.cfg (data/checks.toml), never from constants, and runs commands only through
ctx.run, so a test hands it fixture output. core turns the signals into one Status row: the worst
state, plus the plain-words meaning from data/meanings.toml (the explain table).
"""

from __future__ import annotations

import contextlib
import fnmatch
import grp
import json
import os
import re
import subprocess
import tomllib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import aico_status

DATA_DIR = Path(os.environ.get("HOST_STEWARD_DATA") or Path(__file__).resolve().parent / "data")
STATE_PATH = Path(os.environ.get("HOST_STEWARD_STATE") or "/var/lib/host-steward/state.json")
RANK = {"ok": 0, "off": 0, "warn": 1, "failed": 2}
MEANING_LIMIT = aico_status.TEXT_LIMITS["meaning"][0]


@dataclass
class Signal:
    """One thing a check looked at. `note` keeps an ok signal in the row's meaning (a fact worth reading)."""

    code: str
    state: str
    fields: dict[str, Any] = field(default_factory=dict)
    note: bool = False


@dataclass
class Result:
    rc: int
    out: str = ""
    err: str = ""


Runner = Callable[..., Result]


def run_command(argv: Sequence[str], timeout: float = 60, input_text: str | None = None) -> Result:
    """Runs a command with no shell; a missing program or a timeout is a Result (rc 127 / 124), not an error."""
    try:
        done = subprocess.run(
            list(argv),
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
            input=input_text,
            check=False,
        )
    except FileNotFoundError as error:
        return Result(127, "", str(error))
    except subprocess.TimeoutExpired:
        return Result(124, "", f"timed out after {timeout:g}s")
    except OSError as error:
        return Result(126, "", str(error))
    return Result(done.returncode, done.stdout, done.stderr)


def command_absent(result: Result) -> bool:
    """The command, or the subcommand or option asked for, does not exist (not that it ran and failed)."""
    text = f"{result.out}\n{result.err}"
    return bool(
        result.rc == 127 or (result.rc == 2 and re.search(r"No such (command|option)", text))
    )


@dataclass
class Ctx:
    """What a check gets: its settings, the clock, the command runner and its own saved state. `acting` is the
    data file's [acting] table (which controllers act), for the few checks that read what a controller wrote."""

    cfg: dict[str, Any]
    site: dict[str, Any]
    now: float
    run: Runner = run_command
    state: dict[str, Any] = field(default_factory=dict)
    cache: dict[str, Any] = field(default_factory=dict)
    acting: Mapping[str, bool] = field(default_factory=dict)

    def read(self, path: str) -> str | None:
        try:
            return Path(path).read_text(errors="replace")
        except OSError:
            return None


def load_data(directory: Path | None = None) -> dict[str, Any]:
    """checks.toml (settings, schedules, site values) plus meanings.toml (the explain table)."""
    base = directory or DATA_DIR
    with (base / "checks.toml").open("rb") as handle:
        data = tomllib.load(handle)
    with (base / "meanings.toml").open("rb") as handle:
        data["meanings"] = tomllib.load(handle)
    return data


def load_state(path: Path | None = None) -> dict[str, Any]:
    try:
        data = json.loads((path or STATE_PATH).read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write_json(
    path: Path | str,
    data: Any,
    *,
    mode: int | None = None,
    dir_mode: int | None = None,
    group: str | None = None,
    compact: bool = False,
) -> None:
    """Writes `data` as JSON through a temp file beside it and a rename, so a reader never sees half a file. `mode` is
    the file's permission (the umask's when None), `dir_mode` the mode of a directory this makes, `group` a group
    name to hand the file to (root only; ignored when the group or the right is missing)."""
    target = Path(path)
    if dir_mode is None:
        target.parent.mkdir(parents=True, exist_ok=True)
    else:
        target.parent.mkdir(mode=dir_mode, parents=True, exist_ok=True)
    tmp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    try:
        text = (
            json.dumps(data, sort_keys=True, separators=(",", ":"))
            if compact
            else json.dumps(data, sort_keys=True, indent=1)
        )
        tmp.write_text(text)
        if group:
            with contextlib.suppress(KeyError, OSError):
                os.chown(tmp, -1, grp.getgrnam(group).gr_gid)
        if mode is not None:
            os.chmod(tmp, mode)
        tmp.replace(target)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def save_state(state: Mapping[str, Any], path: Path | None = None) -> None:
    write_json(path or STATE_PATH, state)


def timestamp(value: Any) -> float:
    """Epoch seconds from either form a job file keeps its time in: a number, or an ISO 8601 time (naive means UTC).
    0.0 when it is neither, so a missing or odd time reads as very old."""
    if isinstance(value, bool):
        return 0.0
    if isinstance(value, int | float):
        return float(value)
    try:
        at = datetime.fromisoformat(str(value))
    except ValueError:
        return 0.0
    return (at if at.tzinfo else at.replace(tzinfo=UTC)).timestamp()


def iso_time(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, UTC).isoformat()


def cap_state(code: str, state: str, caps: Mapping[str, str]) -> str:
    """The data file's cap for a signal (first fnmatch wins): a record-only signal never goes past ok."""
    for pattern, cap in caps.items():
        if fnmatch.fnmatchcase(code, pattern):
            return state if RANK[state] <= RANK[cap] else cap
    return state


class _Fields(dict):
    def __missing__(self, key: str) -> str:
        return "?"


def _say(template: str, fields: Mapping[str, Any]) -> str:
    try:
        return template.format_map(_Fields(fields)).strip()
    except (ValueError, IndexError, AttributeError):
        return template.strip()


def _lists(fields: Mapping[str, Any], meanings: Mapping[str, Any]) -> dict[str, Any]:
    """A list field reads as its first [lists] show items, then the rest as a count ([lists] more)."""
    style = meanings.get("lists", {})
    show, more = int(style.get("show", 3)), str(style.get("more", "{shown}"))
    out = dict(fields)
    for key, value in fields.items():
        if isinstance(value, list | tuple):
            items = [str(item) for item in value]
            shown = ", ".join(items[:show])
            out[key] = more.format(shown=shown, n=len(items) - show) if len(items) > show else shown
    return out


def explain(
    code: str,
    fields: Mapping[str, Any],
    meanings: Mapping[str, Any],
    full: bool,
    state: str = "warn",
) -> str:
    """The plain-words text for one signal: what happened, what it means, what happens next.

    meanings.toml keys an entry "code:state" (an ok note worth reading) or "code" (a problem); an ok signal
    with no "code:ok" entry says its `detail` field, else the code. A list field is shortened per [lists]."""
    fields = _lists(fields, meanings)
    table = meanings.get("signal", {})
    entry = table.get(f"{code}:{state}") or (table.get(code) if state != "ok" else None)
    if not isinstance(entry, dict):
        return _say(str(fields.get("detail") or code), fields)
    parts = [_say(str(entry.get("what", code)), fields)]
    if full:
        parts += [_say(str(entry[key]), fields) for key in ("impact", "next") if entry.get(key)]
    return " ".join(part.rstrip(".") + "." for part in parts if part)


def meaning(check: str, signals: Sequence[Signal], meanings: Mapping[str, Any]) -> str:
    """One sentence group for the row: the worst problem in full, other problems short, else the ok line."""
    problems = sorted((s for s in signals if RANK[s.state] > 0), key=lambda s: -RANK[s.state])
    if not problems:
        base = str(meanings.get("ok", {}).get(check) or "Nothing to report.")
        notes = [explain(s.code, s.fields, meanings, False, s.state) for s in signals if s.note][:2]
        text = " ".join([base.rstrip(".") + ".", *notes])
    else:
        text = explain(problems[0].code, problems[0].fields, meanings, True, problems[0].state)
        rest = [explain(s.code, s.fields, meanings, False, s.state) for s in problems[1:3]]
        if rest:
            text += " Also: " + " ".join(rest)
        if len(problems) > 3:
            text += f" And {len(problems) - 3} more."
    if len(text) > MEANING_LIMIT:
        text = text[: MEANING_LIMIT - 1].rstrip() + "…"
    return text


def make_row(
    check: str,
    signals: Sequence[Signal],
    cfg: Mapping[str, Any],
    meanings: Mapping[str, Any],
    machine: str,
    now: float,
    caps: Mapping[str, str],
) -> dict[str, Any]:
    """The Status row for one check run: id, what, state, meaning, last_run, next_run, actions."""
    signals = [Signal(s.code, cap_state(s.code, s.state, caps), s.fields, s.note) for s in signals]
    state = max((s.state for s in signals), key=lambda value: RANK[value], default="ok")
    if not signals:
        state = "failed"
        signals = [Signal("check.empty", "failed", {"check": check})]
    every = float(cfg["every_min"]) + float(cfg["slack_min"])
    at = datetime.fromtimestamp(now, UTC)
    return {
        "id": f"{machine}/check-{check}",
        "what": cfg["what"],
        "kind": "check",
        "machine": machine,
        "state": state,
        "meaning": meaning(check, signals, meanings),
        "last_run": at,
        "next_run": at + timedelta(minutes=every),
        "actions": [
            # sudoers allows starting the unit, which runs every check that is due (no unit takes --only)
            {"kind": "run", "ref": "sudo -n systemctl start host-steward-check.service"},
            {"kind": "log", "ref": "journalctl -u host-steward-check.service"},
        ],
    }


def acting(data: Mapping[str, Any], name: str) -> bool:
    """Whether a controller that changes the host is switched on. [acting] in checks.toml; every piece starts off
    (dry run) so only one controller, Nightshift's or this one, acts at a time. Cutover turns them on together."""
    return bool(data.get("acting", {}).get(name, False))


def counterparts_running(
    data: Mapping[str, Any], name: str, run: Runner = run_command
) -> list[str]:
    """Nightshift's units that do the same work as the job `name`, listed in [counterparts.NAME] (system = [...],
    user = [...] for the owner's user manager), that are enabled or active now: "unit (enabled, active)"."""
    table = data.get("counterparts", {}).get(name) or {}
    owner = data["site"]["owner"]["user"]
    user_scope = ["--user", *(["-M", f"{owner}@"] if os.geteuid() == 0 else [])]
    found = []
    for scope, flags in (("system", []), ("user", user_scope)):
        for unit in table.get(scope) or []:
            on = [
                word.removeprefix("is-")
                for word in ("is-enabled", "is-active")
                if run(["systemctl", "--no-ask-password", *flags, word, unit], timeout=30).rc == 0
            ]
            if on:
                found.append(f"{unit} ({', '.join(on)})")
    return found


def refusal(data: Mapping[str, Any], name: str, run: Runner = run_command) -> str | None:
    """Why the controller `name` must not act right now (plain words for its Status row), else None. Two controllers
    acting on the same host would fight, so one that is switched on still stands down while Nightshift's counterpart
    is enabled or active."""
    running = counterparts_running(data, name, run)
    if not running:
        return None
    return (
        f"Set to act, but Nightshift's {', '.join(running)} is still on, so it did nothing. "
        "Turn Nightshift's off first; the cutover does both together."
    )


def job_row(
    name: str,
    what: str,
    state: str,
    meaning: str,
    machine: str,
    now: float,
    every_min: float,
    slack_min: float,
    kind: str = "job",
    actions: Sequence[Mapping[str, str]] | None = None,
) -> dict[str, Any]:
    """The Status row for a piece that is not a check (a controller, a collector, a timer job)."""
    at = datetime.fromtimestamp(now, UTC)
    text = (
        meaning
        if len(meaning) <= MEANING_LIMIT
        else meaning[: MEANING_LIMIT - 1].rstrip() + "\u2026"
    )
    return {
        "id": f"{machine}/{kind}-{name}",
        "what": what,
        "kind": kind,
        "machine": machine,
        "state": state,
        "meaning": text,
        "last_run": at,
        "next_run": at + timedelta(minutes=every_min + slack_min),
        "actions": list(
            actions or [{"kind": "log", "ref": f"journalctl -u host-steward-{name}.service"}]
        ),
    }
