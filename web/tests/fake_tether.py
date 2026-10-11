"""In-process fake of Tether's v1 control API over a real Unix socket.

It implements the parts of docs/api-v1.md (tether repo) that A-Term calls,
with the same status codes and error bodies, so tests exercise A-Term's real
HTTP client. State is in memory; ``calls`` records every request.
"""

from __future__ import annotations

import hashlib
import json
import re
import socketserver
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

TMUX_BIN = "/usr/bin/tmux"
# Attach env is overrides only, then the unset list (api-v1.md "Terminal I/O").
ATTACH_ENV = {"TERM": "xterm-256color", "COLORTERM": "truecolor", "CLICOLOR": "1"}
ATTACH_UNSET = ("TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NO_COLOR")
ORIGINS = {"aico", "a-term", "cli"}
ROOT_ORIGINS = {"aico", "a-term"}
ROOT_FIELDS = {
    "requestId", "tool", "projectId", "projectRoot", "initialPrompt", "role", "leadRootReference",
    "facetCapsuleRef", "resumeSessionId", "origin", "aTermSessionId",
}
TOOL_FIELDS = {
    "slug", "name", "argv", "command", "processName", "description", "color", "displayOrder",
    "isDefault", "enabled", "aliases", "contextHook",
}

SEED_TOOLS: list[dict[str, Any]] = [
    {"slug": "claude-code", "name": "Claude Code", "argv": ["claude", "--dangerously-skip-permissions"],
     "processName": "claude", "displayOrder": 0, "isDefault": False, "aliases": ["claude"],
     "contextHook": "claude-session-start", "color": "#D97757"},
    {"slug": "codex", "name": "Codex", "argv": ["codex", "--yolo"], "processName": "codex",
     "displayOrder": 1, "isDefault": True, "aliases": [], "contextHook": "codex-hooks", "color": "#9B8CFF"},
    {"slug": "agy", "name": "Antigravity", "argv": ["agy", "--dangerously-skip-permissions"],
     "processName": "agy", "displayOrder": 3, "isDefault": False, "aliases": []},
    {"slug": "pi", "name": "Pi", "argv": ["pi", "--approve"], "processName": "pi-coding-agent",
     "displayOrder": 5, "isDefault": False, "aliases": [], "contextHook": "pi-extension"},
    {"slug": "shell", "name": "Shell", "argv": [], "processName": None, "displayOrder": 9,
     "isDefault": False, "aliases": []},
]


class FakeTetherState:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.lock = threading.Lock()
        self.calls: list[tuple[str, str, Any]] = []
        self.sessions: dict[str, dict[str, Any]] = {}
        self.ended: set[str] = set()
        self.tools: dict[str, dict[str, Any]] = {}
        self.projects: list[dict[str, Any]] = []
        self.project_source = "local"
        self.roots: dict[str, dict[str, Any]] = {}
        self.events: list[dict[str, Any]] = []
        self.boot_id = "boot-1"
        self.api_version = 1
        self.resize_claims: list[dict[str, Any]] = []
        self.resize_results: list[dict[str, Any]] = []
        self.next_create_status = "running"
        self.fail_next: dict[str, tuple[int, str]] = {}
        self._counter = 0
        now = int(time.time() * 1000)
        for tool in SEED_TOOLS:
            self.tools[tool["slug"]] = {
                "id": f"tool-{tool['slug']}", "description": None, "color": None, "contextHook": None,
                "enabled": True, "createdAt": now, "updatedAt": now, **tool,
                "command": " ".join(tool["argv"]),
            }

    # -- helpers ---------------------------------------------------------
    def _generation(self, session_id: str) -> str:
        self._counter += 1
        return hashlib.sha256(f"{session_id}:{self._counter}".encode()).hexdigest()

    def resolve_tool(self, ref: str | None) -> dict[str, Any] | None:
        if ref is None:
            return self.default_tool()
        for tool in self.tools.values():
            if ref in {tool["slug"], tool["id"], *tool.get("aliases", [])}:
                return tool
        return None

    def default_tool(self) -> dict[str, Any] | None:
        marked = [tool for tool in self.tools.values() if tool["isDefault"] and tool["enabled"]]
        if marked:
            return marked[0]
        enabled = sorted((t for t in self.tools.values() if t["enabled"]), key=lambda t: t["displayOrder"])
        return enabled[0] if enabled else None

    def add_session(
        self,
        *,
        tool: str = "codex",
        project_id: str | None = None,
        project_root: str | None = None,
        origin: str = "aico",
        status: str = "running",
        name: str | None = None,
        a_term_session_id: str | None = None,
        root_request_id: str | None = None,
    ) -> dict[str, Any]:
        self._counter += 1
        session_id = f"{0xA0000000 + self._counter:08x}"
        socket_path = str(self.root / f"tmux-{session_id}.sock")
        descriptor = {
            "id": session_id,
            "ownershipId": f"aico-widget-{session_id}",
            "generation": self._generation(session_id),
            "status": status,
            "available": status == "running",
            "tool": tool,
            "name": name,
            "label": f"Session {self._counter}",
            "projectId": project_id,
            "projectRoot": project_root,
            "origin": origin,
            "aTermSessionId": a_term_session_id,
            "rootRequestId": root_request_id,
            "lifecycleVersion": 1,
            "tmux": {
                "serverId": f"srv{session_id}",
                "socket": socket_path,
                "sessionId": f"${self._counter}",
                "paneId": f"%{self._counter}",
                "sessionName": f"tether-{session_id}",
            },
            "createdAt": int(time.time() * 1000),
        }
        self.sessions[session_id] = descriptor
        self.events.append({"type": "session.created", "data": {"id": session_id}})
        return descriptor

    def end(self, session_id: str) -> None:
        self.sessions.pop(session_id, None)
        self.ended.add(session_id)
        self.events.append({"type": "session.ended", "data": {"id": session_id}})


