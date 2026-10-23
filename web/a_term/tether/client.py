"""Stdlib HTTP client for the Tether session daemon (API v1 over a Unix socket).

Tether owns sessions, the agent-tool registry, projects and ``/v1/roots``.
A-Term only keeps views. Everything here is synchronous and uses only the
standard library so CLI wrappers (``tsession``) and the FastAPI service share
one client. Call it from async code with ``asyncio.to_thread``.

Errors:

- :class:`TetherUnavailable`: the socket is missing or refuses connections.
  This means "control unavailable", never "session gone"; running sessions
  keep running while Tether restarts.
- :class:`TetherError`: Tether answered with a 4xx/5xx. ``code`` is Tether's
  stable error code (``stale_generation``, ``not_found``, ...).
"""

from __future__ import annotations

import http.client
import json
import os
import socket
import stat
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode

#: The lowest Tether API version this A-Term build speaks.
MIN_API_VERSION = 1
DEFAULT_INSTANCE = "default"
#: The agent user's Tether instance (system-run, shared to the owner's group).
#: ``TETHER_AGENT_SOCKET`` overrides it.
DEFAULT_AGENT_SOCKET = "/run/tether/agent/default/control.sock"
DEFAULT_TIMEOUT_SECONDS = 10.0
#: Tether sends a heartbeat every 15 s; a silent stream for longer is dead.
EVENT_READ_TIMEOUT_SECONDS = 45.0


class TetherUnavailable(Exception):
    """Tether's control socket is not reachable."""


class TetherError(Exception):
    """Tether answered with an error status."""

    def __init__(self, status: int, code: str, body: Any = None) -> None:
        self.status = status
        self.code = code
        self.body = body
        super().__init__(f"tether {status} {code}")


class TetherVersionError(Exception):
    """The running Tether is older than :data:`MIN_API_VERSION`."""


@dataclass(frozen=True)
class TetherResponse:
    status: int
    body: Any


def default_socket_path() -> Path:
    """The active instance: ``$TETHER_SOCKET``, else the caller's own instance."""
    configured = os.environ.get("TETHER_SOCKET", "").strip()
    if configured:
        return Path(configured).expanduser()
    return owner_socket_path()


def owner_socket_path(instance: str | None = None) -> Path:
    """The caller's own ``$XDG_RUNTIME_DIR/tether/<instance>/control.sock`` (``$TETHER_INSTANCE`` by default)."""
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    instance = instance or os.environ.get("TETHER_INSTANCE", "").strip() or DEFAULT_INSTANCE
    return Path(runtime_dir) / "tether" / instance / "control.sock"


def agent_socket_path() -> Path:
    """The agent user's instance: ``$TETHER_AGENT_SOCKET``, else :data:`DEFAULT_AGENT_SOCKET`."""
    configured = os.environ.get("TETHER_AGENT_SOCKET", "").strip()
    return Path(configured or DEFAULT_AGENT_SOCKET).expanduser()


def known_socket_paths() -> list[str]:
    """Instances to consult: the active one first, then the other known one.

    A ``TETHER_SOCKET`` pinned to some third path means exactly that socket.
    """
    active = str(default_socket_path())
    known = [str(owner_socket_path()), str(agent_socket_path())]
    if active not in known:
        return [active]
    return [active, *(path for path in dict.fromkeys(known) if path != active)]


class _UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: str, timeout: float | None) -> None:
        super().__init__("tether", timeout=timeout)
        self._socket_path = socket_path

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.settimeout(self.timeout)
            sock.connect(self._socket_path)
        except OSError:
            sock.close()
            raise
        self.sock = sock


def _path(*segments: str) -> str:
    return "/" + "/".join(quote(segment, safe="") for segment in segments)


def _with_query(path: str, query: dict[str, Any] | None) -> str:
    if not query:
        return path
    clean = {key: value for key, value in query.items() if value is not None}
    return f"{path}?{urlencode(clean)}" if clean else path


