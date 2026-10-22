#!/usr/bin/env python3
"""Bounded owner root control and observation. Emits metadata, never terminal text.

Use `st aico roots [REQUEST_ID] [--watch SECONDS]` for compact snapshots or
bounded change-only JSONL. Discovery reads existing private catalog/owner receipts
and verifies exact tmux server/pane identity once; a watch never re-pins.
Unknown TUI profiles are unavailable. Output contains no terminal or draft text.

Explicit-pin compatibility: invoke with --root-socket, --owner-socket, --tmux-socket,
--duration SECONDS and one or more --root JSON objects containing all Pin fields.
Pins come from existing owner receipts and the exact managed tmux server identity;
this observation mode never creates, submits to, or re-pins a root. JSONL on stdout
contains initial baselines and changes only. Terminal states describe visible TUI
chrome, not whether the assigned objective is complete. No files are written.
"""

from __future__ import annotations

import argparse
import dataclasses
import fcntl
import hashlib
import http.client
import json
import math
import os
import re
import select
import selectors
import signal
import socket
import subprocess
import threading
import time
import typing
from collections.abc import Callable
from pathlib import Path
from urllib.parse import quote, urlsplit

CAPTURE_LIMIT = 32 * 1024
RECEIPT_LIMIT = 16 * 1024
CATALOG_LIMIT = 256 * 1024
ROOT_LIMIT = 128
CONTROL = re.compile(
    r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|"
    r"\x1b[P^_].*?\x1b\\|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]|"
    r"[\x00-\x08\x0b-\x1f\x7f-\x9f]",
    re.DOTALL,
)
PROMPT = re.compile(r"^\s*[›❯]\s?(.*)$")
EMPTY_PROMPTS = {"", "Ask Codex to do anything"}
WORKED = re.compile(r"^[─━\s]*(?:[•●]\s*)?Worked for\s+\S.+$", re.IGNORECASE)
ACTIVE = re.compile(
    r"^[\s•●◦✻✽✶✳⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]*"
    r"(?:(?:Working|Compacting context)(?:…|\.\.\.)?(?:\s*\([^)]*\))?"
    r"(?:\s*·\s*\d+\s+background terminals? running(?:…|\.\.\.)?"
    r"(?:\s*·\s*/ps to view\s*·\s*/stop to close)?)?|"
    r"(?:Running|Calling|Executing|Thinking|Searching|Reading|Editing|Testing)\b.*"
    r"(?:esc to interrupt|\btool\b|\([^)]*\)))\s*$", re.IGNORECASE,
)
FOOTER = re.compile(
    r"^(?:[─━]+|.*\s·\s.*\bcontext\s+\d{1,3}%\s*(?:left|remaining)\b.*|"
    r"context\s+\d{1,3}%\s*(?:left|remaining)\b.*|"
    r"\d{1,3}%\s*context\s*(?:left|remaining)\b.*)$", re.IGNORECASE,
)
BANNERS = (
    ("approval", re.compile(
        r"^(?:[⚠!]\s*)?(?:Would you like to (?:run|proceed).*\?|"
        r"Do you want to (?:run|proceed|allow).*\?|Approval required(?:[:.].*)?|"
        r"Waiting for (?:your )?approval[.!]?)$", re.IGNORECASE)),
    ("capacity", re.compile(
        r"^(?:[⚠!]\s*)?(?:You've hit your usage limit.*|"
        r"You have hit your usage limit.*|Usage limit reached.*|"
        r"Rate limit (?:reached|exceeded).*|Model (?:is )?(?:at capacity|overloaded).*|"
        r"API Error:\s*(?:429|529)\b.*)$", re.IGNORECASE)),
    ("error", re.compile(
        r"^(?:[⚠!]\s*(?:Error|Connection failed|Authentication failed)\b.*|"
        r"API Error:\s*(?:401|403|5\d\d)\b.*|"
        r"Reconnecting\.\.\.\s*\d+/\d+.*)$", re.IGNORECASE)),
)
CLAUDE_PAUSED = re.compile(r"Session paused[.!]?", re.IGNORECASE)
CLAUDE_SAFEGUARD = re.compile(r"Safeguard\b.*\bflagged\b.*", re.IGNORECASE)
CLAUDE_CHOICE = re.compile(r"[1-9]\.\s+\S.*")
CLAUDE_RETRY = re.compile(
    r"Waiting for API response\b.*\bwill retry\s+in\s+\d+\s*"
    r"(?:s|sec(?:ond)?s?)\b[.!]?", re.IGNORECASE,
)
CLAUDE_PROMPT = re.compile(r"\s*[❯›]\s?.*")
SECRET = re.compile(
    r"(?is)(?:-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----.*?"
    r"(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)|"
    r"\b(?:api[_-]?key|access[_-]?token|password|secret|authorization)[\"']?"
    r"\s*[:=]\s*(?:Bearer\s+\S+|\"[^\"]*\"|'[^']*'|\S+)|"
    r"\bBearer\s+\S+|\bsk-[\w-]+|"
    r"\b(?:gh[pousr]_[\w]+|AKIA[0-9A-Z]{16})\b|"
    r"\b[a-z][a-z0-9+.-]*://[^\s/@]+:[^\s/@]+@[^\s]+)"
)


class Unavailable(Exception):
    """Only a closed reason code leaves this exception boundary."""


class IdentityChanged(Exception):
    pass


class Ended(Exception):
    pass


class Stopped(Exception):
    pass


class Refused(Unavailable):
    """A qualified owner rejection: the owner reports that nothing was applied."""


# ECMAScript TrimString whitespace and line terminators, matching the owner.
LABEL_TRIM = ("\t\n\x0b\x0c\r \xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
              "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
LABEL_INVALID = re.compile(r"[\x00-\x1f\x7f-\x9f\ud800-\udfff\u2028\u2029]")
BOUNDS = ("x", "y", "width", "height")
KEY = r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}"
THREAD = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
GENERATION = r"[0-9a-f]{64}"
WIDGET = r"[0-9a-f]{8}"
# Agent tool slugs, as Tether's registry spells them (src/tools.ts SLUG_RE).
TOOL_SLUG = r"[a-z0-9_-]{1,50}"
# Owner rejections that are definitive before any view or lifecycle effect.
OWNER_REFUSALS = {400: {"invalid_body", "invalid_generation"}, 404: {"not_found"},
                  409: {"stale_generation", "workload_unavailable", "busy"}, 410: {"ended"},
                  503: {"gui_unavailable", "position_unavailable"}}


def view_label(value: object) -> str | None:
    """Owner label contract; contracts/view-mutation-vectors.json pins it."""
    if not isinstance(value, str):
        return None
    label = value.strip(LABEL_TRIM)
    if not label or LABEL_INVALID.search(label) or len(label.encode("utf-8")) > 160:
        return None
    return label


def view_bounds(value: object) -> dict | None:
    """Owner integer bounds contract; contracts/view-mutation-vectors.json pins it."""
    if not isinstance(value, dict) or set(value) != set(BOUNDS):
        return None
    bounds: dict[str, int] = {}
    for key in BOUNDS:
        item = typing.cast(dict[str, object], value)[key]
        if isinstance(item, bool) or not isinstance(item, int) or abs(item) > 100_000:
            return None
        bounds[key] = item
    return bounds if bounds["width"] >= 360 and bounds["height"] >= 240 else None


def owner_reply(status: int, data: dict, unqualified: str) -> None:
    """Raise for any non-200 reply; only exact known rejections are definitive."""
    if status == 200:
        return
    reason = data.get("error")
    if isinstance(reason, str) and reason in OWNER_REFUSALS.get(status, ()):
        raise Refused(reason)
    raise Unavailable(reason if reason in ("outcome_uncertain", "blocked", "close_uncertain")
                      else unqualified)


@dataclasses.dataclass(frozen=True)
class Pin:
    requestId: str
    widgetId: str
    logicalSessionId: str
    generation: str
    sessionId: str
    tmuxSessionId: str
    paneId: str
    tmuxServerId: str

    @classmethod
    def parse(cls, value: str) -> Pin:
        data = json.loads(value)
        if not isinstance(data, dict) or set(data) != {f.name for f in dataclasses.fields(cls)}:
            raise ValueError("root must contain exactly the Pin fields listed in --help")
        patterns = {
            "requestId": KEY,
            "widgetId": WIDGET,
            "logicalSessionId": r"aico-root-[A-Za-z0-9-]{1,100}",
            "generation": GENERATION,
            "sessionId": KEY,
            "tmuxSessionId": r"\$\d+",
            "paneId": r"%\d+",
            "tmuxServerId": r"[0-9a-f]{8,64}",
        }
        if any(not isinstance(data[k], str) or not re.fullmatch(p, data[k])
               for k, p in patterns.items()):
            raise ValueError("invalid root identity")
        return cls(**data)


