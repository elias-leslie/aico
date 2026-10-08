"""Local root adapter over A-Term's pane and session ownership seams."""

from __future__ import annotations

import base64
import contextlib
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from ..cli.root_launch import PROMPT_ENV
from ..config import TMUX_DEFAULT_COLS, TMUX_DEFAULT_ROWS
from ..storage import agent_tools, panes, root_requests, sessions
from ..utils.tmux import FILTERED_ENV_VARS, get_tmux_session_name
from ..utils.tmux.sessions import (
    _apply_session_options,
    _build_tmux_scope_env,
    _can_spawn_tmux_scope,
)

KEY = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
GENERATION = re.compile(r"[0-9a-f]{64}\Z")
CODEX_THREAD_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
DIRECTED_DELIVERY = {"available": False, "reason": "exact_thread_generation_receipt_unqualified"}
POSITION = {"available": False, "reason": "browser_grid_has_no_pixel_window_bounds"}


class RootError(Exception):
    def __init__(self, status: int, error: str) -> None:
        self.status, self.error = status, error
        super().__init__(error)


def parse_create(value: Any) -> dict[str, Any]:
    fields = {"requestId", "tool", "projectId", "projectRoot", "initialPrompt", "role",
              "leadRootReference", "facetCapsuleRef", "resumeThreadId"}
    if not isinstance(value, dict) or value.keys() - fields:
        raise RootError(400, "invalid_body")
    for key in ("requestId", "projectId", "role"):
        if not isinstance(value.get(key), str) or not KEY.fullmatch(value[key]):
            raise RootError(400, "invalid_body")
    # Existing A-Term project columns are VARCHAR(64).
    if (len(value["projectId"]) > 64 or not isinstance(value.get("tool"), str)
            or value["tool"] not in {"codex", "claude-code"}):
        raise RootError(400, "invalid_body")
    thread_id = value.get("resumeThreadId")
    if thread_id is not None and (value["tool"] != "codex" or not isinstance(thread_id, str)
                                 or not CODEX_THREAD_ID.fullmatch(thread_id)):
        raise RootError(400, "invalid_body")
    for key in ("leadRootReference", "facetCapsuleRef"):
        ref = value.get(key)
        if ref is not None and (not isinstance(ref, str) or not KEY.fullmatch(ref)):
            raise RootError(400, "invalid_body")
    path, prompt = value.get("projectRoot"), value.get("initialPrompt")
    if (not isinstance(path, str) or not os.path.isabs(path) or os.path.normpath(path) != path
            or "\0" in path or not isinstance(prompt, str) or not prompt.strip() or "\0" in prompt):
        raise RootError(400, "invalid_body")
    try:
        if len(prompt.encode("utf-8")) > 64 * 1024:
            raise RootError(400, "invalid_body")
        path.encode("utf-8")
    except UnicodeEncodeError:
        raise RootError(400, "invalid_body") from None
    return {**value, "leadRootReference": value.get("leadRootReference"),
            "facetCapsuleRef": value.get("facetCapsuleRef"), "resumeThreadId": thread_id}


