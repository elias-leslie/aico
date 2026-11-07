"""Write Status rows to Aico on this machine (stdlib only).

    import aico_status
    aico_status.report({
        "id": "davion-sidarli/disk-check", "what": "Disk check", "kind": "check",
        "machine": "davion-sidarli", "state": "warn", "meaning": "Disk 86% full.",
        "last_run": datetime.now(UTC), "next_run": datetime.now(UTC) + timedelta(hours=1),
    })

`report` posts one row or a list to aico-web's loopback API (POST /api/status/rows), never
through a proxy, and never raises: a refused row, a server that is down, an error answer or a bad
URL is logged on the "aico.status" logger and returns False, so a check never fails because its
row could not be written. A row without `machine` gets this host's id (machine_id()).

The row is contracts/status-row.schema.json; check_row holds the same lists and limits, and
tests/test_aico_status.py keeps them equal to the schema and replays the contract fixtures.
Times may be RFC 3339 strings or timezone-aware datetimes; both are sent in UTC. Lengths count
code points and patterns match the whole value, as the schema does.
"""

from __future__ import annotations

import json
import logging
import os
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

KINDS = ("check", "job", "backup", "service", "vm", "machine", "link", "grant", "repo")
STATES = ("ok", "warn", "failed", "off")
ACTION_KINDS = ("run", "log", "detail", "look", "session")
TEXT_LIMITS: dict[str, tuple[int, re.Pattern[str] | None]] = {
    "id": (200, re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@-]*$")),
    "what": (120, None),
    "machine": (100, re.compile(r"^[a-z0-9][a-z0-9._-]*$")),
    "project": (100, re.compile(r"^[a-z0-9][a-z0-9_-]*$")),
    "meaning": (800, None),
}
REQUIRED = ("id", "what", "kind", "machine", "state", "meaning")
FIELDS = frozenset(REQUIRED + ("project", "last_run", "next_run", "actions"))
MAX_ACTIONS = 4
MAX_ACTION_REF = 500

# aico-web's port is project.identity.json runtime.backend_port; AICO_STATUS_URL overrides.
DEFAULT_URL = "http://127.0.0.1:3002/api/status/rows"
TIMEOUT_SECONDS = 5.0

log = logging.getLogger("aico.status")

# Straight to loopback: an http_proxy in the environment must not carry the row elsewhere.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

_RFC3339 = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")


def machine_id(name: str | None = None) -> str:
    """This host's id on its rows: the short host name in lower case ('davion-sidarli')."""
    return (name or socket.gethostname()).split(".")[0].lower()


class RowError(ValueError):
    """A row the contract refuses; `field` names the first offending field ('row' for the whole)."""

    def __init__(self, field: str, message: str) -> None:
        super().__init__(f"{field}: {message}")
        self.field = field


def utc_text(value: datetime) -> str:
    """A timezone-aware datetime as aico-web writes it: UTC, milliseconds, Z."""
    at = value.astimezone(UTC)
    return at.strftime("%Y-%m-%dT%H:%M:%S.") + f"{at.microsecond // 1000:03d}Z"


def _time(row: Mapping[str, Any], field: str) -> str | None:
    value = row.get(field)
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            raise RowError(field, "a datetime needs a timezone")
        return utc_text(value)
    if isinstance(value, str) and _RFC3339.fullmatch(value):
        try:
            return utc_text(datetime.fromisoformat(value))
        except ValueError:
            pass
    raise RowError(field, "must be an RFC 3339 time with a zone, e.g. 2026-11-03T03:30:00Z")


def _text(row: Mapping[str, Any], field: str, required: bool) -> str | None:
    value = row.get(field)
    if value is None:
        if required:
            raise RowError(field, "is required")
        return None
    limit, pattern = TEXT_LIMITS[field]
    if not isinstance(value, str) or not value:
        raise RowError(field, "must be a non-empty string")
    if len(value) > limit:
        raise RowError(field, f"is longer than {limit} characters")
    if pattern is not None and not pattern.fullmatch(value):
        raise RowError(field, "has characters it may not have")
    return value


def _one_of(row: Mapping[str, Any], field: str, values: tuple[str, ...]) -> str:
    value = row.get(field)
    if not isinstance(value, str) or value not in values:
        raise RowError(field, f"must be one of {', '.join(values)}")
    return value