def socket_path(value: str) -> str:
    if (not isinstance(value, str) or not value.startswith("/") or len(value.encode()) > 107
            or any(p in ("", ".", "..") for p in value[1:].split("/"))
            or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise argparse.ArgumentTypeError("socket must be an exact normalized absolute path")
    return value


def local_root_url(value: str) -> str:
    """Use the established loopback A-Term owner route without proxy/auth bypass."""
    try:
        parsed = urlsplit(value)
        valid = (parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
                 and not parsed.username and not parsed.password and not parsed.query
                 and not parsed.fragment and parsed.port is not None)
    except ValueError:
        valid = False
    if not valid:
        raise argparse.ArgumentTypeError("A-Term root control requires an exact loopback HTTP URL")
    return value.rstrip("/")


def runtime_dir() -> str:
    return os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"


# Raw environment defaults; each command keeps its own validation and error path.
def default_gui_socket() -> str:
    return os.environ.get("AICO_GUI_CONTROL_SOCKET", f"{runtime_dir()}/aico/gui-control.sock")


def default_owner_socket() -> str:
    return os.environ.get("AICO_CONTROL_SOCKET", f"{runtime_dir()}/aico/control.sock")


def tether_socket() -> str:
    """Tether's control socket: $TETHER_SOCKET, else $XDG_RUNTIME_DIR/tether/<instance>/control.sock."""
    configured = os.environ.get("TETHER_SOCKET", "").strip()
    if configured:
        return configured
    instance = os.environ.get("TETHER_INSTANCE", "").strip() or "default"
    return f"{runtime_dir()}/tether/{instance}/control.sock"


PROJECTS_LIMIT = 1 << 20


def a_term_identity_url(timeout: float = 2.0) -> str:
    """http://127.0.0.1:<backend_port> from A-Term's project.identity.json.

    The checkout is the "a-term" root in Tether's project list. Raises
    ArgumentTypeError, naming the override, when either can't be read.
    """
    connection = http.client.HTTPConnection("localhost", timeout=timeout)
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.settimeout(timeout)
        client.connect(tether_socket())
        connection.sock = client
        connection.request("GET", "/v1/projects", headers={"Connection": "close"})
        response = connection.getresponse()
        body = response.read(PROJECTS_LIMIT + 1)
        if response.status != 200 or len(body) > PROJECTS_LIMIT:
            raise ValueError("projects unavailable")
        projects = json.loads(body)["projects"]
        root = next(item["root"] for item in projects if isinstance(item, dict) and item.get("id") == "a-term")
        identity = json.loads((Path(root) / "project.identity.json").read_text())
        port = identity["runtime"]["backend_port"]
        if isinstance(port, bool) or not isinstance(port, int) or not 0 < port < 65536:
            raise ValueError("bad backend_port")
    except (OSError, ValueError, KeyError, TypeError, StopIteration, http.client.HTTPException):
        raise argparse.ArgumentTypeError(
            "A-Term's port is unknown: Tether's project list or A-Term's project.identity.json "
            "could not be read; pass --root-url (when running this script directly, "
            "A_TERM_ROOT_CONTROL_URL also works; st does not pass it through)") from None
    finally:
        connection.close()
        client.close()
    return f"http://127.0.0.1:{port}"


def default_aterm_url() -> str:
    """$A_TERM_ROOT_CONTROL_URL, else A-Term's own port from its project identity."""
    configured = os.environ.get("A_TERM_ROOT_CONTROL_URL")
    return configured if configured is not None else a_term_identity_url()


def owner_endpoint(surface: str, root_socket: str | None, root_url: str | None) -> str:
    """An explicit option, else the validated environment default; raises ArgumentTypeError."""
    if surface == "aico":
        return root_socket or socket_path(default_gui_socket())
    return root_url or local_root_url(default_aterm_url())


def classify_claude(raw: bytes) -> tuple[dict, str]:
    """Recognize only current modal/retry chrome; never retain Claude pane text."""
    if len(raw) > CAPTURE_LIMIT:
        raise Unavailable("capture_limit")
    lines = CONTROL.sub("", raw.decode("utf-8", errors="replace")).splitlines()
    visible = []
    fenced = False
    for line in lines:
        fence = line.strip().startswith(("```", "~~~"))
        visible.append(not fenced and not fence)
        if fence:
            fenced = not fenced
    tail = [(i, line.strip()) for i, line in enumerate(lines)
            if line.strip() and i >= len(lines) - 12]
    # A prompt in this region can be an editable draft, and a modal above a
    # later prompt is history. Neither is current decision chrome.
    current = bool(tail) and all(visible[i] for i, _ in tail) and not any(
        CLAUDE_PROMPT.fullmatch(line) for _, line in tail)
    terminal = "ambiguous"
    if current:
        body = [line for _, line in tail]
        retry = bool(CLAUDE_RETRY.fullmatch(body[-1]))
        choice = body[:-1] if retry else body
        # The complete modal must end at the visible bottom (or immediately
        # before the retry countdown). Prefix prose is allowed as context.
        paused = next((i for i, line in enumerate(choice) if CLAUDE_PAUSED.fullmatch(line)), None)
        if (paused is not None and paused + 2 < len(choice)
                and CLAUDE_SAFEGUARD.fullmatch(choice[paused + 1])
                and all(CLAUDE_CHOICE.fullmatch(line) for line in choice[paused + 2:])):
            terminal = "input_required"
        elif retry:
            terminal = "retrying"
    return {"terminal": terminal, "draft_present": False, "low_context": False,
            "banners": [], "markers": []}, ""


def classify(raw: bytes, profile: str = "codex") -> tuple[dict, str]:
    """Returns closed metadata and one sanitized sample; neither draft nor prose is emitted."""
    if profile == "claude-code":
        return classify_claude(raw)
    if profile != "codex":
        raise Unavailable("unsupported_profile")
    if len(raw) > CAPTURE_LIMIT:
        raise Unavailable("capture_limit")
    text = CONTROL.sub("", raw.decode("utf-8", errors="replace"))
    lines = text.splitlines()
    visible = []
    fenced = False
    for line in lines:
        fence = line.strip().startswith(("```", "~~~"))
        visible.append(not fenced and not fence)
        if fence:
            fenced = not fenced
    prompts = [i for i, line in enumerate(lines) if visible[i] and PROMPT.match(line)]
    final_prompt = prompts[-1] if prompts else len(lines)
    worked = [i for i, line in enumerate(lines)
              if i < final_prompt and visible[i] and WORKED.match(line)]
    prompt = prompts[-1] if prompts else None
    completion = worked[-1] if worked else -1
    # The editable region begins at the final prompt. Wrapped lines are drafts
    # until recognizable footer chrome; no draft bytes enter retained samples.
    draft = False
    if prompt is not None:
        match = PROMPT.match(lines[prompt])
        assert match is not None
        draft = match.group(1).strip() not in EMPTY_PROMPTS
        lines[prompt] = "[input_prompt]"
        i = prompt + 1
        while i < len(lines) and not FOOTER.match(lines[i].strip()):
            draft = draft or bool(lines[i].strip())
            lines[i] = "[draft_suppressed]" if lines[i].strip() else ""
            i += 1
    # Restrict warning recognition to the current bottom chrome after completion
    # and the previous submitted prompt; quoted/code/history lines never match.
    current_start = max(completion + 1, prompts[-2] + 1 if len(prompts) > 1 else 0)
    unquoted = []
    active = False
    for i, line in enumerate(lines):
        if visible[i]:
            active = active or (i > completion and bool(ACTIVE.fullmatch(line)))
            if i >= max(current_start, len(lines) - 12):
                unquoted.append(line)
    banners = sorted({kind for kind, pattern in BANNERS
                      if any(pattern.fullmatch(line.strip()) for line in unquoted)})
    if active:
        terminal = "busy"
    elif banners:
        terminal = "awaiting_input" if "approval" in banners else "ambiguous"
    elif prompt is not None and 0 <= completion < prompt:
        terminal = "turn_finished"
    elif prompt is not None:
        terminal = "awaiting_input"
    else:
        terminal = "ambiguous"
    context = re.findall(
        r"(?:\bcontext\s+(\d{1,3})%\s*(?:left|remaining)\b|"
        r"\b(\d{1,3})%\s*context\s*(?:left|remaining)\b)",
        "\n".join(unquoted), re.IGNORECASE,
    )
    low_context = bool(context and int(context[-1][0] or context[-1][1]) <= 10)
    markers = []
    if terminal == "ambiguous":
        # Future typed evaluation seam: structural markers only, never excerpts
        # of potentially private work, target content, prompts, or credentials.
        markers = ["visible_screen", *(["worked_marker"] if worked else []),
                   *(["input_prompt"] if prompts else []),
                   *[f"current_{kind}_banner" for kind in banners]]
    return {"terminal": terminal, "draft_present": draft, "low_context": low_context,
            "banners": banners, "markers": markers}, SECRET.sub("[redacted]", "\n".join(lines))


class Collector:
    def __init__(self, root_socket: str, owner_socket: str, tmux_socket: str,
                 deadline: float, cancel: threading.Event, tmux: str = "tmux",
                 discovered: bool = False, profile: str = "codex"):
        self.root_socket = root_socket
        self.owner_socket = owner_socket
        self.tmux_socket = tmux_socket
        self.deadline = deadline
        self.cancel = cancel
        self.tmux = tmux
        self.discovered = discovered
        self.profile = profile

    def remaining(self) -> float:
        remaining = self.deadline - time.monotonic()
        if self.cancel.is_set() or remaining <= 0:
            raise Stopped()
        return remaining

    def receipt(self, path: str, route: str, payload: dict | None = None,
                *, timeout: float = .25) -> tuple[int, dict]:
        limit = CATALOG_LIMIT if route.split("?")[0] in ("/v1/roots", "/v1/sessions", "/v1/gui/layout") else RECEIPT_LIMIT
        client = None
        if path.startswith("http:"):
            parsed = urlsplit(local_root_url(path))
            assert parsed.hostname is not None
            connection = http.client.HTTPConnection(parsed.hostname, parsed.port,
                                                    timeout=min(timeout, self.remaining()))
            route = parsed.path.rstrip("/") + route
        else:
            connection = http.client.HTTPConnection("localhost", timeout=min(timeout, self.remaining()))
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            connection.sock = client
        try:
            if client is not None:
                client.settimeout(min(timeout, self.remaining()))
                client.connect(path)
            connection.request("GET" if payload is None else "POST", route,
                               body=None if payload is None else json.dumps(
                                   payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
                               headers={"Connection": "close", "Content-Type": "application/json"})
            response = connection.getresponse()
            parts = bytearray()
            while True:
                remaining = self.remaining()
                if connection.sock is not None:
                    connection.sock.settimeout(min(timeout, remaining))
                part = response.read1(min(4096, limit + 1 - len(parts)))
                parts.extend(part)
                if len(parts) > limit:
                    raise Unavailable("receipt_limit")
                if not part or response.isclosed():
                    break
            data = json.loads(parts)
            if not isinstance(data, dict):
                raise Unavailable("receipt_invalid")
            return response.status, data
        except (OSError, ValueError, http.client.HTTPException):
            raise Unavailable("owner_unavailable") from None
        finally:
            connection.close()
            if client is not None:
                client.close()

    def owners(self, pin: Pin) -> None:
        status, root = self.receipt(self.root_socket, f"/v1/roots/{quote(pin.requestId)}")
        if status != 200:
            raise Unavailable("root_unavailable")
        expected = {"owner": "aico", "requestId": pin.requestId,
                    "hostIdentity": pin.widgetId, "logicalSessionId": pin.logicalSessionId,
                    "surfaceLocator": f"aico://widget/{pin.widgetId}"}
        if any(root.get(k) != v for k, v in expected.items()):
            raise IdentityChanged()
        if root.get("status") == "ended" and root.get("generation") is None:
            raise Ended()
        if root.get("generation") != pin.generation:
            raise IdentityChanged()
        if root.get("status") != "running":
            raise Unavailable("root_not_running")
        if self.discovered and root.get("tool") != self.profile:
            raise IdentityChanged()
        status, owner = self.receipt(self.owner_socket, f"/v1/sessions/{pin.widgetId}")
        if status != 200:
            raise Unavailable("pane_unavailable")
        expected = {"owner": "aico", "widgetId": pin.widgetId, "generation": pin.generation,
                    "sessionId": pin.sessionId, "tmuxSessionId": pin.tmuxSessionId,
                    "paneId": pin.paneId}
        if self.discovered:
            expected.update(tmuxServerId=pin.tmuxServerId, tmuxSocket=self.tmux_socket,
                            tool=self.profile)
        if any(owner.get(k) != v for k, v in expected.items()):
            raise IdentityChanged()

    def discover(self, request_id: str | None) -> tuple[list[tuple[Pin, Collector]], list[dict]]:
        if request_id:
            # Exact selection reads one root, so a retained tombstone still
            # reports its ended identity without listing every tombstone.
            status, root = self.receipt(self.root_socket, f"/v1/roots/{quote(request_id)}")
            if status == 404:
                roots: object = []
            elif status == 200 and root.get("owner") == "aico":
                roots = [root]
            else:
                raise Unavailable("catalog_unavailable")
        else:
            # Tombstones are kept forever; general discovery only wants live roots.
            status, catalog = self.receipt(self.root_socket, "/v1/roots?ended=0")
            roots = catalog.get("roots")
            if status != 200 or catalog.get("owner") != "aico":
                raise Unavailable("catalog_unavailable")
        if not isinstance(roots, list):
            raise Unavailable("catalog_unavailable")
        if len(roots) > ROOT_LIMIT:
            raise Unavailable("root_limit")
        resolved = []
        unavailable = []
        seen = set()
        for root in roots:
            if not isinstance(root, dict):
                raise Unavailable("catalog_invalid")
            key = root.get("requestId")
            if not isinstance(key, str) or not re.fullmatch(KEY, key):
                raise Unavailable("catalog_invalid")
            if key in seen:
                raise Unavailable("catalog_invalid")
            seen.add(key)
            if request_id and key != request_id:
                continue
            # General discovery selects running roots only; exact selection can
            # report the retained ended/pending identity without capturing it.
            if not request_id and root.get("status") != "running":
                continue
            record = {"requestId": key, "observation": "unavailable", "identity": "unresolved"}
            if root.get("status") != "running":
                unavailable.append({**record, "reason": "root_not_running"})
                continue
            # Observation is per status profile (classify), unlike create, which
            # sends any tool and lets Tether refuse it.
            if root.get("tool") not in ("codex", "claude-code"):
                unavailable.append({**record, "terminal": "ambiguous", "reason": "unsupported_profile"})
                continue
            try:
                widget = root.get("hostIdentity")
                if not isinstance(widget, str) or not re.fullmatch(WIDGET, widget):
                    raise Unavailable("receipt_invalid")
                status, owner = self.receipt(self.owner_socket, f"/v1/sessions/{widget}")
                if status != 200:
                    raise Unavailable("pane_unavailable")
                pin = Pin.parse(json.dumps({
                    "requestId": key, "widgetId": root.get("hostIdentity"),
                    "logicalSessionId": root.get("logicalSessionId"),
                    "generation": root.get("generation"),
                    **{k: owner.get(k) for k in ("sessionId", "tmuxSessionId", "paneId", "tmuxServerId")},
                }))
                child = Collector(self.root_socket, self.owner_socket,
                                  socket_path(owner.get("tmuxSocket", "")),
                                  self.deadline, self.cancel, self.tmux, discovered=True,
                                  profile=root["tool"])
                child.owners(pin)
                child.pane(pin)
                resolved.append((pin, child))
            except IdentityChanged:
                unavailable.append({**record, "identity": "changed"})
            except Ended:
                unavailable.append({**record, "identity": "ended"})
            except (ValueError, TypeError, argparse.ArgumentTypeError):
                unavailable.append({**record, "reason": "receipt_invalid"})
            except Unavailable as error:
                unavailable.append({**record, "reason": str(error)})
        if request_id and request_id not in seen:
            unavailable.append({"requestId": request_id, "observation": "unavailable",
                                "identity": "unresolved", "reason": "root_not_found"})
        return resolved, unavailable

    def command(self, args: list[str], limit: int) -> bytes:
        self.remaining()
        try:
            process = subprocess.Popen([self.tmux, "-S", self.tmux_socket, *args],
                                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL, start_new_session=True)
        except OSError:
            raise Unavailable("tmux_unavailable") from None
        selector = selectors.DefaultSelector()
        output = bytearray()
        assert process.stdout is not None
        try:
            selector.register(process.stdout, selectors.EVENT_READ)
            operation_end = min(self.deadline, time.monotonic() + 1)
            while selector.get_map():
                remaining = self.remaining()
                if time.monotonic() >= operation_end:
                    raise Unavailable("capture_timeout")
                for key, _ in selector.select(min(.05, remaining)):
                    chunk = os.read(key.fd, min(4096, limit + 1 - len(output)))
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    output.extend(chunk)
                    if len(output) > limit:
                        raise Unavailable("capture_limit")
            while process.poll() is None:
                self.remaining()
                if time.monotonic() >= operation_end:
                    raise Unavailable("capture_timeout")
                self.cancel.wait(.01)
            if process.returncode:
                raise Unavailable("tmux_unavailable")
            return bytes(output)
        finally:
            selector.close()
            # Kill only this read-only client's process group, never the server,
            # and only while the leader is unreaped: once poll()/wait() has
            # reaped it, its pid (and so the pgid) may already be recycled.
            if process.returncode is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
            process.stdout.close()

    def pane(self, pin: Pin) -> None:
        args = []
        for key in ("AICO_OWNER", "AICO_WORKLOAD_CLASS", "AICO_TMUX_SERVER_ID"):
            if args:
                args.append(";")
            args += ["show-environment", "-g", key]
        markers = self.command(args, 1024).decode(errors="replace").strip()
        if markers != ("AICO_OWNER=aico\nAICO_WORKLOAD_CLASS=durable-tmux-server\n"
                       f"AICO_TMUX_SERVER_ID={pin.tmuxServerId}"):
            raise IdentityChanged()
        row = self.command(["display-message", "-p", "-t", pin.paneId,
                            "#{session_id}\t#{pane_id}\t#{session_name}\t#{pane_dead}"], 1024)
        if row.decode(errors="replace").strip() != (
                f"{pin.tmuxSessionId}\t{pin.paneId}\taico-{pin.widgetId}\t0"):
            raise IdentityChanged()

    def sample(self, pin: Pin) -> dict:
        try:
            self.owners(pin)
            self.pane(pin)
            # No -S - / -E -: tmux's default range is the visible screen only.
            raw = self.command(["capture-pane", "-p", "-t", pin.paneId], CAPTURE_LIMIT)
            self.owners(pin)
            self.pane(pin)
            self.remaining()
            state, _ = classify(raw, self.profile)
            return {"observation": "available", "identity": "pinned", **state}
        except IdentityChanged:
            return {"observation": "unavailable", "identity": "changed"}
        except Ended:
            return {"observation": "unavailable", "identity": "ended"}
        except Unavailable as error:
            return {"observation": "unavailable", "identity": "pinned", "reason": str(error)}


def watch(collector: Collector, pins: list[Pin], interval: float, failures: int,
          emit: Callable[[dict], None]) -> str:
    previous: dict[Pin, dict] = {}
    pending: dict[Pin, tuple[dict, int]] = {}
    failed = {pin: 0 for pin in pins}
    identities = {pin: dataclasses.asdict(pin) if collector.discovered else {
        "requestId": pin.requestId, "widgetId": pin.widgetId, "generation": pin.generation,
    } for pin in pins}
    try:
        while True:
            for pin in pins:
                collector.remaining()
                state = collector.sample(pin)
                if pin not in previous:
                    emit({**identities[pin], "event": "baseline", **state})
                    previous[pin] = state
                elif previous[pin] == state:
                    pending.pop(pin, None)
                else:
                    immediate = (
                        state["observation"] == "unavailable"
                        or state.get("terminal") in ("busy", "turn_finished")
                        or state.get("draft_present") is True
                        or bool(state.get("banners"))
                    )
                    candidate, count = pending.get(pin, ({}, 0))
                    count = count + 1 if candidate == state else 1
                    if immediate or count >= 2:
                        emit({**identities[pin], "event": "transition", **state})
                        previous[pin] = state
                        pending.pop(pin, None)
                    else:
                        pending[pin] = (state, count)
                if state["identity"] in ("changed", "ended"):
                    return "identity_" + state["identity"]
                failed[pin] = failed[pin] + 1 if state["observation"] == "unavailable" else 0
                if failed[pin] >= failures:
                    return "observation_failures"
            collector.cancel.wait(min(interval, collector.remaining()))
    except Stopped:
        return "cancelled" if collector.cancel.is_set() else "deadline"


# Once part of a line is on the pipe, allow this long past cancellation or the
# deadline to finish it, so consumers do not receive a torn JSON record.
EMIT_LINE_GRACE = .25


def emit_json(collector: Collector, record: dict, fd: int = 1) -> None:
    """Write one JSON line; a stalled output pipe must not outlive cancellation or the deadline.

    Nothing is written once the collector is stopped. A line that has started is
    finished within EMIT_LINE_GRACE; if the pipe is still stalled after that, the
    unterminated fragment (never newline-terminated) is the only residue.
    """
    output = memoryview((json.dumps(record, separators=(",", ":")) + "\n").encode())
    collector.remaining()
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    try:
        if not flags & os.O_NONBLOCK:
            fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        started = False
        grace_end: float | None = None
        while output:
            try:
                remaining = collector.remaining()
            except Stopped:
                if not started:
                    raise
                if grace_end is None:
                    grace_end = time.monotonic() + EMIT_LINE_GRACE
                remaining = grace_end - time.monotonic()
                if remaining <= 0:
                    raise
            if not select.select([], [fd], [], min(.05, remaining))[1]:
                continue
            try:
                written = os.write(fd, output)
            except BlockingIOError:
                continue
            started = started or written > 0
            output = output[written:]
    finally:
        if fcntl.fcntl(fd, fcntl.F_GETFL) != flags:
            fcntl.fcntl(fd, fcntl.F_SETFL, flags)


def emit_unless_stopped(collector: Collector, record: dict) -> None:
    """Emit a final failure record; nothing is written once the collector is stopped."""
    try:
        emit_json(collector, record)
    except Stopped:
        pass


class ResolvedCollector(Collector):
    """Dispatch only to immutable, already verified per-root server locators."""

    def __init__(self, discovery: Collector, resolved: list[tuple[Pin, Collector]]):
        super().__init__(discovery.root_socket, discovery.owner_socket, "",
                         discovery.deadline, discovery.cancel, discovered=True)
        self.resolved = dict(resolved)

    def sample(self, pin: Pin) -> dict:
        return self.resolved[pin].sample(pin)


TERMINAL_ADMIN = {
    "available": False, "reason": "native_tui_atomic_compare_and_apply_unavailable",
    "operations": ["clear", "submit"], "framing": "bracketed_paste",
    "missing": ["current_thread_fence", "idle_empty_draft_input_fence", "idempotent_native_receipt"],
}


def admin_stdin(collector: Collector) -> str:
    import sys

    parts = bytearray()
    while True:
        if not select.select([sys.stdin.fileno()], [], [], min(.05, collector.remaining()))[0]:
            continue
        part = os.read(sys.stdin.fileno(), min(4096, 2001 - len(parts)))
        parts.extend(part)
        if len(parts) > 2000:
            raise ValueError("text_limit")
        if not part:
            break
    text = parts.decode("utf-8")
    if not text.strip() or re.search(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]", text):
        raise ValueError("invalid_text")
    return text


def admin_main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="st aico admin", description=(
        "Inspect native admin availability, or request a pinned clear/submit. "
        "Currently fails closed: the native atomic thread/idle/draft operation is unavailable. "
        "No terminal input, capture, or retry. Text is read only from bounded UTF-8 stdin."))
    parser.add_argument("request_id", help="retained Aico root request ID")
    parser.add_argument("operation", nargs="?", choices=("clear", "submit"), help="omit to inspect capability")
    parser.add_argument("--generation", help="exact Aico SHA-256 generation")
    parser.add_argument("--thread", help="expected current native thread UUID")
    parser.add_argument("--request-key", help="stable operation identity; reuse after uncertain response")
    parser.add_argument("--stdin", action="store_true", help="required for submit; <=2000 UTF-8 bytes, no framing controls")
    parser.add_argument("--root-socket", type=socket_path, default=default_gui_socket())
    args = parser.parse_args(argv)
    if not re.fullmatch(KEY, args.request_id):
        parser.error("invalid root request ID")
    if args.operation:
        if (not args.generation or not re.fullmatch(GENERATION, args.generation)
                or not args.thread or not re.fullmatch(THREAD, args.thread)
                or not args.request_key or not re.fullmatch(KEY, args.request_key)
                or args.stdin != (args.operation == "submit")):
            parser.error("operation requires generation, thread, request-key, and stdin only for submit")
    elif args.generation or args.thread or args.request_key or args.stdin:
        parser.error("pins and stdin require an operation")
    collector = Collector(args.root_socket, "", "", time.monotonic() + 10, threading.Event())
    output = {"owner": "aico", "requestId": args.request_id}
    payload = None
    if args.operation:
        payload = {"kind": args.operation, "requestKey": args.request_key,
                   "generation": args.generation, "expectedThreadId": args.thread}
        output.update(payload)
    sent = False
    try:
        if args.operation == "submit":
            assert payload is not None
            try:
                payload["text"] = admin_stdin(collector)
            except ValueError:
                parser.error("invalid submission text; expected <=2000 UTF-8 bytes without framing controls")
        sent = payload is not None
        status, data = collector.receipt(args.root_socket, f"/v1/roots/{args.request_id}/admin", payload)
        if args.operation:
            assert payload is not None
            denied = {"native_tui_atomic_admin_unavailable": 503, "invalid_body": 400,
                      "stale_generation": 409, "ended": 410, "not_found": 404,
                      "gui_unavailable": 503, "unsupported_tool": 422}
            pins = ("kind", "requestKey", "generation", "expectedThreadId")
            native = data.get("error") == "native_tui_atomic_admin_unavailable"
            if (not isinstance(data.get("error"), str) or denied.get(data["error"]) != status
                    or data.get("applied", None if native else False) is not False
                    or any(data.get(key) != payload[key] for key in pins)):
                raise Unavailable("admin_receipt_unqualified")
            output.update(applied=False, reason=data["error"])
            if data.get("terminalAdmin") == TERMINAL_ADMIN:
                output["terminalAdmin"] = TERMINAL_ADMIN
        else:
            generation = data.get("generation")
            if (status != 200 or data.get("owner") != "aico" or data.get("requestId") != args.request_id
                    or data.get("terminalAdmin") != TERMINAL_ADMIN
                    or generation is not None and not re.fullmatch(GENERATION, str(generation))):
                raise Unavailable("admin_capability_unavailable")
            output.update(generation=generation, currentThreadId=None, terminalAdmin=TERMINAL_ADMIN)
        emit_json(collector, output)
        return int(bool(args.operation))
    except (Unavailable, Stopped) as error:
        output.update(applied=None if sent else False,
                      reason=str(error) if isinstance(error, Unavailable) else "deadline")
        emit_unless_stopped(collector, output)
        return 1
    except BrokenPipeError:
        return 0


def tool_slug(value: str) -> str:
    """An agent tool slug as Tether's registry spells it; Tether decides support."""
    if not re.fullmatch(TOOL_SLUG, value):
        raise argparse.ArgumentTypeError("expected an agent tool slug such as claude-code")
    return value


def create_main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="st aico create", description=(
        "Create one exact owner root; native resume uses an adapter-validated session ID in a new root. "
        "Reuse the same request ID and complete body on retry. No prompt is retained."))
    parser.add_argument("request_id")
    parser.add_argument("prompt", nargs="?", help="short sanitized initial/recovery prompt (<=2000 UTF-8 bytes)")
    parser.add_argument("--stdin", action="store_true", help="read prompt from bounded stdin instead")
    parser.add_argument("--project", required=True)
    parser.add_argument("--project-root", required=True)
    # No default: the caller picks the agent on purpose. No local list either:
    # Tether decides which tools can start a root (`rootCapable` in /v1/tools)
    # and its refusal names them.
    parser.add_argument("--tool", type=tool_slug, required=True, help=(
        "required. Agent tool slug: claude-code, codex or pi."))
    parser.add_argument("--surface", choices=("aico", "a-term"), default="aico")
    parser.add_argument("--role", default="portfolio-root", help="opaque orchestration metadata")
    parser.add_argument("--work-role",
                        help="required for a new root: coordinator, implementation, research, review, recon, hunting, operations or other; fixed including resume")
    parser.add_argument("--work-role-name", help="optional display name (1-128 characters)")
    parser.add_argument("--lead-root")
    parser.add_argument("--facet")
    parser.add_argument("--resume-session", help="exact native session ID; owner adapter validates format/support, never a picker")
    parser.add_argument("--model", help="per-launch model; Pi requires provider/model, passed as separate native provider/model flags")
    parser.add_argument("--reasoning-effort", choices=("none", "off", "minimal", "low", "medium", "high", "xhigh", "max"))
    parser.add_argument("--daybreak", choices=("on", "off"), help="Daybreak for this launch; Pi supports openai/gpt-6-sol; leaves shared defaults alone")
    parser.add_argument("--agent-hub-context", choices=("on", "off"), help="Pi optional Agent Hub context; off retains required policy, native/project instructions and ingestion")
    parser.add_argument("--root-socket", type=socket_path)
    parser.add_argument("--root-url", type=local_root_url)
    args = parser.parse_args(argv)
    if args.work_role is not None and (not re.fullmatch(KEY, args.work_role) or args.work_role == "unknown"):
        parser.error("expected a declared work role ID; unknown is reserved for legacy sessions")
    if args.work_role_name is not None and (not args.work_role or not args.work_role_name.strip()
            or len(args.work_role_name) > 128 or re.search(r"[\x00-\x1f\x7f]", args.work_role_name)):
        parser.error("work role name must be 1-128 characters of single-line text")
    if any(not re.fullmatch(KEY, value) for value in
           (args.request_id, args.project, args.role, *(v for v in (args.lead_root, args.facet) if v is not None))):
        parser.error("invalid root metadata")
    if (not os.path.isabs(args.project_root) or os.path.normpath(args.project_root) != args.project_root
            or "\0" in args.project_root):
        parser.error("project root must be an exact normalized absolute path")
    if args.resume_session is not None and not re.fullmatch(KEY, args.resume_session):
        parser.error("resume requires a bounded exact native session ID")
    if args.model is not None and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}", args.model):
        parser.error("invalid model identifier")
    if (args.stdin and args.prompt is not None or args.surface == "aico" and args.root_url
            or args.surface == "a-term" and args.root_socket):
        parser.error("conflicting prompt or owner transport options")
    try:
        endpoint = owner_endpoint(args.surface, args.root_socket, args.root_url)
    except argparse.ArgumentTypeError as error:
        parser.error(f"invalid owner transport configuration: {error}")
    collector = Collector(endpoint, "", "", time.monotonic() + 10, threading.Event())
    output = {"owner": args.surface, "requestId": args.request_id}
    try:
        prompt = admin_stdin(collector) if args.stdin else args.prompt
        if prompt is None and args.resume_session:
            prompt = "Resume this exact saved session. Reconcile current state after the crash before continuing."
        if (not isinstance(prompt, str) or not prompt.strip() or len(prompt.encode("utf-8")) > 2000
                or re.search(r"[\x00-\x08\x0b-\x1f\x7f-\x9f\ud800-\udfff]", prompt) or SECRET.search(prompt)):
            parser.error("expected a short sanitized prompt or --stdin; no secrets or framing controls")
        payload = {"requestId": args.request_id, "tool": args.tool, "projectId": args.project,
                   "projectRoot": args.project_root, "initialPrompt": prompt, "role": args.role,
                   "leadRootReference": args.lead_root, "facetCapsuleRef": args.facet}
        # Run from a Tether session (Aico or A-Term): Tether records it as the
        # launcher, so the root joins its coordinator (or makes it one).
        creator = os.environ.get("AICO_WIDGET_ID")
        if isinstance(creator, str) and re.fullmatch(WIDGET, creator):
            payload["launchedBy"] = creator
        fields = [args.tool, args.project, args.project_root, prompt, args.role, args.lead_root, args.facet]
        if args.resume_session:
            payload["resumeSessionId"] = args.resume_session
            fields.append(args.resume_session)
        if args.model or args.reasoning_effort or args.daybreak is not None or args.agent_hub_context is not None:
            selection = {"model": args.model, "reasoningEffort": args.reasoning_effort}
            if args.daybreak is not None:
                selection["daybreak"] = args.daybreak == "on"
            if args.agent_hub_context is not None:
                selection["agentHubContext"] = args.agent_hub_context == "on"
            payload.update(selection)
            fields.append(selection)
        if args.work_role:
            payload.update(workRole=args.work_role, workRoleDisplayName=args.work_role_name)
            fields.append({"workRole": args.work_role, "workRoleDisplayName": args.work_role_name})
        digest = hashlib.sha256(json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
        status, data = collector.receipt(endpoint, "/v1/roots", payload, timeout=10)
        errors = {400: ("invalid_body", "unsupported_tool", "work_role_required"), 409: ("request_conflict", "recovery_pending"),
                  422: ("launch_unavailable",), 503: ("gui_unavailable",)}
        if status not in (200, 202):
            reason = data.get("error")
            if reason not in errors.get(status, ()):
                raise Unavailable("create_receipt_unqualified")
            supported = data.get("supported")
            if (reason == "unsupported_tool" and isinstance(supported, list) and 0 < len(supported) <= 50
                    and all(isinstance(slug, str) and re.fullmatch(TOOL_SLUG, slug) for slug in supported)):
                output["supportedTools"] = supported
            # Tether is resuming this conversation in its own session after a crash.
            if reason == "recovery_pending" and isinstance(data.get("widgetId"), str) \
                    and re.fullmatch(WIDGET, data["widgetId"]):
                output["recoveringWidget"] = data["widgetId"]
            raise Unavailable(reason)
        host = data.get("hostIdentity")
        generation = data.get("generation")
        state = data.get("status")
        if (data.get("owner") != args.surface or data.get("requestId") != args.request_id
                or data.get("digest") != digest or data.get("role") != args.role
                or data.get("workRole") != args.work_role or data.get("workRoleDisplayName") != args.work_role_name
                or data.get("leadRootReference") != args.lead_root or data.get("facetCapsuleRef") != args.facet
                or not surface_identity(args.surface, host, data.get("surfaceLocator"))
                or not isinstance(data.get("logicalSessionId"), str)
                or not re.fullmatch(KEY, data["logicalSessionId"])
                or state not in ("running", "pending", "uncertain", "ended")
                or status != (202 if state in ("pending", "uncertain") else 200)
                or state == "running" and generation is None
                or generation is not None and (not isinstance(generation, str) or not re.fullmatch(GENERATION, generation))
                or state == "ended" and generation is not None):
            raise Unavailable("create_receipt_unqualified")
        output.update({key: data[key] for key in ("digest", "hostIdentity", "logicalSessionId", "generation", "surfaceLocator", "status")})
        output.update(workRole=args.work_role, workRoleDisplayName=args.work_role_name)
        if "launchedBy" in payload:
            output["launchedBy"] = payload["launchedBy"]
        emit_json(collector, output)
        return 0
    except (ValueError, UnicodeError):
        parser.error("invalid prompt or UTF-8 input")
    except (Unavailable, Stopped) as error:
        output.update(status="uncertain", reason=str(error) if isinstance(error, Unavailable) else "deadline")
        emit_unless_stopped(collector, output)
        return 1
    except BrokenPipeError:
        return 0
    return 1


def widget_descriptor(data: dict, widget_id: str) -> dict:
    """Project only a qualified exact widget identity and workload availability."""
    session = data.get("sessionId")
    generation = data.get("generation")
    state = data.get("status")
    if (data.get("owner") != "aico" or data.get("widgetId") != widget_id
            or not isinstance(session, str)
            or not re.fullmatch(KEY, session)
            or not isinstance(generation, str) or not re.fullmatch(GENERATION, generation)
            or state not in ("running", "pending", "uncertain")
            or type(data.get("available")) is not bool
            or data["available"] != (state == "running")):
        raise Unavailable("widget_receipt_unqualified")
    return {key: data[key] for key in ("owner", "widgetId", "sessionId", "generation", "status", "available")}


def widget_main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="st aico widget", description=(
        "Inspect or change one exact Aico widget. Defaults to AICO_WIDGET_ID; "
        "title, position and coordinator pin its owner generation before one mutation."))
    commands = parser.add_subparsers(dest="operation", required=True)
    for operation in ("status", "title", "position", "coordinator"):
        command = commands.add_parser(operation)
        command.add_argument("--widget-id", default=os.environ.get("AICO_WIDGET_ID"))
        command.add_argument("--root-socket", type=socket_path)
        if operation == "title":
            command.add_argument("label")
        elif operation == "position":
            for dimension in ("x", "y", "width", "height"):
                command.add_argument(dimension, type=int)
        elif operation == "coordinator":
            command.add_argument("state", choices=("on", "off", "join"),
                                 help="on: mark a coordinator; off: an ordinary window; join COORDINATOR_ID: make this "
                                      "window a lane of that coordinator (its root), moving its own lanes too")
            command.add_argument("coordinator_id", nargs="?")
    args = parser.parse_args(argv)
    if not isinstance(args.widget_id, str) or not re.fullmatch(WIDGET, args.widget_id):
        parser.error("expected --widget-id or AICO_WIDGET_ID with exactly eight lowercase hex characters")
    payload = view_payload(parser, args)
    try:
        endpoint = owner_endpoint("aico", args.root_socket, None)
    except argparse.ArgumentTypeError as error:
        parser.error(f"invalid owner transport configuration: {error}")
    collector = Collector(endpoint, "", "", time.monotonic() + 10, threading.Event())
    output: dict = {"owner": "aico", "widgetId": args.widget_id}
    mutation_sent = False

    def qualify(status: int, data: dict) -> dict:
        owner_reply(status, data, "widget_receipt_unqualified")
        return widget_descriptor(data, args.widget_id)

    try:
        route = f"/v1/widgets/{args.widget_id}"
        status, data = collector.receipt(endpoint, route)
        descriptor = qualify(status, data)
        output.update(descriptor)
        if args.operation != "status":
            if not descriptor["available"]:
                raise Unavailable("workload_unavailable")
            payload["generation"] = descriptor["generation"]
            mutation_sent = True
            # Verified owner writes include tmux checks; allow them to finish.
            status, data = collector.receipt(endpoint, f"{route}/{args.operation}", payload, timeout=5)
            changed = qualify(status, data)
            if any(changed[key] != descriptor[key] for key in ("widgetId", "sessionId", "generation")):
                raise Unavailable("widget_receipt_unqualified")
            output.update(changed, operation=args.operation, applied=True)
        emit_json(collector, output)
        return 0
    except (Unavailable, Stopped) as error:
        output.update(status="uncertain", available=False,
                      reason=str(error) if isinstance(error, Unavailable) else "deadline")
        if args.operation != "status":
            output.update(operation=args.operation, applied=applied(mutation_sent, error))
        emit_unless_stopped(collector, output)
        return 1
    except BrokenPipeError:
        return 0


