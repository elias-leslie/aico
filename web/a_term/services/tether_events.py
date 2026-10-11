"""Follow Tether's event stream to keep pane links current.

When a session ends, A-Term drops its pane link. A ``gap`` (missed events or a
daemon restart) means A-Term re-lists and reconciles. The watcher runs in one
daemon thread and reconnects with backoff while Tether is away.
"""

from __future__ import annotations

import threading
from typing import Any

from ..logging_config import get_logger
from ..storage import panes as pane_store
from ..tether import TetherError, TetherUnavailable, get_client
from . import lifecycle

logger = get_logger(__name__)

_MAX_BACKOFF_SECONDS = 30.0


class TetherEventWatcher:
    """Background consumer of ``GET /v1/events``."""

    def __init__(self) -> None:
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._seq: int | None = None
        self._boot_id: str | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="tether-events", daemon=True)
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
        if event_type == "session.ended":
            session_id = data.get("id")
            if isinstance(session_id, str) and pane_store.unlink_session(session_id):
                logger.info("view_link_dropped", session_id=session_id, reason="session.ended")
        elif event_type == "gap":
            self._reconcile("gap")

    def _run(self) -> None:
        backoff = 1.0
        while not self._stop.is_set():
            resuming = self._seq is not None and self._boot_id is not None
            try:
                stream = get_client().events(
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


_watcher = TetherEventWatcher()


def start_watcher() -> None:
    _watcher.start()


def stop_watcher() -> None:
    _watcher.stop()
