#!/usr/bin/env python3
"""Foreground, read-only root observation. Emits metadata, never terminal text.

Invoke with explicit absolute --root-socket, --owner-socket, --tmux-socket,
--duration SECONDS and one or more --root JSON objects containing all Pin fields.
Pins come from existing owner receipts and the exact managed tmux server identity;
this tool never discovers, creates, submits to, or re-pins a root. JSONL on stdout
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
    if (not value.startswith("/") or len(value.encode()) > 107
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
                 deadline: float, cancel: threading.Event, tmux: str = "tmux"):
        self.root_socket = root_socket
        self.owner_socket = owner_socket
        self.tmux_socket = tmux_socket
        self.deadline = deadline
        self.cancel = cancel
        self.tmux = tmux

    def remaining(self) -> float:
        remaining = self.deadline - time.monotonic()
        if self.cancel.is_set() or remaining <= 0:
            raise Stopped()
        return remaining

    def receipt(self, path: str, route: str) -> tuple[int, dict]:
        connection = http.client.HTTPConnection("localhost", timeout=min(.25, self.remaining()))
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.sock = client
        try:
            client.settimeout(min(.25, self.remaining()))
            client.connect(path)
            connection.request("GET", route, headers={"Connection": "close"})
            response = connection.getresponse()
            parts = bytearray()
            while True:
                self.remaining()
                part = response.read1(min(4096, RECEIPT_LIMIT + 1 - len(parts)))
                parts.extend(part)
                if len(parts) > RECEIPT_LIMIT:
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
        status, owner = self.receipt(self.owner_socket, f"/v1/sessions/{pin.widgetId}")
        if status != 200:
            raise Unavailable("pane_unavailable")
        expected = {"owner": "aico", "widgetId": pin.widgetId, "generation": pin.generation,
                    "sessionId": pin.sessionId, "tmuxSessionId": pin.tmuxSessionId,
                    "paneId": pin.paneId}
        if any(owner.get(k) != v for k, v in expected.items()):
            raise IdentityChanged()

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
    try:
        while True:
            for pin in pins:
                collector.remaining()
                state = collector.sample(pin)
                if pin not in previous:
                    emit({"requestId": pin.requestId, "widgetId": pin.widgetId,
                          "generation": pin.generation, "event": "baseline", **state})
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
                        emit({"requestId": pin.requestId, "widgetId": pin.widgetId,
                              "generation": pin.generation, "event": "transition", **state})
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


def main(argv: list[str] | None = None) -> int:
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