class TetherClient:
    """One Tether instance. Each call opens its own short connection."""

    def __init__(
        self,
        socket_path: str | os.PathLike[str] | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self.socket_path = str(socket_path or default_socket_path())
        self.timeout = timeout

    # ------------------------------------------------------------------
    # Transport
    # ------------------------------------------------------------------
    def raw(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        timeout: float | None = None,
    ) -> TetherResponse:
        """Send one request and return the status and decoded body, whatever the status."""
        connection = _UnixHTTPConnection(self.socket_path, timeout or self.timeout)
        payload = None if body is None else json.dumps(body).encode()
        headers = {"accept": "application/json"}
        if payload is not None:
            headers["content-type"] = "application/json"
        try:
            try:
                connection.request(method, path, body=payload, headers=headers)
            except (FileNotFoundError, ConnectionRefusedError, PermissionError) as error:
                raise TetherUnavailable(f"{self.socket_path}: {error}") from error
            except OSError as error:
                raise TetherUnavailable(f"{self.socket_path}: {error}") from error
            try:
                response = connection.getresponse()
                data = response.read()
            except (OSError, http.client.HTTPException) as error:
                # The request was sent: the outcome of a mutation is unknown.
                raise TetherError(0, "outcome_uncertain", {"detail": str(error)}) from error
        finally:
            connection.close()
        decoded: Any = None
        if data:
            try:
                decoded = json.loads(data)
            except ValueError:
                decoded = data.decode("utf-8", "replace")
        return TetherResponse(response.status, decoded)

    def call(self, method: str, path: str, body: Any = None) -> Any:
        """Send one request; raise :class:`TetherError` for any non-2xx status."""
        response = self.raw(method, path, body)
        if 200 <= response.status < 300:
            return response.body
        code = "error"
        if isinstance(response.body, dict) and isinstance(response.body.get("error"), str):
            code = response.body["error"]
        raise TetherError(response.status, code, response.body)

    # ------------------------------------------------------------------
    # Health and version
    # ------------------------------------------------------------------
    def health(self) -> dict[str, Any]:
        return self.call("GET", "/v1/health")

    def version(self) -> dict[str, Any]:
        return self.call("GET", "/v1/version")

    def require_api_version(self, minimum: int = MIN_API_VERSION) -> dict[str, Any]:
        info = self.version()
        api_version = info.get("apiVersion") if isinstance(info, dict) else None
        if not isinstance(api_version, int) or api_version < minimum:
            raise TetherVersionError(
                f"Tether apiVersion {api_version!r} is older than the required {minimum}"
            )
        return info

    # ------------------------------------------------------------------
    # Sessions
    # ------------------------------------------------------------------
    def list_sessions(
        self,
        *,
        project: str | None = None,
        origin: str | None = None,
        tool: str | None = None,
    ) -> list[dict[str, Any]]:
        query = {"project": project, "origin": origin, "tool": tool}
        body = self.call("GET", _with_query("/v1/sessions", query))
        items = body.get("items") if isinstance(body, dict) else None
        return [item for item in items or [] if isinstance(item, dict)]

    def live_session_ids(self) -> set[str]:
        """Ids of the sessions Tether lists; raises :class:`TetherUnavailable` when it is down."""
        return {str(item["id"]) for item in self.list_sessions() if item.get("id")}

    def get_session(self, session_id: str) -> dict[str, Any]:
        return self.call("GET", _path("v1", "sessions", session_id))

    def create_session(
        self,
        *,
        origin: str,
        cols: int,
        rows: int,
        tool: str | None = None,
        project_id: str | None = None,
        project_root: str | None = None,
        name: str | None = None,
        a_term_session_id: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"origin": origin, "size": {"cols": cols, "rows": rows}}
        for key, value in (
            ("tool", tool),
            ("projectId", project_id),
            ("projectRoot", project_root),
            ("name", name),
            ("aTermSessionId", a_term_session_id),
        ):
            if value is not None:
                body[key] = value
        return self.call("POST", "/v1/sessions", body)

    def rename_session(self, session_id: str, generation: str, name: str | None) -> dict[str, Any]:
        return self.call(
            "PATCH", _path("v1", "sessions", session_id), {"generation": generation, "name": name}
        )

    def end_session(self, session_id: str, generation: str) -> dict[str, Any]:
        return self.call("POST", _path("v1", "sessions", session_id, "end"), {"generation": generation})

    def respawn_session(self, session_id: str, generation: str) -> dict[str, Any]:
        return self.call(
            "POST", _path("v1", "sessions", session_id, "respawn"), {"generation": generation}
        )

    def load_tui(self, session_id: str, generation: str, tool: str) -> dict[str, Any]:
        return self.call(
            "POST",
            _path("v1", "sessions", session_id, "load-tui"),
            {"generation": generation, "tool": tool},
        )

    def switch_project(self, session_id: str, generation: str, project_id: str) -> dict[str, Any]:
        return self.call(
            "POST",
            _path("v1", "sessions", session_id, "switch-project"),
            {"generation": generation, "projectId": project_id},
        )

    def attach_target(self, session_id: str) -> dict[str, Any]:
        return self.call("GET", _path("v1", "sessions", session_id, "attach"))

    def capture(self, session_id: str, *, escapes: bool = False) -> dict[str, Any]:
        path = _with_query(_path("v1", "sessions", session_id, "capture"), {"escapes": 1 if escapes else None})
        return self.call("GET", path)

    def inject(
        self,
        session_id: str,
        generation: str,
        text: str,
        *,
        mode: str = "paste",
        submit: bool = False,
    ) -> dict[str, Any]:
        return self.call(
            "POST",
            _path("v1", "sessions", session_id, "inject"),
            {"generation": generation, "text": text, "mode": mode, "submit": submit},
        )

    def resize_claim(
        self, session_id: str, generation: str, client_pid: int, cols: int, rows: int
    ) -> dict[str, Any]:
        return self.call(
            "POST",
            _path("v1", "sessions", session_id, "resize-claim"),
            {"generation": generation, "clientPid": client_pid, "cols": cols, "rows": rows},
        )

    # ------------------------------------------------------------------
    # Memory policy (agent-pane cap and runaway job kills; Tether owns it)
    # ------------------------------------------------------------------
    def get_memory_policy(self) -> dict[str, Any]:
        return self.call("GET", "/v1/memory-policy")

    def update_memory_policy(self, fields: dict[str, Any]) -> dict[str, Any]:
        return self.call("PUT", "/v1/memory-policy", fields)

    # ------------------------------------------------------------------
    # Agent tools
    # ------------------------------------------------------------------
    def list_tools(self, *, enabled_only: bool = False) -> dict[str, Any]:
        return self.call("GET", _with_query("/v1/tools", {"enabled": 1 if enabled_only else None}))

    def get_tool(self, ref: str) -> dict[str, Any]:
        return self.call("GET", _path("v1", "tools", ref))

    def create_tool(self, fields: dict[str, Any]) -> dict[str, Any]:
        return self.call("POST", "/v1/tools", fields)

    def update_tool(self, ref: str, fields: dict[str, Any]) -> dict[str, Any]:
        return self.call("PATCH", _path("v1", "tools", ref), fields)

    def delete_tool(self, ref: str) -> dict[str, Any]:
        return self.call("DELETE", _path("v1", "tools", ref))

    def import_tools(
        self, tools: list[dict[str, Any]], *, dry_run: bool = False, update_existing: bool = False
    ) -> dict[str, Any]:
        """``POST /v1/tools/import``: one transaction; an invalid entry rejects the whole batch."""
        return self.call(
            "POST",
            "/v1/tools/import",
            {"tools": tools, "dryRun": dry_run, "updateExisting": update_existing},
        )

    # ------------------------------------------------------------------
    # Projects
    # ------------------------------------------------------------------
    def list_projects(self, *, refresh: bool = False) -> dict[str, Any]:
        return self.call("GET", _with_query("/v1/projects", {"refresh": 1 if refresh else None}))

    def register_project(self, project_id: str, root: str, name: str | None = None) -> dict[str, Any]:
        """``POST /v1/projects``: local source only (``409 projects_managed_by_summitflow`` otherwise)."""
        body: dict[str, Any] = {"id": project_id, "root": root}
        if name is not None:
            body["name"] = name
        return self.call("POST", "/v1/projects", body)

    # ------------------------------------------------------------------
    # Events
    # ------------------------------------------------------------------
    def events(self, *, since: int | None = None, boot_id: str | None = None) -> Iterator[dict[str, Any]]:
        """Yield NDJSON events until the stream closes.

        Raises :class:`TetherUnavailable` if the socket cannot be reached and
        ``TimeoutError`` if no line (not even a heartbeat) arrives in time.
        """
        query: dict[str, Any] = {}
        if since is not None and boot_id:
            query = {"since": since, "bootId": boot_id}
        connection = _UnixHTTPConnection(self.socket_path, EVENT_READ_TIMEOUT_SECONDS)
        try:
            try:
                connection.request("GET", _with_query("/v1/events", query), headers={"accept": "application/x-ndjson"})
                response = connection.getresponse()
            except OSError as error:
                raise TetherUnavailable(f"{self.socket_path}: {error}") from error
            if response.status != 200:
                raise TetherError(response.status, "events_unavailable")
            while True:
                line = response.readline()
                if not line:
                    return
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if isinstance(event, dict):
                    yield event
        finally:
            connection.close()


# Sockets that have answered in this process: one that later goes missing is an
# outage, not "every session on it ended".
_seen: set[str] = set()


def _socket_exists(path: str) -> bool:
    try:
        return stat.S_ISSOCK(os.stat(path).st_mode)
    except OSError:
        return False


class TetherPool(TetherClient):
    """The active instance plus the other known one, behind the one-client API.

    New sessions, tools, projects and roots go to the active instance. Lists
    merge both. A call about one session or root asks the active instance
    first and falls back to the other on 404, so each session is handled by
    the instance that owns it. The other instance counts only while its socket
    exists (or answered earlier in this process).
    """

    def __init__(self, sockets: list[str], timeout: float = DEFAULT_TIMEOUT_SECONDS) -> None:
        super().__init__(sockets[0], timeout)
        self.clients = [TetherClient(path, timeout) for path in sockets]

    def _candidates(self) -> list[TetherClient]:
        """The active instance (always), then the others that exist."""
        others = (c for c in self.clients[1:] if c.socket_path in _seen or _socket_exists(c.socket_path))
        return [self.clients[0], *others]

    def _fan_out(self, fetch: Callable[[TetherClient], Any], *, strict: bool) -> list[Any]:
        """``fetch(client)`` on every candidate. The active instance's failure raises; another's only when ``strict``."""
        results = []
        for index, client in enumerate(self._candidates()):
            try:
                results.append(fetch(client))
            except (TetherUnavailable, TetherError):
                if index == 0 or strict:
                    raise
            else:
                _seen.add(client.socket_path)
        return results

    @staticmethod
    def _merged(groups: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
        merged: dict[Any, dict[str, Any]] = {}
        for group in groups:
            for item in group:
                merged.setdefault(item.get("id"), item)
        return list(merged.values())

    def list_sessions(
        self, *, project: str | None = None, origin: str | None = None, tool: str | None = None
    ) -> list[dict[str, Any]]:
        groups = self._fan_out(
            lambda client: client.list_sessions(project=project, origin=origin, tool=tool), strict=False
        )
        return self._merged(groups)

    def live_session_ids(self) -> set[str]:
        """Ids on every instance; an unreachable instance raises (never "its sessions ended")."""
        groups = self._fan_out(lambda client: client.list_sessions(), strict=True)
        return {str(item["id"]) for group in groups for item in group if item.get("id")}

    def raw(self, method: str, path: str, body: Any = None, *, timeout: float | None = None) -> TetherResponse:
        route = path.split("?", 1)[0].rstrip("/")
        if route == "/v1/roots" and method == "GET":
            return self._merged_roots(method, path, body, timeout)
        if not route.startswith(("/v1/sessions/", "/v1/roots/")):
            return self.clients[0].raw(method, path, body, timeout=timeout)
        first_missing: TetherResponse | None = None
        unavailable: TetherUnavailable | None = None
        for client in self._candidates():
            try:
                response = client.raw(method, path, body, timeout=timeout)
            except TetherUnavailable as error:
                unavailable = unavailable or error
                continue
            _seen.add(client.socket_path)
            if response.status != 404:
                return response
            first_missing = first_missing or response
        if unavailable is not None:
            raise unavailable  # the other instance may still own it: not "gone"
        assert first_missing is not None
        return first_missing

    def _merged_roots(self, method: str, path: str, body: Any, timeout: float | None) -> TetherResponse:
        responses = self._fan_out(lambda client: client.raw(method, path, body, timeout=timeout), strict=False)
        first = responses[0]
        if first.status != 200 or not isinstance(first.body, dict):
            return first
        roots: dict[Any, Any] = {}
        for response in responses:
            items = response.body.get("roots") if response.status == 200 and isinstance(response.body, dict) else None
            for position, root in enumerate(items or []):
                key = root.get("requestId") or root.get("id") if isinstance(root, dict) else None
                roots.setdefault(key or (id(response), position), root)
        return TetherResponse(200, {**first.body, "roots": list(roots.values())})


_client: TetherClient | None = None


def get_client() -> TetherClient:
    """Process-wide client for the known instances (re-resolved if the env changes)."""
    global _client
    sockets = known_socket_paths()
    current = [c.socket_path for c in _client.clients] if isinstance(_client, TetherPool) else None
    if _client is None or _client.socket_path != sockets[0] or (current is not None and current != sockets):
        _client = TetherPool(sockets)
    return _client


def set_client(client: TetherClient | None) -> None:
    """Install a client (tests point this at a fake Tether)."""
    global _client
    _client = client
