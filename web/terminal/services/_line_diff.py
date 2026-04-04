"""Line-level diff tracking for scrollback synchronization."""

from __future__ import annotations

from dataclasses import dataclass, field

HEAD_HASH_COUNT = 10  # lines kept for head-truncation detection


def _split_lines(content: str) -> list[str]:
    """Split snapshot content into lines, stripping trailing empties."""
    lines = content.split("\n")
    while lines and lines[-1] == "":
        lines.pop()
    return lines


@dataclass(slots=True)
class LineEntry:
    hash: int  # hash(content)
    content: str  # the line text with ANSI


@dataclass(slots=True)
class ScrollbackDelta:
    seqno: int
    base_offset: int
    changes: list[tuple[int, str]]  # [(stable_index, content), ...]
    removals: list[int]  # stable indices that scrolled off
    total_lines: int
    cursor: tuple[int, int] | None = None

    @property
    def is_full_sync_cheaper(self) -> bool:
        """True when the delta is so large a full sync is more efficient."""
        return len(self.changes) > self.total_lines // 2

    def to_dict(self) -> dict:
        """Serialize to the ``scrollback_delta`` wire format."""
        d: dict = {
            "__ctrl": True,
            "scrollback_delta": {
                "seqno": self.seqno,
                "base": self.base_offset,
                "changes": self.changes,
                "removals": self.removals,
                "total_lines": self.total_lines,
            },
        }
        if self.cursor is not None:
            d["scrollback_delta"]["cursor"] = list(self.cursor)
        return d


@dataclass
class LineDiffTracker:
    """Compute line-level deltas between successive tmux snapshots."""

    _seqno: int = 0
    _base_offset: int = 0
    _lines: list[LineEntry] = field(default_factory=list)
    _head_hashes: list[int] = field(default_factory=list)

    def compute_delta(
        self,
        new_content: str,
        cursor: tuple[int, int] | None = None,
    ) -> ScrollbackDelta:
        """Return a delta describing changes from the last snapshot."""
        new_lines = _split_lines(new_content)
        self._seqno += 1

        if not self._lines:
            # First snapshot — everything is a change.
            self._lines = [LineEntry(hash=hash(line), content=line) for line in new_lines]
            self._head_hashes = [hash(line) for line in new_lines[:HEAD_HASH_COUNT]]
            changes = [(self._base_offset + i, line) for i, line in enumerate(new_lines)]
            return ScrollbackDelta(
                seqno=self._seqno,
                base_offset=self._base_offset,
                changes=changes,
                removals=[],
                total_lines=len(new_lines),
                cursor=cursor,
            )

        # Detect head truncation — lines that scrolled off.
        removals: list[int] = []
        scrolled_off = self._detect_head_truncation(new_lines)
        if scrolled_off > 0:
            removals.extend(self._base_offset + i for i in range(scrolled_off))
            self._base_offset += scrolled_off
            self._lines = self._lines[scrolled_off:]

        # Diff old vs new.
        new_entries = [LineEntry(hash=hash(line), content=line) for line in new_lines]
        changes: list[tuple[int, str]] = []

        max_common = min(len(self._lines), len(new_entries))
        for i in range(max_common):
            if self._lines[i].hash != new_entries[i].hash:
                changes.append((self._base_offset + i, new_entries[i].content))

        # Appended lines.
        for i in range(max_common, len(new_entries)):
            changes.append((self._base_offset + i, new_entries[i].content))

        # Lines removed from the tail (rare — window shrink).
        if len(self._lines) > len(new_entries):
            removals.extend(self._base_offset + i for i in range(len(new_entries), len(self._lines)))

        # Update state.
        self._lines = new_entries
        self._head_hashes = [hash(line) for line in new_lines[:HEAD_HASH_COUNT]]

        return ScrollbackDelta(
            seqno=self._seqno,
            base_offset=self._base_offset,
            changes=changes,
            removals=removals,
            total_lines=len(new_lines),
            cursor=cursor,
        )

    def reset(self) -> None:
        """Clear tracked state (e.g. on reconnect)."""
        self._seqno = 0
        self._base_offset = 0
        self._lines.clear()
        self._head_hashes.clear()

    def _detect_head_truncation(self, new_lines: list[str]) -> int:
        """Detect how many old head lines scrolled off the capture window."""
        if not self._head_hashes or not new_lines:
            return 0

        new_head_hashes = [hash(line) for line in new_lines[:HEAD_HASH_COUNT]]
        if self._head_hashes[0] in new_head_hashes:
            return 0

        new_first_hash = hash(new_lines[0])
        for i, old_hash in enumerate(entry.hash for entry in self._lines):
            if old_hash == new_first_hash:
                return i

        # Couldn't correlate — assume everything scrolled off (conservative).
        return len(self._lines)