def surface_identity(surface: str, host: object, locator: object) -> bool:
    """Exact host/locator pairing for a root surface.

    Aico roots are 8-hex widget ids at ``aico://widget/<id>``. A-Term roots are
    accepted in both shapes: the pre-Tether pane UUID at ``a-term://pane/<uuid>``
    and, since A-Term's /v1/roots proxies Tether, a Tether session id at
    ``aico://widget/<id>`` (owner/origin stays ``a-term``)."""
    if not isinstance(host, str) or not isinstance(locator, str):
        return False
    tether = bool(re.fullmatch(WIDGET, host)) and locator == f"aico://widget/{host}"
    if surface == "aico":
        return tether
    legacy = bool(re.fullmatch(THREAD, host)) and bool(re.fullmatch("a-term://pane/" + THREAD, locator))
    return tether or legacy


ROOT_IDENTITY = ("owner", "requestId", "hostIdentity", "logicalSessionId", "surfaceLocator")


def applied(sent: bool, error: Exception) -> bool | None:
    """False unless a mutation was sent; then only a qualified refusal is False."""
    return None if sent and not isinstance(error, Refused) else False


def view_payload(parser: argparse.ArgumentParser, args: argparse.Namespace) -> dict:
    """Validate title/position input before any owner contact; never echo a label."""
    if args.operation == "title":
        label = view_label(args.label)
        if label is None:
            parser.error("expected a nonempty title of at most 160 UTF-8 bytes without controls")
        return {"label": label}
    if args.operation == "position":
        bounds = view_bounds({key: getattr(args, key) for key in BOUNDS})
        if bounds is None:
            parser.error("expected integer bounds within 100000; minimum size is 360 by 240")
        return {"bounds": bounds}
    if args.operation == "coordinator":
        if args.state == "join":
            if not isinstance(args.coordinator_id, str) or not re.fullmatch(WIDGET, args.coordinator_id):
                parser.error("join expects the coordinator's eight-character widget ID")
            return {"coordinator": args.coordinator_id}
        if args.coordinator_id is not None:
            parser.error("a coordinator ID goes only with join")
        return {"coordinator": args.state == "on"}
    return {}


