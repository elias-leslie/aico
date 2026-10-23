"""Bounded, process-local metadata for agent shares delivered by the default Tether."""

from __future__ import annotations

import re
import subprocess
import threading
import unicodedata
from collections import deque
from dataclasses import asdict, dataclass
from typing import Literal
from urllib.parse import urlsplit

from ..branding import PUBLIC_HOST
from ..logging_config import get_logger

logger = get_logger(__name__)

_ID = re.compile(r"[0-9a-f]{1,64}")
_SESSION = re.compile(r"[0-9a-f]{8}")
_NAME = re.compile(r"([0-9a-f]{8}|none)/out/[A-Za-z0-9._-]{1,120}")


def _plain(value: str) -> bool:
    return all(unicodedata.category(char) not in {"Cc", "Cf", "Cs", "Zl", "Zp"} for char in value)


@dataclass(frozen=True)
class Show:
    id: str
    session: str | None
    kind: Literal["file", "url"]
    title: str | None
    name: str
    url: str | None = None

    def metadata(self) -> dict[str, str | None]:
        result = asdict(self)
        if self.kind == "file":
            result.pop("url")
        return result


def validate_show(data: dict[str, object]) -> Show | None:
    show_id, session = data.get("id"), data.get("session")
    title, name, kind = data.get("title"), data.get("name"), data.get("kind")
    if not isinstance(show_id, str) or not _ID.fullmatch(show_id):
        return None
    if session is not None and (not isinstance(session, str) or not _SESSION.fullmatch(session)):
        return None
    if title is not None and (not isinstance(title, str) or len(title) > 120 or not _plain(title)):
        return None
    if not isinstance(name, str):
        return None
    if kind == "file":
        if not _NAME.fullmatch(name) or name.rsplit("/", 1)[-1] in {".", ".."}:
            return None
        if name.split("/", 1)[0] != (session or "none") or data.get("url") is not None:
            return None
        return Show(show_id, session, "file", title, name)
    if kind == "url":
        url = data.get("url")
        if not isinstance(url, str) or not 1 <= len(url) <= 2000 or not _plain(url) or url.strip() != url:
            return None
        try:
            parsed = urlsplit(url)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname:
                return None
            _ = parsed.port
        except ValueError:
            return None
        if name != url:
            return None
        return Show(show_id, session, "url", title, name, url)
    return None


class ShowStore:
    def __init__(self) -> None:
        self._items: deque[Show] = deque(maxlen=50)
        self._lock = threading.Lock()

    def add(self, show: Show) -> bool:
        with self._lock:
            if any(item.id == show.id for item in self._items):
                return False
            self._items.append(show)
            return True

    def recent(self, since: str | None = None) -> list[Show]:
        with self._lock:
            items = list(self._items)
        for index, item in enumerate(items):
            if item.id == since:
                return items[index + 1 :]
        # An expired cursor (or a restart) returns the retained ring.
        return items

    def get(self, show_id: str) -> Show | None:
        with self._lock:
            return next((item for item in self._items if item.id == show_id), None)


store = ShowStore()


def push_show(show: Show) -> None:
    argv = [
        "nightshift", "push", "--title", "Agent shared something", "--severity", "info", "--key", f"show:{show.id}",
    ]
    if PUBLIC_HOST:
        argv.extend(["--open", f"https://{PUBLIC_HOST}/?show={show.id}"])
    argv.append("Open Aico to see it.")  # fixed text: nothing the agent wrote reaches the push
    try:
        subprocess.run(argv, timeout=10, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as error:
        logger.warning("show_push_failed", show_id=show.id, error=str(error))


def receive_show(data: dict[str, object]) -> None:
    show = validate_show(data)
    if show is None:
        logger.info("show_rejected")
    elif store.add(show):
        push_show(show)
