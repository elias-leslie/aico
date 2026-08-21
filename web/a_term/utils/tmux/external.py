"""External agent session discovery, option management, and attach state."""

from __future__ import annotations

import os
import re
import sqlite3
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from threading import Lock

from ...config import get_settings
from ...logging_config import get_logger
from .core import TMUX_COMMAND_TIMEOUT, validate_socket_name

logger = get_logger(__name__)

_EXTERNAL_AGENT_TOKENS = (
    "claude",
    "codex",
    "opencode",
    "aider",
    "gemini",
    "agy",
    "hermes",
    "pi",
)
_EXTERNAL_SHELL_COMMANDS = frozenset(
    {"bash", "sh", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "login", "su"}
)
# Aico launches its agent as a child of a non-job-control bash, so the agent
# shares the shell's process group and tmux reports the shell as
# ``pane_current_command``. Walk a bounded slice of the pane's process tree to
# recover the real agent command.
_PANE_PROCESS_SCAN_DEPTH = 3
_PANE_PROCESS_SCAN_LIMIT = 24
_AICO_SERVER_ID_PATTERN = re.compile(r"^[0-9a-f]{8,64}$")
_AICO_DB_FILENAME = "aico.db"
_AICO_MANAGED_SOCKET_DIR = "tmux"
_AICO_MANAGED_SOCKET_FILENAME = "server.sock"

_EXTERNAL_ATTACH_LOCK = Lock()
_EXTERNAL_ATTACH_STATES: dict[str, _ExternalAttachState] = {}


@dataclass(frozen=True)
class ExternalTmuxSource:
    """A tmux server that can contribute attachable external sessions."""

    id: str
    label: str
    socket_name: str | None = None
    session_prefix: str | None = None
    include_shell: bool = False

    def external_id(self, session_name: str) -> str:
        if self.socket_name is None:
            return session_name
        return f"tmux:{self.id}:{session_name}"


@dataclass
class _ExternalAttachState:
    refcount: int
    status: str
    mouse: str
    socket_name: str | None = None


_EXTERNAL_TMUX_SOURCES = (
    ExternalTmuxSource(id="default", label="tmux"),
    ExternalTmuxSource(
        id="aico",
        label="Aico",
        socket_name="aico",
        session_prefix="aico-",
        include_shell=True,
    ),
)


def _aico_state_dir() -> Path | None:
    """Return Aico's configured state directory, or fail closed.

    Aico itself accepts ``AICO_STATE_DIR`` and otherwise uses
    ``~/.local/state/aico``. ``A_TERM_AICO_STATE_DIR`` lets the A-Term service
    point at a non-default Aico instance without changing Aico's environment.
    """
    configured = (
        os.environ.get("A_TERM_AICO_STATE_DIR")
        or os.environ.get("AICO_STATE_DIR")
        or get_settings().a_term_aico_state_dir
    )
    state_dir = (
        Path(configured).expanduser()
        if configured
        else Path.home() / ".local" / "state" / "aico"
    )
    if not state_dir.is_absolute():
        logger.debug("aico_tmux_catalog_state_dir_rejected", path=str(state_dir))
        return None
    return state_dir