def root_descriptor(data: dict, surface: str, request_id: str) -> dict:
    """Project only a qualified exact retained-root identity and status."""
    host = data.get("hostIdentity")
    locator = data.get("surfaceLocator")
    generation = data.get("generation")
    state = data.get("status")
    if (data.get("owner") != surface or data.get("requestId") != request_id
            or not surface_identity(surface, host, locator)
            or not isinstance(data.get("logicalSessionId"), str)
            or not re.fullmatch(KEY, data["logicalSessionId"])
            or state not in ("running", "pending", "uncertain", "ended")
            or generation is not None and (not isinstance(generation, str)
                                           or not re.fullmatch(GENERATION, generation))
            or state == "running" and generation is None
            or state == "ended" and generation is not None):
        raise Unavailable("root_receipt_unqualified")
    return {key: data[key] for key in (*ROOT_IDENTITY, "generation", "status")}


def root_main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="st aico root", description=(
        "Inspect or control one exact retained owner root by request ID. Mutations pin its "
        "current generation, send one request and qualify the receipt. No retry or owner startup."))
    commands = parser.add_subparsers(dest="operation", required=True)
    for operation in ("status", "show", "title", "position", "end"):
        command = commands.add_parser(operation)
        command.add_argument("request_id")
        if operation == "title":
            command.add_argument("label")
        elif operation == "position":
            for dimension in BOUNDS:
                command.add_argument(dimension, type=int)
        command.add_argument("--surface", choices=("aico", "a-term"), default="aico")
        command.add_argument("--root-socket", type=socket_path)
        command.add_argument("--root-url", type=local_root_url)
        if operation == "end":
            command.add_argument("--owner-socket", type=socket_path)
    args = parser.parse_args(argv)
    if not re.fullmatch(KEY, args.request_id):
        parser.error("invalid root request ID")
    aico = args.surface == "aico"
    if (aico and args.root_url or not aico and (args.root_socket or getattr(args, "owner_socket", None))):
        parser.error("conflicting owner transport options")
    if not aico and args.operation == "position":
        parser.error("A-Term root positioning is unavailable")
    payload = view_payload(parser, args)
    try:
        endpoint = owner_endpoint(args.surface, args.root_socket, args.root_url)
        control = (getattr(args, "owner_socket", None) or socket_path(default_owner_socket())
                   if aico else endpoint)
    except argparse.ArgumentTypeError as error:
        parser.error(f"invalid owner transport configuration: {error}")
    collector = Collector(endpoint, control, "", time.monotonic() + 10, threading.Event())
    output: dict = {"owner": args.surface, "requestId": args.request_id}
    route = f"/v1/roots/{args.request_id}"
    sent = False
    try:
        status, data = collector.receipt(endpoint, route)
        owner_reply(status, data, "root_receipt_unqualified")
        pinned = root_descriptor(data, args.surface, args.request_id)
        output.update(pinned)
        if args.operation == "status":
            emit_json(collector, output)
            return 0
        output["operation"] = args.operation
        if args.operation == "end" and pinned["status"] == "ended":
            # An exact tombstone is the idempotent end receipt; nothing is sent.
            output["applied"] = False
            emit_json(collector, output)
            return 0
        if (args.operation != "end" and pinned["status"] != "running") or pinned["generation"] is None:
            raise Refused("workload_unavailable")
        payload["generation"] = pinned["generation"]
        sent = True
        if args.operation == "end" and aico:
            # Exact containment retirement remains the headless owner's contract.
            status, data = collector.receipt(control, f"/v1/sessions/{pinned['hostIdentity']}/end", payload,
                                             timeout=10)
            owner_reply(status, data, "end_receipt_unqualified")
            if data != {"status": "ended"}:
                raise Unavailable("end_receipt_unqualified")
            output.update(status="ended", generation=None)
        else:
            status, data = collector.receipt(endpoint, f"{route}/{args.operation}", payload,
                                             timeout=10 if args.operation == "end" else 5)
            owner_reply(status, data, "root_receipt_unqualified")
            changed = root_descriptor(data, args.surface, args.request_id)
            expected = "ended" if args.operation == "end" else "running"
            if (changed["status"] != expected
                    or any(changed[key] != pinned[key] for key in ROOT_IDENTITY)
                    or args.operation != "end" and changed["generation"] != pinned["generation"]):
                raise Unavailable("root_receipt_unqualified")
            output.update(changed)
        output["applied"] = True
        emit_json(collector, output)
        return 0
    except (Unavailable, Stopped) as error:
        output.update(status="uncertain", reason=str(error) if isinstance(error, Unavailable) else "deadline")
        if args.operation != "status":
            output.update(operation=args.operation, applied=applied(sent, error))
        emit_unless_stopped(collector, output)
        return 1
    except BrokenPipeError:
        return 0


