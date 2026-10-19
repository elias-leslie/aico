"""Follow Tether's event stream to keep pane links current.

When a session ends, A-Term drops its pane link. ``session.created`` and
``session.updated`` carry the session's descriptor, which keeps a linked pane's
mode on the session's tool (an older Tether sends no descriptor, so A-Term
reads it). A ``gap`` (missed events or a daemon restart) means
A-Term re-lists and reconciles. One watcher per known instance (the owner's
and the agent's) runs in its own daemon thread and reconnects with backoff
while its Tether is away; reconciling reads every instance, so a link to a
session on the other instance is never dropped for being absent from one.
"""

from __future__ import annotations

import threading
from typing import Any

from ..logging_config import get_logger
from ..storage import panes as pane_store
from ..tether import TetherClient, TetherError, TetherUnavailable, get_client, known_socket_paths
from ..tether.client import agent_socket_path
from . import lifecycle, shows

logger = get_logger(__name__)

_MAX_BACKOFF_SECONDS = 30.0


class TetherEventWatcher:
    """Background consumer of ``GET /v1/events``."""

    def __init__(self, socket_path: str | None = None) -> None:
        self._socket_path = socket_path
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._seq: int | None = None
        self._boot_id: str | None = None

    def _events_client(self) -> TetherClient:
        return TetherClient(self._socket_path) if self._socket_path else get_client()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name=f"tether-events-{self._socket_path or 'active'}", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _reconcile(self, reason: str) -> None:
        try:
            stats = lifecycle.reconcile_links()
            logger.info("tether_events_reconciled", reason=reason, **stats)
        except (TetherError, TetherUnavailable) as error:
            logger.info("tether_events_reconcile_skipped", reason=reason, error=str(error))
        except Exception as error:  # never let the watcher die on one bad pass
            logger.warning("tether_events_reconcile_failed", reason=reason, error=str(error))

    def _apply_session(self, data: dict[str, Any], event_type: str) -> None:
        """Keep a linked pane in step with the session's descriptor."""
        session_id = data.get("id")
        if not isinstance(session_id, str):
            return
        link = pane_store.get_link(session_id)
        if link is None or link["kind"] != "tether":
            return
        snapshot = data.get("session")
        if not isinstance(snapshot, dict) or snapshot.get("id") != session_id:
            try:
                snapshot = get_client().get_session(session_id)
            except TetherError as error:
                if error.status in {404, 410}:
                    pane_store.unlink_session(session_id)
                    logger.info("view_link_dropped", session_id=session_id, reason=error.code)
                return
            except TetherUnavailable:
                return
            if not isinstance(snapshot, dict):
                return
        if snapshot.get("status") == "ended":
            pane_store.unlink_session(session_id)
            logger.info("view_link_dropped", session_id=session_id, reason=event_type)
            return
        tool = snapshot.get("tool")
        if isinstance(tool, str) and tool and tool != link["mode"]:
            pane_store.update_link(session_id, mode=tool)
            logger.info("view_link_mode_updated", session_id=session_id, mode=tool)

    def handle(self, event: dict[str, Any]) -> None:
        """Apply one event (public for tests)."""
        event_type = event.get("type")
        seq = event.get("seq")
        boot_id = event.get("bootId")
        if isinstance(boot_id, str):
            if self._boot_id is not None and boot_id != self._boot_id:
                self._seq = None
            self._boot_id = boot_id
        if isinstance(seq, int):
            self._seq = seq
        raw_data = event.get("data")
        data: dict[str, Any] = raw_data if isinstance(raw_data, dict) else {}
        if event_type == "show.requested":
            if self._socket_path == str(agent_socket_path()):
                shows.receive_show(data)
        elif event_type == "session.ended":
            session_id = data.get("id")
            if isinstance(session_id, str) and pane_store.unlink_session(session_id):
                logger.info("view_link_dropped", session_id=session_id, reason="session.ended")
        elif event_type in {"session.created", "session.updated"}:
            self._apply_session(data, event_type)
        elif event_type == "gap":
            self._reconcile("gap")

    def _run(self) -> None:
        backoff = 1.0
        while not self._stop.is_set():
            resuming = self._seq is not None and self._boot_id is not None
            try:
                stream = self._events_client().events(
                    since=self._seq if resuming else None, boot_id=self._boot_id if resuming else None
                )
                if not resuming:
                    # A fresh stream has no replay: catch up on what ended meanwhile.
                    self._reconcile("connect")
                for event in stream:
                    backoff = 1.0
                    if self._stop.is_set():
                        return
                    self.handle(event)
            except (TetherUnavailable, TetherError, TimeoutError, OSError) as error:
                logger.debug("tether_events_disconnected", error=str(error))
            except Exception as error:
                logger.warning("tether_events_failed", error=str(error))
            self._stop.wait(backoff)
            backoff = min(backoff * 2, _MAX_BACKOFF_SECONDS)


_watchers: dict[str, TetherEventWatcher] = {}


def start_watcher() -> None:
    for path in known_socket_paths():
        _watchers.setdefault(path, TetherEventWatcher(path)).start()


def stop_watcher() -> None:
    for watcher in _watchers.values():
        watcher.stop()