def _actions(value: Any) -> list[dict[str, Any]] | None:
    if value is None:
        return None
    if not isinstance(value, list) or len(value) > MAX_ACTIONS:
        raise RowError("actions", f"must be a list of at most {MAX_ACTIONS}")
    actions = []
    for item in value:
        if not isinstance(item, dict) or set(item) - {"kind", "ref", "owner_only"}:
            raise RowError("actions", "each action has kind, ref and optional owner_only")
        if item.get("kind") not in ACTION_KINDS:
            raise RowError("actions", f"an action's kind must be one of {', '.join(ACTION_KINDS)}")
        ref = item.get("ref")
        if not isinstance(ref, str) or not 0 < len(ref) <= MAX_ACTION_REF:
            raise RowError("actions", f"an action's ref is 1 to {MAX_ACTION_REF} characters")
        action: dict[str, Any] = {"kind": item["kind"], "ref": ref}
        if "owner_only" in item:
            if not isinstance(item["owner_only"], bool):
                raise RowError("actions", "owner_only must be a boolean")
            action["owner_only"] = item["owner_only"]
        actions.append(action)
    return actions


def check_row(row: Any) -> dict[str, Any]:
    """The row as it will be sent (times in UTC); raises RowError when the contract refuses it."""
    if not isinstance(row, Mapping):
        raise RowError("row", "a row is a JSON object")
    for key in row:
        if key not in FIELDS:
            raise RowError(str(key), f"a row has no field {key}")
    checked: dict[str, Any] = {
        "id": _text(row, "id", True),
        "what": _text(row, "what", True),
        "kind": _one_of(row, "kind", KINDS),
        "machine": _text(row, "machine", True),
        "state": _one_of(row, "state", STATES),
        "meaning": _text(row, "meaning", True),
    }
    optional = {
        "project": _text(row, "project", False),
        "last_run": _time(row, "last_run"),
        "next_run": _time(row, "next_run"),
        "actions": _actions(row.get("actions")),
    }
    if checked["kind"] == "machine" and optional["next_run"] is None:
        raise RowError("next_run", "a machine row needs next_run: the unknown rule reads it")
    checked.update({key: value for key, value in optional.items() if value is not None})
    return checked


def report(
    rows: Mapping[str, Any] | Sequence[Mapping[str, Any]],
    *,
    url: str | None = None,
    timeout: float = TIMEOUT_SECONDS,
) -> bool:
    """Posts one row or a list (all or none); True when aico-web took them. Never raises."""
    target = url or os.environ.get("AICO_STATUS_URL") or DEFAULT_URL
    try:
        return _post(rows, target, timeout)
    except Exception:
        log.exception("status row not sent to %s", target)
        return False


def _post(rows: Mapping[str, Any] | Sequence[Mapping[str, Any]], target: str, timeout: float) -> bool:
    def with_machine(row: Any) -> Any:
        return {"machine": machine_id(), **row} if isinstance(row, Mapping) else row

    try:
        payload: Any = (
            check_row(with_machine(rows))
            if isinstance(rows, Mapping)
            else [check_row(with_machine(row)) for row in rows]
        )
    except RowError as error:
        log.error("status row not sent: %s", error)
        return False
    request = urllib.request.Request(
        target,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with _OPENER.open(request, timeout=timeout) as response:
            response.read()
        return True
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:500]
        log.error("status row refused by %s (HTTP %s): %s", target, error.code, detail)
    except (OSError, TimeoutError) as error:
        log.error("status row not sent, Aico is not answering at %s: %s", target, error)
    return False


def remove(row_id: str, *, url: str | None = None, timeout: float = TIMEOUT_SECONDS) -> bool:
    """Drops a row whose thing is gone (DELETE /api/status/rows?id=); True when it went. Never raises."""
    target = url or os.environ.get("AICO_STATUS_URL") or DEFAULT_URL
    request = urllib.request.Request(
        target + "?" + urllib.parse.urlencode({"id": row_id}), method="DELETE"
    )
    try:
        with _OPENER.open(request, timeout=timeout) as response:
            response.read()
        return True
    except Exception:
        log.exception("status row %s not removed at %s", row_id, target)
        return False