def roots_main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="st aico roots", description=__doc__)
    parser.add_argument("request_id", nargs="?", help="exact retained Aico catalog request ID")
    parser.add_argument("--watch", type=float, help="change-only JSONL seconds, >0 and <=3600")
    parser.add_argument("--interval", type=float, default=2, help="poll seconds, >=0.1")
    parser.add_argument("--root-socket", type=socket_path, default=default_gui_socket())
    parser.add_argument("--owner-socket", type=socket_path, default=default_owner_socket())
    args = parser.parse_args(argv)
    if args.request_id and not re.fullmatch(KEY, args.request_id):
        parser.error("invalid request ID")
    if (args.watch is not None and (not math.isfinite(args.watch) or not 0 < args.watch <= 3600)
            or not math.isfinite(args.interval) or args.interval < .1):
        parser.error("invalid watch or interval bound")
    cancel = threading.Event()
    handlers = {s: signal.signal(s, lambda *_: cancel.set()) for s in (signal.SIGINT, signal.SIGTERM)}
    discovery = Collector(args.root_socket, args.owner_socket, "",
                          time.monotonic() + (args.watch if args.watch is not None else 10), cancel)
    try:
        resolved, unavailable = discovery.discover(args.request_id)
        collector = ResolvedCollector(discovery, resolved)
        if args.watch is None:
            records = [{**dataclasses.asdict(pin), **collector.sample(pin)} for pin, _ in resolved]
            emit_json(collector, {"owner": "aico", "roots": records + unavailable})
            return int(any(row["observation"] == "unavailable" for row in records + unavailable))
        for record in unavailable:
            emit_json(collector, {"event": "baseline", **record})
        if not resolved or any(row["identity"] == "changed" for row in unavailable):
            return int(bool(unavailable))
        outcome = watch(collector, [pin for pin, _ in resolved], args.interval, 3,
                        lambda record: emit_json(collector, record))
        return int(bool(unavailable) or outcome in ("identity_changed", "observation_failures"))
    except Unavailable as error:
        emit_unless_stopped(discovery, {"owner": "aico", "observation": "unavailable", "reason": str(error)})
        return 1
    except Stopped:
        # No capture or partial identity is emitted when discovery hits its bound.
        return 0 if cancel.is_set() or args.watch is not None else 1
    except BrokenPipeError:
        cancel.set()
        return 0
    finally:
        for s, handler in handlers.items():
            signal.signal(s, handler)


