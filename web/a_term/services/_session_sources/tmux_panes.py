"""The reader of the default tmux server's panes, for the Own tmux adapter.

One format and one parser. It runs through ``a_term.utils.tmux.run_tmux_command``,
so swapping the tmux runner later changes nothing here.
"""

from __future__ import annotations

from typing import NamedTuple

from ...utils import tmux

PANE_FORMAT = "\t".join(
    (
        "#{session_name}",
        "#{session_id}",
        "#{pane_id}",
        "#{pane_current_path}",
        "#{pane_current_command}",
        "#{pane_pid}",
    )
)


class PaneRow(NamedTuple):
    """One pane of the default tmux server, as ``list-panes -a`` reports it."""

    session_name: str
    session_id: str
    pane_id: str
    cwd: str
    command: str
    pid: str


def read_panes() -> list[PaneRow]:
    """Every pane on the default tmux server; empty when no server is running."""
    success, output = tmux.run_tmux_command(["list-panes", "-a", "-F", PANE_FORMAT])
    if not success:
        return []
    rows: list[PaneRow] = []
    for line in output.splitlines():
        parts = line.split("\t")
        if len(parts) == len(PaneRow._fields):
            rows.append(PaneRow(*parts))
    return rows
