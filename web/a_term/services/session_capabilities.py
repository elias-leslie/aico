"""What A-Term may do to a session, decided from the session's facts alone.

One table holds every capability rule: renaming, respawning (reset and load
tool), starting an agent, and ending. Callers ask :func:`refusal` before they
act, and the session list carries :func:`flags` so the UI never re-derives a
rule. Pure: no I/O, no Tether, no tmux.

Origin is never an input (it grants no authority), and workload state
(running or pending) is not a capability, so neither appears here.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, Literal, NamedTuple, TypedDict, get_args

SessionKind = Literal["tether", "tmux_external"]  # == the wire ``source``
Action = Literal["rename", "respawn", "start_agent", "end"]  # respawn = reset + load tool
RefusalCode = Literal["not_tether", "legacy_attach_only", "root_single_launch", "own_tmux_read_only", "shell_mode"]

SESSION_KINDS: tuple[SessionKind, ...] = get_args(SessionKind)
ACTIONS: tuple[Action, ...] = get_args(Action)
SHELL_MODE = "shell"


class LifecycleError(Exception):
    """A lifecycle request A-Term refuses before reaching Tether."""

    def __init__(self, status_code: int, detail: str) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


class SessionFacts(NamedTuple):
    """The only inputs a capability may depend on."""

    kind: SessionKind
    is_root: bool = False
    is_legacy: bool = False  # a Tether session with status "legacy" (made by an older Tether)
    mode: str = ""

    @classmethod
    def of(cls, session: Mapping[str, Any]) -> SessionFacts:
        """Read the facts from a catalog session. Strict: a partial dict raises ``KeyError``."""
        kind = session["source"]
        if kind not in SESSION_KINDS:
            raise ValueError(f"Unknown session kind: {kind!r}")
        return cls(kind=kind, is_root=bool(session["is_root"]), is_legacy=bool(session["is_legacy"]), mode=str(session["mode"]))


class Refusal(NamedTuple):
    """Why an action is refused. ``status`` None means declined: report it and do nothing."""

    code: RefusalCode
    detail: str
    status: int | None

    def error(self) -> LifecycleError:
        if self.status is None:
            raise ValueError(f"A declined refusal ({self.code}) is reported, not raised")
        return LifecycleError(self.status, self.detail)


class CapabilityFlags(TypedDict):
    can_rename: bool
    can_respawn: bool
    can_end: bool


_LEGACY_ATTACH_ONLY = "This session predates Tether and is attach-only"

# For each action the checks run top to bottom and the first match wins, so
# the order of each tuple is part of the contract. ``respawn`` checks legacy
# before root; ``start_agent`` checks root before shell before legacy. They
# only disagree for a Tether root with status "legacy", which cannot exist.
_Rule = tuple[Callable[[SessionFacts], bool], Refusal]
_TABLE: dict[Action, tuple[_Rule, ...]] = {
    "rename": ((lambda f: f.kind != "tether", Refusal("not_tether", "Only Tether sessions can be renamed", 400)),),
    "respawn": (
        (lambda f: f.is_legacy, Refusal("legacy_attach_only", _LEGACY_ATTACH_ONLY, 409)),
        (
            lambda f: f.is_root,
            Refusal("root_single_launch", "A root session runs one launch; start a new root instead", 409),
        ),
        (lambda f: f.kind != "tether", Refusal("own_tmux_read_only", "External tmux sessions are read-only", 400)),
    ),
    "start_agent": (
        (
            lambda f: f.kind == "tmux_external",
            Refusal("own_tmux_read_only", "External tmux agent session is already running", None),
        ),
        (lambda f: f.is_root, Refusal("root_single_launch", "Root launch is owned by its retained request", None)),
        (lambda f: f.mode == SHELL_MODE, Refusal("shell_mode", "Session is in shell mode, not agent mode", 400)),
        (lambda f: f.is_legacy, Refusal("legacy_attach_only", _LEGACY_ATTACH_ONLY, 409)),
    ),
    "end": (
        (
            lambda f: f.kind == "tmux_external",
            Refusal("own_tmux_read_only", "Only Tether sessions can be ended here", 400),
        ),
    ),
}


def refusal(action: Action, facts: SessionFacts) -> Refusal | None:
    """The refusal for ``action`` on a session with ``facts``, or None when it is allowed."""
    for applies, refused in _TABLE[action]:
        if applies(facts):
            return refused
    return None


def flags(facts: SessionFacts) -> CapabilityFlags:
    """The capability flags a session response carries: each is ``refusal(...) is None``."""
    return {
        "can_rename": refusal("rename", facts) is None,
        "can_respawn": refusal("respawn", facts) is None,
        "can_end": refusal("end", facts) is None,
    }