def layout_writer(data: object) -> tuple[int, str | None] | None:
    """The Aico process a v1 layout.json names as its writer: its pid and its
    `/proc/<pid>/stat` start time (null when Aico couldn't read procfs). None
    when the file doesn't name one, so it can't be told from a crash leftover."""
    if not isinstance(data, dict):
        return None
    layout = typing.cast("dict[str, object]", data)
    if layout.get("v") != 1:
        return None
    pid, start = layout.get("pid"), layout.get("startTime")
    if type(pid) is not int or pid <= 0:
        return None
    if start is not None and not (isinstance(start, str) and start.isdigit()):
        return None
    return pid, start


def process_running(pid: int, start_time: str | None) -> bool:
    """True while `pid` is alive and, when a start time is given, is still the
    same process (a reused pid has another start time). Never an age check:
    an idle Aico leaves layout.json untouched for hours."""
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return False
    fields = stat[stat.rfind(")") + 1:].split()
    return start_time is None or (len(fields) > 19 and fields[19] == start_time)


def layout_main(argv: list[str]) -> int:
    """Print the running Aico GUI's window layout (displays, every window's
    bounds) so an agent can plan an arrangement, then move windows with
    `st aico widget position --widget-id ID X Y WIDTH HEIGHT`. A layout left
    by an Aico that is no longer running reports layout_stale. Reads the live GUI
    through Tether; AICO_LAYOUT_FILE selects an explicit offline/fixture file."""
    parser = argparse.ArgumentParser(prog="st aico layout", description=layout_main.__doc__)
    parser.parse_args(argv)
    override = os.environ.get("AICO_LAYOUT_FILE")
    try:
        if override is not None:
            path = Path(override)
            try:
                data = json.loads(path.read_text())
            except (OSError, ValueError):
                print(json.dumps({"owner": "aico", "observation": "unavailable",
                                  "reason": "layout_missing", "path": str(path)}))
                return 1
        else:
            collector = Collector("", "", "", time.monotonic() + 7, threading.Event())
            status, data = collector.receipt(tether_socket(), "/v1/gui/layout", timeout=6)
            if status != 200:
                reason = data.get("error")
                raise Unavailable(reason if reason in (
                    "gui_unavailable", "gui_timeout", "gui_failed", "invalid_body"
                ) else "layout_unavailable")
    except (Unavailable, Stopped) as error:
        print(json.dumps({"owner": "aico", "observation": "unavailable",
                          "reason": str(error) if isinstance(error, Unavailable) else "gui_timeout"}))
        return 1
    writer = layout_writer(data)
    if writer is None:
        print(json.dumps({"owner": "aico", "observation": "unavailable",
                          "reason": "layout_unqualified"}))
        return 1
    if not process_running(*writer):
        print(json.dumps({"owner": "aico", "observation": "unavailable",
                          "reason": "layout_stale"}))
        return 1
    print(json.dumps({"owner": "aico", **data}, indent=2))
    return 0