def _catalogued_aico_tmux_sources() -> tuple[ExternalTmuxSource, ...]:
    """Read active Aico managed-server generations without taking write locks.

    Catalog rows identify candidate sockets; a successful tmux ``list-panes``
    response remains the liveness authority. Rows are accepted only when their
    id and socket path match Aico's generation-owned directory layout.
    """
    state_dir = _aico_state_dir()
    if state_dir is None:
        return ()
    database_path = state_dir / _AICO_DB_FILENAME
    if not database_path.is_file():
        return ()

    connection: sqlite3.Connection | None = None
    try:
        connection = sqlite3.connect(
            f"{database_path.as_uri()}?mode=ro",
            uri=True,
            timeout=0.0,
            isolation_level=None,
        )
        connection.execute("PRAGMA query_only = ON")
        if connection.execute(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'tmux_servers'"
        ).fetchone() is None:
            return ()
        rows = connection.execute(
            """
            SELECT id, socket_path
            FROM tmux_servers
            WHERE kind = 'managed' AND phase = 'active'
            ORDER BY created_at ASC, id ASC
            """
        ).fetchall()
    except (OSError, sqlite3.Error, ValueError) as error:
        # A missing old schema, a concurrent exclusive schema migration, or an
        # unavailable state directory must not break external-session listing.
        logger.debug("aico_tmux_catalog_unavailable", path=str(database_path), error=str(error))
        return ()
    finally:
        if connection is not None:
            connection.close()

    sources: list[ExternalTmuxSource] = []
    for raw_server_id, raw_socket_path in rows:
        if not isinstance(raw_server_id, str) or not _AICO_SERVER_ID_PATTERN.fullmatch(
            raw_server_id
        ):
            logger.debug("aico_tmux_catalog_row_rejected", reason="server_id")
            continue
        if not isinstance(raw_socket_path, str):
            logger.debug(
                "aico_tmux_catalog_row_rejected",
                server=raw_server_id,
                reason="socket_type",
            )
            continue
        expected_socket_path = str(
            state_dir
            / _AICO_MANAGED_SOCKET_DIR
            / raw_server_id
            / _AICO_MANAGED_SOCKET_FILENAME
        )
        if raw_socket_path != expected_socket_path or not validate_socket_name(raw_socket_path):
            logger.debug(
                "aico_tmux_catalog_row_rejected",
                server=raw_server_id,
                reason="socket_path",
            )
            continue
        sources.append(
            ExternalTmuxSource(
                id=f"aico-{raw_server_id}",
                label=f"Aico ({raw_server_id[:8]})",
                socket_name=raw_socket_path,
                session_prefix="aico-",
                include_shell=True,
            )
        )
    return tuple(sources)


def _external_tmux_sources() -> tuple[ExternalTmuxSource, ...]:
    """Return stable legacy sources plus current Aico server generations."""
    return (*_EXTERNAL_TMUX_SOURCES, *_catalogued_aico_tmux_sources())


def _pkg() -> object:
    """Return the a_term.utils.tmux package module (avoids circular import)."""
    return sys.modules["a_term.utils.tmux"]


def _match_agent_token(label: str) -> str | None:
    """Return the agent token named by ``label``, or None."""
    lowered = label.lower()
    for token in _EXTERNAL_AGENT_TOKENS:
        if re.search(rf"(^|[^a-z0-9]){re.escape(token)}([^a-z0-9]|$)", lowered):
            return token
    return None


def _read_proc_text(path: Path) -> str:
    try:
        return path.read_text(errors="replace")
    except OSError:
        return ""


def _pane_descendant_labels(pane_pid: int) -> list[str]:
    """Return command labels for a bounded slice of a pane's process tree.

    Reads ``/proc`` only. A missing or racing process yields no label instead of
    raising, so discovery never fails because a child exited mid-scan.
    """
    labels: list[str] = []
    frontier = [pane_pid]
    seen = {pane_pid}
    for _ in range(_PANE_PROCESS_SCAN_DEPTH):
        if not frontier or len(labels) >= _PANE_PROCESS_SCAN_LIMIT:
            break
        next_frontier: list[int] = []
        for pid in frontier:
            children = _read_proc_text(Path(f"/proc/{pid}/task/{pid}/children"))
            for raw_child in children.split():
                if not raw_child.isdigit():
                    continue
                child_pid = int(raw_child)
                if child_pid in seen:
                    continue
                seen.add(child_pid)
                next_frontier.append(child_pid)
                comm = _read_proc_text(Path(f"/proc/{child_pid}/comm")).strip()
                cmdline = _read_proc_text(Path(f"/proc/{child_pid}/cmdline"))
                argv0 = Path(cmdline.split("\x00", maxsplit=1)[0]).name if cmdline else ""
                label = f"{comm} {argv0}".strip()
                if label:
                    labels.append(label)
                if len(labels) >= _PANE_PROCESS_SCAN_LIMIT:
                    break
            if len(labels) >= _PANE_PROCESS_SCAN_LIMIT:
                break
        frontier = next_frontier
    return labels


