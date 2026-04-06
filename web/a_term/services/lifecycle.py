"""A-Term session lifecycle management.

All lifecycle operations in one module:
- Core: atomic create/delete, resurrection, ensure-alive
- Batch: reset single/project/all, disable project
- Reconciliation: startup DB↔tmux sync
"""

from __future__ import annotations

from typing import Any

from ..constants import SHELL_MODE
from ..logging_config import get_logger
from ..storage import agent_tools as agent_tools_store
from ..storage import project_settings as settings_store
from ..storage import sessions as a_term_store
from ..utils.tmux import (
    TmuxError,
    create_tmux_session,
    get_tmux_session_name,
    list_tmux_sessions,
    run_tmux_command,
    tmux_session_exists,
)

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Low-level helpers
# ---------------------------------------------------------------------------
def kill_tmux_session(session_id: str, ignore_missing: bool = True) -> bool:
    """Kill a tmux session. Returns True if killed, False if not found."""
    session_name = get_tmux_session_name(session_id)
    success, error = run_tmux_command(["kill-session", "-t", session_name])

    if not success:
        if ignore_missing and "session not found" in error.lower():
            logger.info("tmux_session_not_found", session=session_name)
            return False
        if not ignore_missing:
            raise TmuxError(f"Failed to kill tmux session: {error}")
        return False

    logger.info("tmux_session_killed", session=session_name)
    return True


def _resurrect_session_record(
    session_id: str,
    project_id: str | None,
    name: str,
    working_dir: str | None,
    mode: str,
) -> None:
    """Update DB record and create tmux session for resurrection."""
    logger.info("resurrecting_dead_session", session_id=session_id, project_id=project_id, mode=mode)
    a_term_store.update_session(session_id, name=name, working_dir=working_dir, is_alive=True)
    try:
        create_tmux_session(session_id, working_dir)
    except TmuxError as e:
        logger.error("tmux_create_failed_rolling_back_resurrection", session_id=session_id, error=str(e))
        a_term_store.mark_dead(session_id)
        raise
    logger.info("session_resurrected", session_id=session_id, name=name, project_id=project_id, mode=mode)


def _claim_and_resurrect(
    project_id: str, mode: str, name: str, working_dir: str | None,
) -> str | None:
    """Atomically claim a dead session and resurrect it. Returns session ID or None."""
    claimed = a_term_store.claim_dead_session_by_project(project_id, mode)
    if not claimed:
        return None
    session_id: str = claimed["id"]
    _resurrect_session_record(session_id, project_id, name, working_dir, mode)
    return session_id


def _try_resurrect_tmux(session_id: str, working_dir: str | None) -> bool:
    """Attempt to recreate a dead tmux session. Returns True on success."""
    logger.info("session_resurrection_attempt", session_id=session_id)
    try:
        create_tmux_session(session_id, working_dir)
        a_term_store.update_session(session_id, is_alive=True)
        logger.info("session_resurrected", session_id=session_id)
        return True
    except TmuxError as e:
        logger.error("tmux_create_failed_rolling_back_ensure_alive", session_id=session_id, error=str(e))
        a_term_store.mark_dead(session_id)
        return False


# ---------------------------------------------------------------------------
# Core single-session operations
# ---------------------------------------------------------------------------
def create_session(
    name: str,
    project_id: str | None = None,
    working_dir: str | None = None,
    user_id: str | None = None,
    mode: str = "shell",
    pane_id: str | None = None,
) -> str:
    """Create a new a_term session atomically (DB + tmux, rollback on failure).

    If a dead session exists for the same project_id+mode, resurrects it instead.
    """
    if project_id:
        resurrected = _claim_and_resurrect(project_id, mode, name, working_dir)
        if resurrected:
            return resurrected

    session_id = a_term_store.create_session(
        name=name, project_id=project_id, working_dir=working_dir,
        user_id=user_id, mode=mode, pane_id=pane_id,
    )
    try:
        create_tmux_session(session_id, working_dir)
    except TmuxError as e:
        logger.error("tmux_create_failed_rolling_back_new_session", session_id=session_id, error=str(e))
        a_term_store.delete_session(session_id)
        raise

    logger.info("session_created", session_id=session_id, name=name, project_id=project_id, mode=mode)
    return session_id


def delete_session(session_id: str) -> bool:
    """Delete a a_term session atomically. Idempotent."""
    kill_tmux_session(session_id, ignore_missing=True)
    deleted = a_term_store.delete_session(session_id)
    if deleted:
        logger.info("session_deleted", session_id=session_id)
    else:
        logger.info("session_not_found_for_delete", session_id=session_id)
    return True


def ensure_session_alive(session_id: str) -> bool:
    """Ensure a session is alive, recreating tmux if necessary. Called on WS connect."""
    session = a_term_store.get_session(session_id)
    if not session:
        logger.warning("ensure_alive_no_db_record", session_id=session_id)
        return False

    if tmux_session_exists(session_id):
        if not session["is_alive"]:
            a_term_store.update_session(session_id, is_alive=True)
            logger.info("session_marked_alive", session_id=session_id)
        return True

    return _try_resurrect_tmux(session_id, session.get("working_dir"))


