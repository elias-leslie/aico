#!/usr/bin/env python3
"""Foreground, read-only root observation. Emits metadata, never terminal text.

Use `st aico roots [REQUEST_ID] [--watch SECONDS]` for compact snapshots or
bounded change-only JSONL. Discovery reads existing private catalog/owner receipts
and verifies exact tmux server/pane identity once; a watch never re-pins.
Unknown TUI profiles are unavailable. Output contains no terminal or draft text.

Explicit-pin compatibility: invoke with --root-socket, --owner-socket, --tmux-socket,
--duration SECONDS and one or more --root JSON objects containing all Pin fields.
Pins come from existing owner receipts and the exact managed tmux server identity;
this tool never creates, submits to, or re-pins a root. JSONL on stdout
contains initial baselines and changes only. Terminal states describe visible TUI
chrome, not whether the assigned objective is complete. No files are written.
"""

from __future__ import annotations

import argparse
import dataclasses
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
from collections.abc import Callable
from urllib.parse import quote

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
WORKED = re.compile(r"^[─━\s]*(?:[•●]\s*)?Worked for\s+\S.+$", re.I)
ACTIVE = re.compile(
    r"^[\s•●◦✻✽✶✳⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]*"
    r"(?:(?:Working|Compacting context)(?:…|\.\.\.)?(?:\s*\([^)]*\))?|"
    r"(?:Running|Calling|Executing|Thinking|Searching|Reading|Editing|Testing)\b.*"
    r"(?:esc to interrupt|\btool\b|\([^)]*\)))\s*$", re.I,
)
FOOTER = re.compile(
    r"^(?:[─━]+|.*\s·\s.*\bcontext\s+\d{1,3}%\s*(?:left|remaining)\b.*|"
    r"context\s+\d{1,3}%\s*(?:left|remaining)\b.*|"
    r"\d{1,3}%\s*context\s*(?:left|remaining)\b.*)$", re.I,
)
BANNERS = (
    ("approval", re.compile(
        r"^(?:[⚠!]\s*)?(?:Would you like to (?:run|proceed).*\?|"
        r"Do you want to (?:run|proceed|allow).*\?|Approval required(?:[:.].*)?|"
        r"Waiting for (?:your )?approval[.!]?)$", re.I)),
    ("capacity", re.compile(
        r"^(?:[⚠!]\s*)?(?:You've hit your usage limit.*|"
        r"You have hit your usage limit.*|Usage limit reached.*|"
        r"Rate limit (?:reached|exceeded).*|Model (?:is )?(?:at capacity|overloaded).*|"
        r"API Error:\s*(?:429|529)\b.*)$", re.I)),
    ("error", re.compile(
        r"^(?:[⚠!]\s*(?:Error|Connection failed|Authentication failed)\b.*|"
        r"API Error:\s*(?:401|403|5\d\d)\b.*|"
        r"Reconnecting\.\.\.\s*\d+/\d+.*)$", re.I)),
)
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
            "requestId": r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}",
            "widgetId": r"[0-9a-f]{8}",
            "logicalSessionId": r"aico-root-[A-Za-z0-9-]{1,100}",
            "generation": r"[0-9a-f]{64}",
            "sessionId": r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}",
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


def classify(raw: bytes) -> tuple[dict, str]:
    """Returns closed metadata and one sanitized sample; neither draft nor prose is emitted."""
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
        "\n".join(unquoted), re.I,
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
                 discovered: bool = False):
        self.root_socket = root_socket
        self.owner_socket = owner_socket
        self.tmux_socket = tmux_socket
        self.deadline = deadline
        self.cancel = cancel
        self.tmux = tmux
        self.discovered = discovered

    def remaining(self) -> float:
        remaining = self.deadline - time.monotonic()
        if self.cancel.is_set() or remaining <= 0:
            raise Stopped()
        return remaining

    def receipt(self, path: str, route: str, payload: dict | None = None) -> tuple[int, dict]:
        limit = CATALOG_LIMIT if route == "/v1/roots" else RECEIPT_LIMIT
        connection = http.client.HTTPConnection("localhost", timeout=min(.25, self.remaining()))
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.sock = client
        try:
            client.settimeout(min(.25, self.remaining()))
            client.connect(path)
            connection.request("GET" if payload is None else "POST", route,
                               body=None if payload is None else json.dumps(payload),
                               headers={"Connection": "close", "Content-Type": "application/json"})
            response = connection.getresponse()
            parts = bytearray()
            while True:
                self.remaining()
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
        if self.discovered and root.get("tool") != "codex":
            raise IdentityChanged()
        status, owner = self.receipt(self.owner_socket, f"/v1/sessions/{pin.widgetId}")
        if status != 200:
            raise Unavailable("pane_unavailable")
        expected = {"owner": "aico", "widgetId": pin.widgetId, "generation": pin.generation,
                    "sessionId": pin.sessionId, "tmuxSessionId": pin.tmuxSessionId,
                    "paneId": pin.paneId}
        if self.discovered:
            expected.update(tmuxServerId=pin.tmuxServerId, tmuxSocket=self.tmux_socket,
                            tool="codex")
        if any(owner.get(k) != v for k, v in expected.items()):
            raise IdentityChanged()

    def discover(self, request_id: str | None) -> tuple[list[tuple[Pin, Collector]], list[dict]]:
        status, catalog = self.receipt(self.root_socket, "/v1/roots")
        roots = catalog.get("roots")
        if status != 200 or catalog.get("owner") != "aico" or not isinstance(roots, list):
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
            if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", key):
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
            if root.get("tool") != "codex":
                unavailable.append({**record, "terminal": "ambiguous", "reason": "unsupported_profile"})
                continue
            try:
                widget = root.get("hostIdentity")
                if not isinstance(widget, str) or not re.fullmatch(r"[0-9a-f]{8}", widget):
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
                                  self.deadline, self.cancel, self.tmux, discovered=True)
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
            # Kill only this read-only client's process group, never the server.
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
            state, _ = classify(raw)
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


