"""Own tmux sessions: the user's own default-server sessions running an agent.

A-Term discovers and shows them, but Tether does not own them, so A-Term
never renames, respawns or ends them; closing one only closes the View. They
attach on the default tmux server. The wire keeps ``source: "tmux_external"``.

Which commands count as an agent comes from ``tool_tokens``: command token ->
canonical tool slug, read from Tether's ``/v1/tools`` by default (see
:func:`a_term.services.agent_tools.agent_tokens`), so a session's mode is the
same slug A-Term launches that tool with.
"""

from __future__ import annotations

import re
import subprocess
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ...constants import SHELL_MODE
from ...logging_config import get_logger
from ...utils import tmux
from .. import agent_tools
from ..session_capabilities import SessionFacts, SessionKind, refusal
from . import AttachPlan, ListContext, SessionList, finish
from .tmux_panes import read_panes

if TYPE_CHECKING:
    from ..session_catalog import Session

logger = get_logger(__name__)

SHELL_COMMANDS = frozenset({"bash", "sh", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "login", "su"})
# An agent started from a non-job-control shell shares the shell's process
# group, so tmux reports the shell as ``pane_current_command``. Walk a bounded
# slice of the pane's process tree to recover the real agent command.
_PANE_PROCESS_SCAN_DEPTH = 3
_PANE_PROCESS_SCAN_LIMIT = 24

# The user's default tmux server: the only server Own tmux sessions come from.
TMUX_SOURCE = "default"
TMUX_SOURCE_LABEL = "tmux"


def _match_agent_slug(label: str, tokens: Mapping[str, str]) -> str | None:
    """Return the slug of the agent token named by ``label``, or None. Longer tokens win."""
    lowered = label.lower()
    for token in sorted(tokens, key=lambda item: (-len(item), item)):
        if re.search(rf"(^|[^a-z0-9]){re.escape(token)}([^a-z0-9]|$)", lowered):
            return tokens[token]
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


def _infer_project_id(working_dir: str | None) -> str | None:
    """The project a working directory belongs to: its git toplevel's name."""
    if not working_dir:
        return None
    try:
        root = subprocess.run(
            ["git", "-C", working_dir, "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            timeout=tmux.TMUX_COMMAND_TIMEOUT,
            check=False,
        ).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return None
    if not root:
        return None
    return Path(root).name


def _is_own_session_name(session_name: str) -> bool:
    """A tmux name A-Term can attach to safely."""
    return bool(session_name) and tmux.validate_session_name(session_name)


class OwnTmuxSource:
    """Discovery of Own tmux sessions from the default server's panes."""

    kind: SessionKind = "tmux_external"

    def __init__(
        self,
        tool_tokens: Callable[[], Mapping[str, str]] = agent_tools.agent_tokens,
        project_of: Callable[[str | None], str | None] | None = None,
    ) -> None:
        self._tool_tokens = tool_tokens
        self._project_of = project_of

    def owns(self, ref: str) -> bool:
        """The fallback: any id that is not a Tether id."""
        return True

    def infer_mode(self, session_name: str, current_command: str, pane_pid: str | None = None) -> tuple[str, str]:
        """Classify a default-server pane as an agent mode or a plain shell: ``(mode, agent_state)``."""
        tokens = self._tool_tokens()
        slug = _match_agent_slug(f"{session_name} {current_command}", tokens)
        if slug:
            return slug, "running"

        # tmux reports the shell when the agent shares its process group, so look
        # for the agent among the pane's descendants before calling it a shell.
        if current_command.lower() in SHELL_COMMANDS and pane_pid and pane_pid.isdigit():
            for label in _pane_descendant_labels(int(pane_pid)):
                slug = _match_agent_slug(label, tokens)
                if slug:
                    return slug, "running"

        return SHELL_MODE, "not_started"

    def _project(self, working_dir: str | None) -> str | None:
        return (self._project_of or _infer_project_id)(working_dir)

    def list(self, ctx: ListContext) -> SessionList:
        """Every Own tmux session running an agent, sorted by name."""
        rows: dict[str, dict[str, Any]] = {}
        for pane in ctx.panes():
            session_name = pane.session_name
            if not _is_own_session_name(session_name):
                continue
            mode, agent_state = self.infer_mode(session_name, pane.command, pane.pid)
            if mode == SHELL_MODE:
                continue
            project_id = self._project(pane.cwd or None)
            existing = rows.get(session_name)
            if existing and existing.get("working_dir"):
                continue
            rows[session_name] = {
                "id": session_name,
                "name": session_name,
                "user_id": None,
                "project_id": project_id,
                "working_dir": pane.cwd or None,
                "display_order": 0,
                "mode": mode,
                "session_number": 0,
                "is_alive": True,
                "created_at": None,
                "last_accessed_at": None,
                "agent_state": agent_state,
                "tmux_session_name": session_name,
                "tmux_session_id": pane.session_id or None,
                "tmux_pane_id": pane.pane_id or None,
                "tmux_socket": None,
                "tmux_source": TMUX_SOURCE,
                "tmux_source_label": TMUX_SOURCE_LABEL,
                "is_external": True,
                "source": "tmux_external",
                # Tether and A-Term facts an Own tmux session never has, written
                # explicitly so every Session key is present.
                "is_root": False,
                "is_legacy": False,
                "origin": None,
                "status": None,
                "generation": None,
                "pane_id": None,
                "activity": "unknown",
                "activity_previous": "unknown",
                "activity_at": None,
                "activity_detail": None,
                "task": None,
                "badge": None,
                "is_coordinator": False,
                "coordinator_id": None,
            }
        return [finish(row) for row in sorted(rows.values(), key=lambda row: str(row.get("name") or ""))]

    def get(self, ref: str, ctx: ListContext) -> Session | None:
        """One Own tmux session by id or tmux session name."""
        for session in self.list(ctx):
            if session["id"] == ref or session["tmux_session_name"] == ref:
                return session
        return None

    def attach_plan(self, ref: str, ctx: ListContext) -> AttachPlan:
        session = self.get(ref, ctx)
        if session is None:
            logger.warning("a_term_session_dead", session_id=ref)
            raise ValueError(f"Session not found: {ref}")
        session_name = str(session.get("tmux_session_name") or "")
        if not tmux.validate_session_name(session_name):
            raise ValueError(f"Invalid tmux session name for {ref}")
        return AttachPlan(
            session=session,
            kind="external",
            tmux_session_name=session_name,
            tmux_socket=None,
            argv=tmux.build_tmux_command(["attach-session", "-t", session_name]),
        )

    def end(self, ref: str) -> bool:
        """Never ends anything: the catalog refuses first. Raises the same 400 if reached."""
        refused = refusal("end", SessionFacts(self.kind))
        if refused is None:  # pragma: no cover - the capability table always refuses it
            raise RuntimeError("Own tmux sessions are never ended by A-Term")
        raise refused.error()

    def live_ids(self) -> set[str]:
        return {session["id"] for session in self.list(ListContext.build({}, read_panes))}