def _error(status: int, code: str, **extra: Any) -> tuple[int, dict[str, Any]]:
    return status, {"error": code, **extra}


class _Handler(BaseHTTPRequestHandler):
    server: _Server
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def address_string(self) -> str:
        return "fake-tether"

    def _send(self, status: int, body: Any, content_type: str = "application/json") -> None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(data)))
        self.send_header("connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def _body(self) -> Any:
        length = int(self.headers.get("content-length") or 0)
        if not length:
            return None
        return json.loads(self.rfile.read(length))

    def _dispatch(self, method: str) -> None:
        parsed = urlsplit(self.path)
        parts = [unquote(part) for part in parsed.path.split("/") if part]
        query = {key: values[-1] for key, values in parse_qs(parsed.query).items()}
        body = self._body() if method in {"POST", "PATCH"} else None
        state = self.server.state
        with state.lock:
            state.calls.append((method, parsed.path, body))
            failure = state.fail_next.pop(f"{method} {parsed.path}", None)
        if failure:
            self._send(*_error(*failure))
            return
        if parts == ["v1", "events"]:
            with state.lock:
                lines = [{"seq": 0, "bootId": state.boot_id, "type": "hello", "data": {"apiVersion": state.api_version}}]
                lines += [{"seq": i + 1, "bootId": state.boot_id, **event} for i, event in enumerate(state.events)]
            self._send(200, b"".join(json.dumps(line).encode() + b"\n" for line in lines), "application/x-ndjson")
            return
        with state.lock:
            status, payload = route(state, method, parts, query, body)
        self._send(status, payload)

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PATCH(self) -> None:
        self._dispatch("PATCH")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")


def _fenced(state: FakeTetherState, session_id: str, body: Any) -> tuple[dict[str, Any] | None, tuple[int, dict[str, Any]] | None]:
    session = state.sessions.get(session_id)
    if session is None:
        return None, (_error(410, "ended") if session_id in state.ended else _error(404, "not_found"))
    if not isinstance(body, dict) or not isinstance(body.get("generation"), str):
        return None, _error(400, "invalid_body")
    if body["generation"] != session["generation"]:
        return None, _error(409, "stale_generation")
    return session, None


def _sessions(state: FakeTetherState, method: str, rest: list[str], query: dict[str, str], body: Any) -> tuple[int, Any]:
    if not rest:
        if method == "GET":
            items = [
                s for s in state.sessions.values()
                if (not query.get("project") or s["projectId"] == query["project"])
                and (not query.get("origin") or s["origin"] == query["origin"])
                and (not query.get("tool") or s["tool"] == query["tool"])
            ]
            return 200, {"items": items}
        if method == "POST":
            if not isinstance(body, dict) or body.get("origin") not in ORIGINS or not isinstance(body.get("size"), dict):
                return _error(400, "invalid_body")
            if body.get("aTermSessionId") is not None and body["origin"] != "a-term":
                return _error(400, "invalid_body")
            tool = state.resolve_tool(body.get("tool"))
            if tool is None:
                return _error(400, "unknown_tool")
            status = state.next_create_status
            descriptor = state.add_session(
                tool=tool["slug"], project_id=body.get("projectId"), project_root=body.get("projectRoot"),
                origin=body["origin"], status=status, name=body.get("name"),
                a_term_session_id=body.get("aTermSessionId"),
            )
            return (201 if status == "running" else 202), descriptor
        return _error(405, "method_not_allowed")
    session_id, action = rest[0], (rest[1] if len(rest) > 1 else None)
    if action is None:
        if method == "GET":
            session = state.sessions.get(session_id)
            return (200, session) if session else _error(404, "not_found")
        if method == "PATCH":
            session, failure = _fenced(state, session_id, body)
            if failure or session is None:
                return failure or _error(404, "not_found")
            session["name"] = body.get("name")
            state.events.append({"type": "session.updated", "data": {"id": session_id}})
            return 200, session
    if action == "attach" and method == "GET":
        session = state.sessions.get(session_id)
        if session is None:
            return _error(404, "not_found")
        argv = [TMUX_BIN, "-S", session["tmux"]["socket"], "attach-session", "-t", session["tmux"]["sessionId"]]
        return 200, {"generation": session["generation"], "argv": argv, "env": dict(ATTACH_ENV), "unset": list(ATTACH_UNSET)}
    if action == "capture" and method == "GET":
        session = state.sessions.get(session_id)
        return (200, {"generation": session["generation"], "text": "$ "}) if session else _error(404, "not_found")
    if method != "POST":
        return _error(405, "method_not_allowed")
    session, failure = _fenced(state, session_id, body)
    if failure:
        if action == "end" and failure[0] == 410:
            return 200, {"status": "ended"}
        return failure
    if session is None:
        return _error(404, "not_found")
    if action == "end":
        state.end(session_id)
        return 200, {"status": "ended"}
    if action in {"respawn", "load-tui", "switch-project"}:
        if session["status"] == "legacy":
            return _error(409, "legacy_session")
        if action == "load-tui":
            tool = state.resolve_tool(body.get("tool"))
            if tool is None:
                return _error(400, "unknown_tool")
            session["tool"] = tool["slug"]
        if action == "switch-project":
            project = next((p for p in state.projects if p["id"] == body.get("projectId")), None)
            if project is None:
                return _error(400, "unknown_project")
            session["projectId"], session["projectRoot"] = project["id"], project["root"]
        session["generation"] = state._generation(session_id)
        session["status"], session["available"] = "running", True
        return 200, session
    if action == "resize-claim":
        state.resize_claims.append({"id": session_id, **body})
        if state.resize_results:
            return 200, state.resize_results.pop(0)
        return 200, {"applied": True}
    if action == "inject":
        return 200, {"generation": session["generation"], "delivered": True}
    return _error(404, "not_found")


def _tool_patch(item: Any) -> dict[str, Any] | None:
    """Tether's ``toolFields``: ``command`` becomes ``argv``; unknown fields are invalid."""
    if not isinstance(item, dict) or set(item) - TOOL_FIELDS or ("argv" in item and "command" in item):
        return None
    patch = {key: value for key, value in item.items() if key != "command"}
    if "command" in item:
        patch["argv"] = str(item["command"]).split()
    return patch


def _import_tools(state: FakeTetherState, body: Any) -> tuple[int, Any]:
    if not isinstance(body, dict) or set(body) - {"tools", "dryRun", "updateExisting"} or not isinstance(body.get("tools"), list):
        return _error(400, "invalid_body")
    patches = [_tool_patch(item) for item in body["tools"]]
    if any(p is None or not p.get("slug") or not p.get("name") or "argv" not in p for p in patches):
        return _error(400, "invalid_body")
    result: dict[str, Any] = {"created": [], "updated": [], "unchanged": [], "differs": []}
    writes: list[tuple[str, dict[str, Any]]] = []
    for patch in patches:
        assert patch is not None
        existing = state.resolve_tool(patch["slug"])
        if existing is None:
            writes.append(("create", patch))
            result["created"].append(patch["slug"])
            continue
        fields = [key for key, value in patch.items() if key != "slug" and existing.get(key) != value]
        if not fields:
            result["unchanged"].append(patch["slug"])
        elif body.get("updateExisting"):
            writes.append(("update", {key: patch[key] for key in fields} | {"slug": existing["slug"]}))
            result["updated"].append(patch["slug"])
        else:
            result["differs"].append({"slug": patch["slug"], "fields": fields})
    dry_run = bool(body.get("dryRun"))
    if not dry_run:
        for kind, patch in writes:
            if kind == "create":
                _tools(state, "POST", [], {}, patch)
            else:
                slug = patch.pop("slug")
                _tools(state, "PATCH", [slug], {}, patch)
    return 200, {"applied": not dry_run, **result}


def _tools(state: FakeTetherState, method: str, rest: list[str], query: dict[str, str], body: Any) -> tuple[int, Any]:
    if rest == ["import"] and method == "POST":
        return _import_tools(state, body)
    if not rest:
        if method == "GET":
            items = sorted(state.tools.values(), key=lambda t: (t["displayOrder"], t["slug"]))
            if query.get("enabled") == "1":
                items = [t for t in items if t["enabled"]]
            default = state.default_tool()
            return 200, {"items": items, "defaultSlug": default["slug"] if default else None}
        if method == "POST":
            if not isinstance(body, dict) or not body.get("slug") or not body.get("name"):
                return _error(400, "invalid_body")
            if state.resolve_tool(body["slug"]) is not None:
                return _error(409, "slug_conflict")
            argv = body.get("argv") if isinstance(body.get("argv"), list) else str(body.get("command") or "").split()
            now = int(time.time() * 1000)
            tool = {
                "id": f"tool-{body['slug']}", "slug": body["slug"], "name": body["name"], "argv": argv,
                "command": " ".join(argv), "processName": body.get("processName"),
                "description": body.get("description"), "color": body.get("color"),
                "displayOrder": int(body.get("displayOrder") or 0), "isDefault": bool(body.get("isDefault")),
                "enabled": body.get("enabled", True), "aliases": list(body.get("aliases") or []),
                "contextHook": body.get("contextHook"), "createdAt": now, "updatedAt": now,
            }
            if tool["isDefault"]:
                for other in state.tools.values():
                    other["isDefault"] = False
            state.tools[tool["slug"]] = tool
            return 201, tool
        return _error(405, "method_not_allowed")
    tool = state.resolve_tool(rest[0])
    if tool is None:
        return _error(404, "not_found")
    if method == "GET":
        return 200, tool
    if method == "PATCH":
        if "slug" in (body or {}):
            return _error(400, "slug_immutable")
        for key, value in (body or {}).items():
            if key == "command":
                tool["argv"] = str(value).split()
                tool["command"] = " ".join(tool["argv"])
            elif key == "argv":
                tool["argv"] = list(value)
                tool["command"] = " ".join(value)
            elif key == "isDefault" and value:
                for other in state.tools.values():
                    other["isDefault"] = False
                tool["isDefault"] = True
            else:
                tool[key] = value
        return 200, tool
    if method == "DELETE":
        if tool["isDefault"]:
            return _error(409, "default_tool")
        if any(s["tool"] == tool["slug"] for s in state.sessions.values()):
            return _error(409, "tool_in_use")
        state.tools.pop(tool["slug"])
        return 200, {"deleted": True}
    return _error(405, "method_not_allowed")


def _roots(state: FakeTetherState, method: str, rest: list[str], query: dict[str, str], body: Any) -> tuple[int, Any]:
    if not rest:
        if method == "GET":
            origin = query.get("origin")
            if origin is not None and origin not in ROOT_ORIGINS:
                return _error(400, "invalid_query")
            roots = [root for root in state.roots.values() if origin is None or root["origin"] == origin]
            return 200, {"owner": origin or "aico", "available": True, "directedDelivery": {"available": False},
                         "roots": roots}
        if method == "POST":
            if not isinstance(body, dict) or not isinstance(body.get("requestId"), str) or set(body) - ROOT_FIELDS:
                return _error(400, "invalid_body")
            origin = body.get("origin", "aico")
            if origin not in ROOT_ORIGINS or (body.get("aTermSessionId") is not None and origin != "a-term"):
                return _error(400, "invalid_body")
            existing = state.roots.get(body["requestId"])
            if existing:
                return 200, existing
            tool = state.resolve_tool(body.get("tool"))
            session = state.add_session(tool=tool["slug"] if tool else "codex", project_id=body.get("projectId"),
                                        project_root=body.get("projectRoot"), origin="root",
                                        a_term_session_id=body.get("aTermSessionId"),
                                        root_request_id=body["requestId"])
            root = {
                "owner": origin, "origin": origin, "requestId": body["requestId"], "digest": "d" * 64,
                "hostIdentity": session["id"], "generation": session["generation"],
                "logicalSessionId": f"logical-{session['id']}", "surfaceLocator": f"aico://widget/{session['id']}",
                "role": body.get("role"), "leadRootReference": body.get("leadRootReference"),
                "facetCapsuleRef": body.get("facetCapsuleRef"), "status": "running", "bounds": None,
            }
            state.roots[body["requestId"]] = root
            return 200, root
    root = state.roots.get(rest[0])
    if root is None:
        return _error(404, "not_found")
    action = rest[1] if len(rest) > 1 else None
    if action is None and method == "GET":
        return 200, root
    if action == "send":
        return _error(503, "directed_delivery_unavailable")
    if action == "admin":
        return _error(503, "admin_unavailable")
    if method != "POST" or action not in {"end", "show", "position", "title"}:
        return _error(404, "not_found")
    if root["status"] == "ended":
        return (200, root) if action == "end" else _error(410, "ended")
    if not isinstance(body, dict) or body.get("generation") != root["generation"]:
        return _error(409, "stale_generation")
    if action == "end":
        state.end(root["hostIdentity"])
        root.update(status="ended", generation=None)
        return 200, root
    if action == "title":
        # No GUI connected: Tether renames the session itself (3a).
        label = _label(body.get("label"))
        if set(body) != {"generation", "label"} or label is None:
            return _error(400, "invalid_body")
        state.sessions[root["hostIdentity"]]["name"] = label
        state.events.append({"type": "session.updated", "data": {"id": root["hostIdentity"]}})
        return 200, root
    return _error(503, "gui_unavailable")


# ECMAScript TrimString whitespace and line terminators, as Tether (Aico) trims labels.
_LABEL_TRIM = (
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005"
    "\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def _label(value: Any) -> str | None:
    """Tether's title rule: trimmed, 1-160 UTF-8 bytes, no control characters."""
    if not isinstance(value, str):
        return None
    label = value.strip(_LABEL_TRIM)
    if not label or len(label.encode()) > 160:
        return None
    if any(ord(c) < 32 or 127 <= ord(c) <= 159 or c in "\u2028\u2029" for c in label):
        return None
    return label


def _projects(state: FakeTetherState, method: str, query: dict[str, str], body: Any) -> tuple[int, Any]:
    if method == "GET":
        return 200, {"source": state.project_source, "fetchedAt": 0, "projects": state.projects}
    if method != "POST":
        return _error(405, "method_not_allowed")
    if state.project_source != "local":
        return _error(409, "projects_managed_by_summitflow")
    if not isinstance(body, dict) or set(body) - {"id", "root", "name"}:
        return _error(400, "invalid_body")
    project_id, root = body.get("id"), body.get("root")
    if not isinstance(project_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", project_id):
        return _error(400, "invalid_project_id")
    if not isinstance(root, str) or not Path(root).is_absolute() or not Path(root).is_dir():
        return _error(400, "invalid_project_root")
    if any(project["id"] == project_id for project in state.projects):
        return _error(409, "project_exists")
    project = {"id": project_id, "name": body.get("name") or project_id, "root": root, "lifecycle": None}
    state.projects.append(project)
    state.events.append({"type": "projects.changed", "data": {"id": project_id, "change": "registered"}})
    return 201, project


def route(state: FakeTetherState, method: str, parts: list[str], query: dict[str, str], body: Any) -> tuple[int, Any]:
    if parts[:1] != ["v1"]:
        return _error(404, "not_found")
    rest = parts[1:]
    if rest == ["health"]:
        return 200, {"status": "ok", "name": "tether", "instance": "default", "version": "0.0.1",
                     "apiVersion": state.api_version, "bootId": state.boot_id}
    if rest == ["version"]:
        return 200, {"name": "tether", "version": "0.0.1", "apiVersion": state.api_version, "minApiVersion": 1}
    if rest[:1] == ["sessions"]:
        return _sessions(state, method, rest[1:], query, body)
    if rest[:1] == ["tools"]:
        return _tools(state, method, rest[1:], query, body)
    if rest == ["projects"]:
        return _projects(state, method, query, body)
    if rest[:1] == ["roots"]:
        return _roots(state, method, rest[1:], query, body)
    return _error(404, "not_found")


class _Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    state: FakeTetherState


class FakeTether:
    """Start with :meth:`start`; point A-Term at :attr:`socket_path`."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.socket_path = str(root / "control.sock")
        self.state = FakeTetherState(root)
        self._server: _Server | None = None

    def start(self) -> FakeTether:
        server = _Server(self.socket_path, _Handler)
        server.state = self.state
        self._server = server
        threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, name="fake-tether", daemon=True).start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None

    # Convenience pass-throughs for tests.
    def add_session(self, **kwargs: Any) -> dict[str, Any]:
        with self.state.lock:
            return self.state.add_session(**kwargs)

    def end(self, session_id: str) -> None:
        with self.state.lock:
            self.state.end(session_id)

    @property
    def calls(self) -> list[tuple[str, str, Any]]:
        return self.state.calls