def session_inventory_item(item: object) -> dict:
    """Project catalog metadata only; never infer ownership from a root list."""
    if not isinstance(item, dict):
        raise Unavailable("sessions_receipt_unqualified")
    data = typing.cast(dict[str, object], item)
    checks = {"id": WIDGET, "ownershipId": KEY, "tool": TOOL_SLUG}
    optional = {"coordinatorId": WIDGET, "rootRequestId": KEY}
    if (any(not isinstance(value := data.get(key), str) or not re.fullmatch(pattern, value)
            for key, pattern in checks.items())
            or any((value := data.get(key)) is not None and (not isinstance(value, str)
                    or not re.fullmatch(pattern, value)) for key, pattern in optional.items())
            or (data.get("projectId") is not None and not isinstance(data.get("projectId"), str))
            or type(data.get("coordinator")) is not bool
            or data.get("status") not in ("running", "pending", "uncertain", "legacy")
            or data.get("state") not in ("working", "idle", "blocked", "unknown")
            or data.get("origin") not in ("aico", "a-term", "cli", "root")):
        raise Unavailable("sessions_receipt_unqualified")
    title = data.get("displayTitle", data.get("label"))
    if not isinstance(title, str):
        raise Unavailable("sessions_receipt_unqualified")
    project = data.get("projectId")
    return {"widgetId": data["id"], "ownershipId": data["ownershipId"],
            "coordinator": data["coordinator"], "coordinatorId": data.get("coordinatorId"),
            "rootRequestId": data.get("rootRequestId"), "tool": data["tool"],
            "projectId": CONTROL.sub("", SECRET.sub("[redacted]", project)) if isinstance(project, str) else None,
            "title": CONTROL.sub("", SECRET.sub("[redacted]", title)),
            "origin": data["origin"], "status": data["status"], "state": data["state"]}


