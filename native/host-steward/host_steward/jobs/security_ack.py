"""host-steward security-ack: confirm open login-setting, listener and sudo problems (root).

Marks every open tripwire and sudo event as confirmed (the owner checked it, it was a
deliberate test, or an agent's own change) with a note; they clear at the next check. `--event ID` confirms one: a
tripwire event id, or the sudo id a row shows ("sensitive.…" or "failure.…").
"""

from __future__ import annotations

import argparse
import time
from collections.abc import Callable
from typing import Any

import aico_status
from host_steward.checks import sudo, tripwire

NAME = "security-ack"
HELP = "confirm all open tripwire and sudo events, or one with --event (root)"


def add_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--note", default="confirmed by owner", help="why (kept with the event)")
    parser.add_argument("--event", help="only this event id (shown in the row's text)")


def acknowledge(data: dict[str, Any], note: str, now: float, event: str | None = None) -> int:
    """Marks the open events (or only `event`) confirmed in the tripwire and sudo state files. Returns the count."""
    auth = data["site"]["auth"]
    host = data["checks"]["sudo"]["host"]
    n = 0
    paths = [
        *sorted((tripwire.state_root() / auth["tripwire_dir"]).glob("*.json")),
        tripwire.sudo_state_path(auth),
    ]
    for path in paths:
        sudo_file = path == tripwire.sudo_state_path(auth)
        with tripwire.locked(path):
            try:
                state = tripwire.load_json(path)
            except tripwire.Unreadable:
                continue
            events = state.get("events")
            if not isinstance(events, list):
                continue
            wanted = None
            if event is not None and sudo_file:
                codes = sudo.sudo_open(state, host, now, float(auth["hold_hours"]))
                wanted = {id(e) for e in codes.get(event, [])}
            changed = 0
            for e in events:
                if not isinstance(e, dict) or e.get("ack"):
                    continue
                if event is not None and (
                    id(e) not in wanted if wanted is not None else e.get("id") != event
                ):
                    continue
                e["ack"], e["ack_note"], e["ack_at"] = True, note[:200], now
                changed += 1
            if changed:
                tripwire.save_json(path, state, mode=0o600 if sudo_file else 0o644)
            n += changed
    return n


def main(
    args: argparse.Namespace, data: dict[str, Any], post: Callable[..., bool] = aico_status.report
) -> int:
    try:
        n = acknowledge(data, args.note, time.time(), args.event)
    except OSError as error:
        print(f"could not update the state files: {error.strerror or error} (run it with sudo)")
        return 1
    print(f"acknowledged {n} tripwire/sudo events; they clear at the next check")
    return 0 if n or not args.event else 1