def request_digest(request: dict[str, Any]) -> str:
    fields = ("tool", "projectId", "projectRoot", "initialPrompt", "role",
              "leadRootReference", "facetCapsuleRef")
    # Preserve fresh-launch receipts, including old retained request tombstones.
    if request.get("resumeThreadId") is not None:
        fields += ("resumeThreadId",)
    # Same canonical array and UTF-8 JSON representation as Aico.
    content = json.dumps([request[key] for key in fields], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(content.encode()).hexdigest()


def launch_argv(request: dict[str, Any]) -> tuple[str, list[str]]:
    mode = "claude" if request["tool"] == "claude-code" else "codex"
    tool = agent_tools.get_by_slug(mode)
    if not tool or not tool.get("enabled") or not Path(request["projectRoot"]).is_dir():
        raise RootError(422, "launch_unavailable")
    if request["projectRoot"].endswith(";"):
        # tmux's argv command-separator grammar changes a trailing semicolon even
        # in an option value. Fail qualification before allocation for this path.
        raise RootError(422, "launch_unavailable")
    try:
        argv = shlex.split(tool["command"])
    except (TypeError, ValueError):
        raise RootError(422, "launch_unavailable") from None
    # Only the configured native CLI itself qualifies, never a shell/wrapper/fallback.
    if not argv or Path(argv[0]).name != mode or not shutil.which(argv[0]):
        raise RootError(422, "launch_unavailable")
    # Qualify only established native configurations. Caller-supplied exact Codex
    # resume is appended below; configured subcommands/custom grammars stay invalid.
    allowed_tail = ([], ["--dangerously-skip-permissions"]) if mode == "claude" else ([],)
    if argv[1:] not in allowed_tail:
        raise RootError(422, "launch_unavailable")
    if request.get("resumeThreadId") is not None:
        argv.extend(["resume", request["resumeThreadId"]])
    return mode, argv


def launch(root: dict[str, Any], request: dict[str, Any], argv: list[str]) -> None:
    """New tmux process only; no shell command string and no send-keys/paste."""
    name = get_tmux_session_name(root["session_id"])
    args = ["tmux", "new-session", "-d", "-s", name,
            "-x", str(TMUX_DEFAULT_COLS), "-y", str(TMUX_DEFAULT_ROWS),
            "-c", request["projectRoot"],
            "-e", f"ST_SESSION_ID={root['logical_session_id']}",
            "-e", f"A_TERM_SESSION_ID={root['session_id']}",
            "-e", f"{PROMPT_ENV}={base64.b64encode(request['initialPrompt'].encode()).decode()}",
            "--", "/usr/bin/env"]
    for key in sorted(FILTERED_ENV_VARS):
        args.extend(["-u", key])
    args.extend([sys.executable, str(Path(__file__).parents[1] / "cli" / "root_launch.py"),
                 base64.b64encode(json.dumps(argv).encode()).decode(), name])
    if _can_spawn_tmux_scope():
        args = ["systemd-run", "--user", "--scope", "--quiet", *args]
    try:
        # Do not use the generic command logger: argv contains the transient prompt.
        subprocess.run(args, env=_build_tmux_scope_env(), check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    finally:
        # Both launcher and owner clear transient env, including failed/ambiguous startup.
        subprocess.run(["tmux", "set-environment", "-t", name, "-u", PROMPT_ENV],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    _apply_session_options(name)


def _identity(session_id: str) -> tuple[str, str | None, list[str]]:
    """Read exact tmux server/session/pane generation without starting or resurrecting it."""
    try:
        result = subprocess.run(
            ["tmux", "display-message", "-p", "-t", get_tmux_session_name(session_id),
             "#{pid}|#{socket_path}|#{session_created}|#{session_id}|#{pane_id}|#{pane_pid}|#{pane_dead}|#{session_windows}|#{window_panes}"],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "uncertain", None, []
    if result.returncode:
        if any(text in result.stderr.lower() for text in
               ("can't find session", "no server running", "no such file or directory")):
            return "absent", None, []
        return "uncertain", None, []
    fields = result.stdout.strip().split("|")
    if (len(fields) != 9 or not fields[0].isdigit() or not fields[1].startswith("/")
            or not fields[2].isdigit() or not re.fullmatch(r"\$\d+", fields[3])
            or not re.fullmatch(r"%\d+", fields[4]) or not fields[5].isdigit()
            or fields[6] not in {"0", "1"} or fields[7:] != ["1", "1"]):
        return "uncertain", None, []
    if fields[6] == "1":
        return "ended", None, fields
    process = process_identity(int(fields[5]))
    if process is None or process[0] in {"gone", "Z"}:
        return "uncertain", None, []
    fields.append(process[1])
    return "running", hashlib.sha256("|".join([*fields[:6], fields[9]]).encode()).hexdigest(), fields


def process_identity(pid: int) -> tuple[str, str] | None:
    """Linux /proc state and start ticks distinguish PID reuse; unreadable is uncertain."""
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except FileNotFoundError:
        return "gone", ""
    except OSError:
        return None
    fields = stat[stat.rfind(")") + 2:].split()
    return (fields[0], fields[19]) if len(fields) >= 20 else None


def process_gone(root: dict[str, Any]) -> bool:
    if not root.get("process_pid") or not root.get("process_start_ticks"):
        return False
    process = process_identity(root["process_pid"])
    return process is not None and (process[0] in {"gone", "Z"} or process[1] != root["process_start_ticks"])


def probe(session_id: str) -> tuple[str, str | None]:
    status, generation, _ = _identity(session_id)
    return status, generation


def end_exact(session_id: str, generation: str) -> bool:
    """Evaluate and kill in tmux's command queue, with no external shell or PTY input."""
    status, current, fields = _identity(session_id)
    if status != "running" or current != generation:
        return False
    # Numeric, validated server/session/pane process identity survives the probe-to-kill gap.
    expected = [("pid", fields[0]), ("session_created", fields[2]),
                ("session_id", fields[3]), ("pane_id", fields[4]), ("pane_pid", fields[5])]
    condition = "#{==:#{pane_dead},0}"
    for field, value in expected:
        condition = "#{&&:#{==:#{" + field + "}," + value + "}," + condition + "}"
    result = subprocess.run(
        ["tmux", "if-shell", "-F", "-t", get_tmux_session_name(session_id), condition,
         f"kill-session -t {fields[3]}", "display-message -p ROOT_STALE"],
        capture_output=True, text=True, timeout=10,
    )
    if result.returncode or "ROOT_STALE" in result.stdout:
        return False
    for _ in range(20):
        process = process_identity(int(fields[5]))
        if (probe(session_id)[0] == "absent" and process is not None
                and (process[0] in {"gone", "Z"} or process[1] != fields[9])):
            return True
        time.sleep(0.05)
    return False


def describe(root: dict[str, Any]) -> dict[str, Any]:
    session = sessions.get_session(root["session_id"])
    generation = None
    if root["launch_state"] == "ended":
        status = "ended"
    elif session is None:
        absent = probe(root["session_id"])[0] == "absent"
        status = "ended" if root["launch_state"] == "reserved" or (absent and process_gone(root)) else "uncertain"
    elif root["launch_state"] == "reserved":
        status = "pending"
    else:
        status, generation, identity = _identity(root["session_id"])
        if root.get("generation") and generation and generation != root["generation"]:
            status, generation = "uncertain", None
        elif status == "running" and generation:
            if root_requests.observe(root["request_id"], generation, int(identity[5]), identity[9]):
                sessions.update_claude_state(root["session_id"], "running", expected_state="starting")
            else:
                # Another observer or retirement won; never disclose a competing generation.
                current = root_requests.get(root["request_id"])
                status = "ended" if current and current["launch_state"] == "ended" else "uncertain"
                generation = None
        elif status == "absent":
            status = "ended" if process_gone(root) else "uncertain"
        elif status == "ended" and not process_gone(root):
            status = "uncertain"
    if status == "ended" and root["launch_state"] != "ended":
        root_requests.retire(root)
    return {
        "owner": "a-term", "requestId": root["request_id"], "digest": root["digest"],
        "hostIdentity": root["session_id"], "logicalSessionId": root["logical_session_id"],
        "generation": generation, "surfaceLocator": f"a-term://pane/{root['pane_id']}",
        "role": root["role"], "leadRootReference": root["lead_root_reference"],
        "facetCapsuleRef": root["facet_capsule_ref"], "status": status, "bounds": None,
        "directedDelivery": DIRECTED_DELIVERY, "position": POSITION,
    }


def create(value: Any) -> dict[str, Any]:
    request = parse_create(value)
    digest = request_digest(request)
    root = root_requests.get(request["requestId"])
    argv = None
    if root is None:
        mode, argv = launch_argv(request)
        root = root_requests.reserve(request, digest, mode)
    if root["digest"] != digest:
        raise RootError(409, "request_conflict")
    # Missing/ended/ambiguous records never allocate another pane or launch again.
    if root["launch_state"] == "reserved" and sessions.get_session(root["session_id"]):
        if argv is None:
            _, argv = launch_argv(request)
        if root_requests.claim_launch(root["request_id"]):
            root = {**root, "launch_state": "attempted"}
            with contextlib.suppress(OSError, subprocess.SubprocessError):
                launch(root, request, argv)
            # Reconcile exact retained identity; disclose neither prompt nor launch errors.
    current = root_requests.get(root["request_id"])
    return describe(current or root)


def get(request_id: str) -> dict[str, Any]:
    root = root_requests.get(request_id)
    if root is None:
        raise RootError(404, "not_found")
    return describe(root)


def mutate(request_id: str, action: str, value: Any) -> dict[str, Any]:
    root = root_requests.get(request_id)
    if root is None:
        raise RootError(404, "not_found")
    if action == "send":
        raise RootError(503, "directed_delivery_unavailable")
    if (not isinstance(value, dict) or not isinstance(value.get("generation"), str)
            or not GENERATION.fullmatch(value["generation"])
            or (action in {"show", "end"} and value.keys() != {"generation"})):
        raise RootError(400, "invalid_body")
    descriptor = describe(root)
    if descriptor["status"] == "ended":
        if action == "end":
            return descriptor
        raise RootError(410, "ended")
    if descriptor["generation"] != value["generation"]:
        raise RootError(409, "stale_generation")
    if action == "position":
        raise RootError(503, "position_unavailable")
    if descriptor["status"] != "running":
        raise RootError(409, "workload_unavailable")
    if action == "end":
        try:
            if not end_exact(root["session_id"], value["generation"]):
                raise RootError(503, "close_uncertain")
            root_requests.retire(root)
            return describe({**root, "launch_state": "ended"})
        except (OSError, subprocess.SubprocessError):
            raise RootError(503, "close_uncertain") from None
    pane = panes.get_pane(root["pane_id"])
    if pane is None:
        raise RootError(409, "workload_unavailable")
    try:
        if pane.get("is_detached") and not panes.attach_pane(root["pane_id"]):
            raise RootError(409, "workload_unavailable")
    except ValueError:
        raise RootError(409, "view_unavailable") from None
    return describe(root)
