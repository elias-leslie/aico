"""What every host check shares: the data files, one command runner, signals and the row they make.

A check is a module in host_steward/checks with ID and run(ctx) -> list[Signal]. It reads its
thresholds from ctx.cfg (data/checks.toml), never from constants, and runs commands only through
ctx.run, so a test hands it fixture output. core turns the signals into one Status row: the worst
state, plus the plain-words meaning from data/meanings.toml (the explain table).
"""

from __future__ import annotations

import fnmatch
import json
import os
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


@dataclass
class Ctx:
    """What a check gets: its settings, the clock, the command runner and its own saved state."""

    cfg: dict[str, Any]
    site: dict[str, Any]
    now: float
    run: Runner = run_command
    state: dict[str, Any] = field(default_factory=dict)
    cache: dict[str, Any] = field(default_factory=dict)

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


def save_state(state: Mapping[str, Any], path: Path | None = None) -> None:
    target = path or STATE_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(json.dumps(state, sort_keys=True, indent=1))
    tmp.replace(target)


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


def explain(
    code: str, fields: Mapping[str, Any], meanings: Mapping[str, Any], full: bool, state: str = "warn"
) -> str:
    """The plain-words text for one signal: what happened, what it means, what happens next.

    meanings.toml keys an entry "code:state" (an ok note worth reading) or "code" (a problem); an ok signal
    with no "code:ok" entry says its `detail` field, else the code."""
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
            {"kind": "run", "ref": f"host-steward check --only {check}"},
            {"kind": "log", "ref": "journalctl -u host-steward-check.service"},
        ],
    }