def _infer_external_mode(
    session_name: str,
    current_command: str,
    pane_pid: str | None = None,
) -> tuple[str, str]:
    """Classify an external pane as an agent mode or a plain shell."""
    token = _match_agent_token(f"{session_name} {current_command}")
    if token:
        return token, "running"

    # tmux reports the shell when the agent shares its process group, so look
    # for the agent among the pane's descendants before calling it a shell.
    if current_command.lower() in _EXTERNAL_SHELL_COMMANDS and pane_pid and pane_pid.isdigit():
        for label in _pane_descendant_labels(int(pane_pid)):
            token = _match_agent_token(label)
            if token:
                return token, "running"

    return "shell", "not_started"


def _infer_project_id(working_dir: str | None) -> str | None:
    if not working_dir:
        return None
    try:
        root = subprocess.run(
            ["git", "-C", working_dir, "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            timeout=TMUX_COMMAND_TIMEOUT,
            check=False,
        ).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return None
    if not root:
        return None
    return Path(root).name


def _session_matches_source(source: ExternalTmuxSource, session_name: str) -> bool:
    pkg = _pkg()
    if not pkg.validate_session_name(session_name):  # type: ignore[union-attr]
        return False
    if source.session_prefix and not session_name.startswith(source.session_prefix):
        return False
    return not (
        source.socket_name is None
        and pkg.is_managed_tmux_session_name(session_name)  # type: ignore[union-attr]
    )


def list_external_tmux_sessions() -> list[dict[str, object]]:
    """List externally created tmux sessions that A-Term can attach to."""
    pkg = _pkg()
    sessions: dict[str, dict[str, object]] = {}
    for source in _external_tmux_sources():
        list_args = [
            "list-panes",
            "-a",
            "-F",
            "#{session_name}\t#{pane_id}\t#{pane_current_path}\t#{pane_current_command}"
            "\t#{pane_pid}",
        ]
        if source.socket_name:
            success, output = pkg.run_tmux_command(  # type: ignore[union-attr]
                list_args,
                socket_name=source.socket_name,
            )
        else:
            success, output = pkg.run_tmux_command(list_args)  # type: ignore[union-attr]
        if not success:
            continue

        for line in output.splitlines():
            parts = line.split("\t")
            if len(parts) != 5:
                continue
            session_name, pane_id, working_dir, current_command, pane_pid = parts
            if not session_name or not _session_matches_source(source, session_name):
                continue
            mode, agent_state = _infer_external_mode(session_name, current_command, pane_pid)
            if mode == "shell" and not source.include_shell:
                continue
            external_id = source.external_id(session_name)
            existing = sessions.get(external_id)
            if existing and existing.get("working_dir"):
                continue
            sessions[external_id] = {
                "id": external_id,
                "name": session_name,
                "user_id": None,
                "project_id": _infer_project_id(working_dir or None),
                "working_dir": working_dir or None,
                "display_order": 0,
                "mode": mode,
                "session_number": 0,
                "is_alive": True,
                "created_at": None,
                "last_accessed_at": None,
                "agent_state": agent_state,
                "claude_state": agent_state,
                "tmux_session_name": session_name,
                "tmux_pane_id": pane_id or None,
                "tmux_socket": source.socket_name,
                "tmux_source": source.id,
                "tmux_source_label": source.label,
                "is_external": True,
                "source": "tmux_external",
            }
    return sorted(sessions.values(), key=lambda row: str(row.get("name") or ""))


def list_external_agent_tmux_sessions() -> list[dict[str, object]]:
    """Compatibility alias for the original external-session discovery API."""
    return list_external_tmux_sessions()


def get_external_agent_tmux_session(session_ref: str) -> dict[str, object] | None:
    """Return one external tmux agent session by its synthetic id or tmux session name."""
    pkg = _pkg()
    for session in pkg.list_external_agent_tmux_sessions():  # type: ignore[union-attr]
        if session.get("id") == session_ref or session.get("tmux_session_name") == session_ref:
            return session
    return None


def _normalize_tmux_toggle(value: str) -> str | None:
    normalized = value.strip().lower()
    if normalized in {"on", "1", "yes"}:
        return "on"
    if normalized in {"off", "0", "no"}:
        return "off"
    return None


def get_tmux_session_option(
    session_name: str,
    option: str,
    socket_name: str | None = None,
) -> str | None:
    """Return the effective session option value normalized to on/off."""
    pkg = _pkg()
    commands = (
        ["show-options", "-qv", "-t", session_name, option],
        ["show-options", "-gqv", option],
    )
    for args in commands:
        if socket_name:
            success, output = pkg.run_tmux_command(args, socket_name=socket_name)  # type: ignore[union-attr]
        else:
            success, output = pkg.run_tmux_command(args)  # type: ignore[union-attr]
        if not success or not output.strip():
            continue
        normalized = _normalize_tmux_toggle(output)
        if normalized:
            return normalized

    logger.warning(
        "tmux_option_read_failed",
        session=session_name,
        socket=socket_name,
        option=option,
    )
    return None


def set_tmux_session_option(
    session_name: str,
    option: str,
    value: str,
    socket_name: str | None = None,
) -> bool:
    """Set a tmux session option to a normalized on/off value."""
    pkg = _pkg()
    args = ["set-option", "-t", session_name, option, value]
    if socket_name:
        success, _ = pkg.run_tmux_command(args, socket_name=socket_name)  # type: ignore[union-attr]
    else:
        success, _ = pkg.run_tmux_command(args)  # type: ignore[union-attr]
    if success:
        logger.debug("tmux_option_set", session=session_name, option=option, value=value)
    else:
        logger.warning("tmux_option_set_failed", session=session_name, option=option, value=value)
    return success


def apply_external_attach_options(session_name: str, socket_name: str | None = None) -> bool:
    """Normalize external tmux UI while A-Term is attached."""
    pkg = _pkg()
    with _EXTERNAL_ATTACH_LOCK:
        state_key = f"{socket_name or 'default'}:{session_name}"
        existing = _EXTERNAL_ATTACH_STATES.get(state_key)
        if existing:
            existing.refcount += 1
            logger.debug(
                "tmux_external_attach_reused",
                session=session_name,
                socket=socket_name,
                refcount=existing.refcount,
            )
            return True

        status = pkg.get_tmux_session_option(session_name, "status", socket_name)  # type: ignore[union-attr]
        mouse = pkg.get_tmux_session_option(session_name, "mouse", socket_name)  # type: ignore[union-attr]
        if status is None or mouse is None:
            return False

        changed_options: list[tuple[str, str]] = []
        for option, original_value in (("status", status), ("mouse", mouse)):
            if original_value == "off":
                continue
            if not pkg.set_tmux_session_option(session_name, option, "off", socket_name):  # type: ignore[union-attr]
                for changed_option, restore_value in reversed(changed_options):
                    pkg.set_tmux_session_option(session_name, changed_option, restore_value, socket_name)  # type: ignore[union-attr]
                return False
            changed_options.append((option, original_value))

        _EXTERNAL_ATTACH_STATES[state_key] = _ExternalAttachState(
            refcount=1,
            status=status,
            mouse=mouse,
            socket_name=socket_name,
        )
        logger.debug(
            "tmux_external_attach_applied",
            session=session_name,
            socket=socket_name,
            status=status,
            mouse=mouse,
        )
        return True


def restore_external_attach_options(session_name: str, socket_name: str | None = None) -> bool:
    """Restore external tmux UI after the last A-Term attachment ends."""
    pkg = _pkg()
    with _EXTERNAL_ATTACH_LOCK:
        state_key = f"{socket_name or 'default'}:{session_name}"
        existing = _EXTERNAL_ATTACH_STATES.get(state_key)
        if not existing:
            return True

        if existing.refcount > 1:
            existing.refcount -= 1
            logger.debug(
                "tmux_external_attach_released",
                session=session_name,
                socket=socket_name,
                refcount=existing.refcount,
            )
            return True

        success = True
        for option, original_value in (("mouse", existing.mouse), ("status", existing.status)):
            if original_value == "off":
                continue
            success = pkg.set_tmux_session_option(  # type: ignore[union-attr]
                session_name, option, original_value, socket_name
            ) and success

        _EXTERNAL_ATTACH_STATES.pop(state_key, None)
        if success:
            logger.debug("tmux_external_attach_restored", session=session_name, socket=socket_name)
        else:
            logger.warning(
                "tmux_external_attach_restore_failed",
                session=session_name,
                socket=socket_name,
            )
        return success