def emit_json(collector: Collector, record: dict, fd: int = 1) -> None:
    """A stalled output pipe must not outlive cancellation or the deadline."""
    output = memoryview((json.dumps(record, separators=(",", ":")) + "\n").encode())
    blocking = os.get_blocking(fd)
    os.set_blocking(fd, False)
    try:
        while output:
            remaining = collector.remaining()
            if not select.select([], [fd], [], min(.05, remaining))[1]:
                continue
            try:
                output = output[os.write(fd, output):]
            except BlockingIOError:
                continue
    finally:
        os.set_blocking(fd, blocking)


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
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    parser.add_argument("--root-socket", type=socket_path,
                        default=os.environ.get("AICO_GUI_CONTROL_SOCKET", f"{runtime}/aico/gui-control.sock"))
    args = parser.parse_args(argv)
    key = r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}"
    if not re.fullmatch(key, args.request_id):
        parser.error("invalid root request ID")
    if args.operation:
        if (not args.generation or not re.fullmatch(r"[0-9a-f]{64}", args.generation)
                or not args.thread or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", args.thread)
                or not args.request_key or not re.fullmatch(key, args.request_key)
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
            denied = {"native_tui_atomic_admin_unavailable", "invalid_body", "stale_generation",
                      "ended", "not_found", "gui_unavailable", "unsupported_tool"}
            if (status not in (400, 404, 409, 410, 422, 503) or data.get("error") not in denied
                    or data.get("applied", False) is not False):
                raise Unavailable("admin_receipt_unqualified")
            output.update(applied=False, reason=data["error"])
            if data.get("terminalAdmin") == TERMINAL_ADMIN:
                output["terminalAdmin"] = TERMINAL_ADMIN
        else:
            generation = data.get("generation")
            if (status != 200 or data.get("owner") != "aico" or data.get("requestId") != args.request_id
                    or data.get("terminalAdmin") != TERMINAL_ADMIN
                    or generation is not None and not re.fullmatch(r"[0-9a-f]{64}", str(generation))):
                raise Unavailable("admin_capability_unavailable")
            output.update(generation=generation, currentThreadId=None, terminalAdmin=TERMINAL_ADMIN)
        emit_json(collector, output)
        return int(bool(args.operation))
    except (Unavailable, Stopped) as error:
        output.update(applied=None if sent else False,
                      reason=str(error) if isinstance(error, Unavailable) else "deadline")
        try:
            emit_json(collector, output)
        except Stopped:
            pass
        return 1
    except BrokenPipeError:
        return 0


def roots_main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="st aico roots", description=__doc__)
    parser.add_argument("request_id", nargs="?", help="exact retained Aico catalog request ID")
    parser.add_argument("--watch", type=float, help="change-only JSONL seconds, >0 and <=3600")
    parser.add_argument("--interval", type=float, default=2, help="poll seconds, >=0.1")
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    parser.add_argument("--root-socket", type=socket_path,
                        default=os.environ.get("AICO_GUI_CONTROL_SOCKET", f"{runtime}/aico/gui-control.sock"))
    parser.add_argument("--owner-socket", type=socket_path,
                        default=os.environ.get("AICO_CONTROL_SOCKET", f"{runtime}/aico/control.sock"))
    args = parser.parse_args(argv)
    if args.request_id and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", args.request_id):
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
        try:
            emit_json(discovery, {"owner": "aico", "observation": "unavailable", "reason": str(error)})
        except Stopped:
            pass
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


def main(argv: list[str] | None = None) -> int:
    import sys

    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "roots":
        return roots_main(argv[1:])
    if argv and argv[0] == "admin":
        return admin_main(argv[1:])
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