# ---------------------------------------------------------------------------
# Batch operations
# ---------------------------------------------------------------------------
def reset_session(session_id: str) -> str | None:
    """Delete and recreate a session with the same parameters. Returns new ID or None."""
    session = a_term_store.get_session(session_id)
    if not session:
        logger.warning("reset_session_not_found", session_id=session_id)
        return None

    delete_session(session_id)
    new_session_id = create_session(
        name=session["name"],
        project_id=session.get("project_id"),
        working_dir=session.get("working_dir"),
        user_id=session.get("user_id"),
        mode=session.get("mode", "shell"),
        pane_id=session.get("pane_id"),
    )
    logger.info(
        "session_reset", old_session_id=session_id, new_session_id=new_session_id,
        project_id=session.get("project_id"), mode=session.get("mode", "shell"),
        pane_id=session.get("pane_id"),
    )
    return new_session_id


def reset_project_sessions(
    project_id: str, working_dir: str | None = None
) -> dict[str, str | None]:
    """Reset all sessions for a project, deleting orphans and recreating fresh ones."""
    all_sessions = a_term_store.get_all_project_sessions(project_id)

    # Collect per-mode metadata before deleting
    session_info: dict[str, dict[str, Any]] = {}
    for session in all_sessions:
        mode = session.get("mode", "shell")
        if mode not in session_info:
            session_info[mode] = {
                "working_dir": session.get("working_dir"),
                "name": session.get("name"),
                "user_id": session.get("user_id"),
            }

    # Delete all
    for session in all_sessions:
        delete_session(session["id"])
    if len(all_sessions) > 2:
        logger.warning("excess_sessions_cleaned", project_id=project_id, deleted_count=len(all_sessions))

    # Recreate
    default_tool = agent_tools_store.get_default()
    agent_slug = default_tool["slug"] if default_tool else "claude"
    modes = [SHELL_MODE, agent_slug]

    result: dict[str, str | None] = {SHELL_MODE: None, agent_slug: None}
    for mode in modes:
        info = session_info.get(mode, {})
        new_id = create_session(
            name=info.get("name") or f"Project: {project_id} ({mode.title()})",
            project_id=project_id,
            working_dir=working_dir or info.get("working_dir"),
            user_id=info.get("user_id"),
            mode=mode,
        )
        logger.info("session_reset", new_session_id=new_id, project_id=project_id, mode=mode)
        result[mode] = new_id

    agent_session = next((v for k, v in result.items() if k != SHELL_MODE), None)
    logger.info(
        "project_sessions_reset", project_id=project_id,
        shell_session=result.get(SHELL_MODE), agent_session=agent_session,
        cleaned_orphans=max(0, len(all_sessions) - 2),
    )
    return result


def reset_all_sessions() -> int:
    """Reset all a_term sessions globally. Returns count reset."""
    sessions = a_term_store.list_sessions()
    count = sum(1 for session in sessions if reset_session(session["id"]))
    logger.info("all_sessions_reset", count=count)
    return count


def disable_project_a_term(project_id: str) -> bool:
    """Delete all project sessions and mark the project a_term as disabled."""
    all_sessions = a_term_store.get_all_project_sessions(project_id)
    for session in all_sessions:
        delete_session(session["id"])
    settings_store.upsert_settings(project_id, enabled=False)
    logger.info("project_a_term_disabled", project_id=project_id, deleted_sessions=len(all_sessions))
    return True


# ---------------------------------------------------------------------------
# Startup reconciliation
# ---------------------------------------------------------------------------
def _kill_orphan_tmux_sessions(db_session_ids: set[str]) -> int:
    """Kill tmux sessions that have no matching DB record."""
    tmux_sessions = list_tmux_sessions()
    orphans = tmux_sessions - db_session_ids
    killed = 0
    for session_id in orphans:
        session_name = get_tmux_session_name(session_id)
        success, error = run_tmux_command(["kill-session", "-t", session_name])
        if success:
            killed += 1
            logger.info("orphan_tmux_killed", session_id=session_id)
        else:
            logger.warning("orphan_tmux_kill_failed", session_id=session_id, error=error)
    return killed


def reconcile_sessions(purge_after_days: int = 7) -> dict[str, int]:
    """Reconcile DB with tmux state on server startup."""
    logger.info("reconciliation_starting")

    db_sessions = a_term_store.list_sessions(include_dead=True)
    tmux_sessions = list_tmux_sessions()

    stats: dict[str, int] = {
        "total_db_sessions": len(db_sessions),
        "total_tmux_sessions": len(tmux_sessions),
        "marked_alive": 0,
        "marked_dead": 0,
    }

    # Sync DB sessions against live tmux
    for session in db_sessions:
        session_id = session["id"]
        if session_id in tmux_sessions:
            if not session["is_alive"]:
                a_term_store.update_session(session_id, is_alive=True)
                stats["marked_alive"] += 1
                logger.info("reconcile_marked_alive", session_id=session_id)
        else:
            if session["is_alive"]:
                a_term_store.mark_dead(session_id)
                stats["marked_dead"] += 1
                logger.info("reconcile_marked_dead", session_id=session_id)

    # Purge old dead sessions
    purged = a_term_store.purge_dead_sessions(
        older_than_days=purge_after_days, exclude_session_ids=tmux_sessions,
    )
    if purged > 0:
        logger.info("reconcile_purged_dead_sessions", count=purged)

    # Kill orphan tmux sessions
    remaining_ids = {s["id"] for s in a_term_store.list_sessions(include_dead=True)}
    orphans_killed = _kill_orphan_tmux_sessions(remaining_ids)
    if orphans_killed > 0:
        logger.info("reconcile_orphans_killed", count=orphans_killed)

    stats["purged"] = purged
    stats["orphans_killed"] = orphans_killed
    logger.info("reconciliation_complete", **stats)
    return stats