def sessions_main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="st aico sessions", description=(
        "List all Tether catalog sessions, including ordinary/unlinked Aico widgets and roots. "
        "Read-only metadata: exact widget ID, ownership/coordinator, tool, project/title and state. "
        "Includes retained sessions with no visible window; ended sessions are omitted by the owner."))
    parser.add_argument("--owner-socket", type=socket_path, default=tether_socket())
    args = parser.parse_args(argv)
    collector = Collector("", args.owner_socket, "", time.monotonic() + 10, threading.Event())
    try:
        status, data = collector.receipt(args.owner_socket, "/v1/sessions", timeout=2)
        if status != 200 or not isinstance(data.get("items"), list):
            raise Unavailable("sessions_unavailable")
        items = [session_inventory_item(item) for item in data["items"]]
        if len({item["widgetId"] for item in items}) != len(items):
            raise Unavailable("sessions_receipt_unqualified")
        emit_json(collector, {"owner": "aico", "source": "tether", "items": items})
        return 0
    except (Unavailable, Stopped) as error:
        print(json.dumps({"owner": "aico", "observation": "unavailable",
                          "reason": str(error) if isinstance(error, Unavailable) else "deadline"}))
        return 1
    except BrokenPipeError:
        return 0


def main(argv: list[str] | None = None) -> int:
    import sys

    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "sessions":
        return sessions_main(argv[1:])
    if argv and argv[0] == "roots":
        return roots_main(argv[1:])
    if argv and argv[0] == "admin":
        return admin_main(argv[1:])
    if argv and argv[0] == "create":
        return create_main(argv[1:])
    if argv and argv[0] == "widget":
        return widget_main(argv[1:])
    if argv and argv[0] == "root":
        return root_main(argv[1:])
    if argv and argv[0] == "layout":
        return layout_main(argv[1:])
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("root", "owner", "tmux"):
        parser.add_argument(f"--{name}-socket", required=True, type=socket_path)
    parser.add_argument("--root", action="append", required=True,
                        help="JSON: " + ", ".join(f.name for f in dataclasses.fields(Pin)))
    parser.add_argument("--duration", required=True, type=float, help="seconds, >0 and <=3600")
    parser.add_argument("--interval", type=float, default=2, help="seconds, >=0.1")
    parser.add_argument("--max-failures", type=int, default=3, help="consecutive failures per root")
    args = parser.parse_args(argv)
    if (not math.isfinite(args.duration) or not 0 < args.duration <= 3600
            or not math.isfinite(args.interval) or args.interval < .1
            or not 1 <= args.max_failures <= 10):
        parser.error("invalid duration, interval, or failure bound")
    try:
        pins = [Pin.parse(value) for value in args.root]
    except (ValueError, TypeError):
        parser.error("invalid --root JSON or identity; see --help for exact fields")
    if len(set(pins)) != len(pins) or len({p.requestId for p in pins}) != len(pins):
        parser.error("duplicate roots")
    if len({p.tmuxServerId for p in pins}) != 1:
        parser.error("all roots in one invocation must share the explicit tmux server")
    cancel = threading.Event()
    handlers = {s: signal.signal(s, lambda *_: cancel.set()) for s in (signal.SIGINT, signal.SIGTERM)}
    collector = Collector(args.root_socket, args.owner_socket, args.tmux_socket,
                          time.monotonic() + args.duration, cancel)
    try:
        outcome = watch(collector, pins, args.interval, args.max_failures,
                        lambda record: emit_json(collector, record))
        return 1 if outcome in ("identity_changed", "observation_failures") else 0
    except BrokenPipeError:
        cancel.set()
        return 0
    finally:
        for s, handler in handlers.items():
            signal.signal(s, handler)


if __name__ == "__main__":
    raise SystemExit(main())
