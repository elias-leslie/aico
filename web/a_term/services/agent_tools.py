"""Agent tools, read from and written to Tether's merged registry.

Editing a tool here changes launches in Aico too. Tether stores ``argv``;
``command`` is its shell-quoted rendering. Slugs are canonical (``claude-code``)
and aliases (``claude``) resolve to them.
"""

from __future__ import annotations

import time
from collections.abc import Iterable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock
from typing import Any

from ..logging_config import get_logger
from ..tether import TetherError, TetherUnavailable, TetherVersionError, get_client

logger = get_logger(__name__)

SHELL_SLUG = "shell"

# Command token -> tool slug, used only until Tether has answered once: the
# agents Tether ships with, so Own tmux discovery still works while it is down.
FALLBACK_AGENT_TOKENS: Mapping[str, str] = {
    "claude": "claude-code",
    "claude-code": "claude-code",
    "codex": "codex",
    "agy": "agy",
    "pi": "pi",
}
AGENT_TOKENS_TTL_SECONDS = 30.0

# A-Term field name -> Tether field name, for create and update bodies.
_FIELD_MAP = {
    "slug": "slug",
    "name": "name",
    "command": "command",
    "argv": "argv",
    "process_name": "processName",
    "description": "description",
    "color": "color",
    "display_order": "displayOrder",
    "is_default": "isDefault",
    "enabled": "enabled",
    "aliases": "aliases",
    "context_hook": "contextHook",
}


def _iso(value: Any) -> str | None:
    if isinstance(value, int | float) and value > 0:
        return datetime.fromtimestamp(value / 1000, tz=UTC).isoformat()
    return None


def to_a_term(tool: dict[str, Any]) -> dict[str, Any]:
    """Tether tool -> A-Term's snake_case tool."""
    raw_argv = tool.get("argv")
    argv: list[Any] = raw_argv if isinstance(raw_argv, list) else []
    return {
        "id": str(tool.get("id") or tool.get("slug")),
        "slug": tool.get("slug"),
        "name": tool.get("name") or tool.get("slug"),
        "command": tool.get("command") or "",
        "argv": [str(arg) for arg in argv],
        "process_name": tool.get("processName") or "",
        "description": tool.get("description"),
        "color": tool.get("color"),
        "display_order": int(tool.get("displayOrder") or 0),
        "is_default": bool(tool.get("isDefault")),
        "enabled": tool.get("enabled", True) is not False,
        "aliases": [str(alias) for alias in tool.get("aliases") or []],
        "context_hook": tool.get("contextHook"),
        "created_at": _iso(tool.get("createdAt")),
        "updated_at": _iso(tool.get("updatedAt")),
    }


def to_tether_fields(fields: dict[str, Any]) -> dict[str, Any]:
    """A-Term tool fields -> Tether body (unknown keys dropped, None kept for clears)."""
    return {_FIELD_MAP[key]: value for key, value in fields.items() if key in _FIELD_MAP}


def list_tools(*, enabled_only: bool = False) -> list[dict[str, Any]]:
    body = get_client().list_tools(enabled_only=enabled_only)
    items = body.get("items") if isinstance(body, dict) else []
    tools = [to_a_term(item) for item in items or [] if isinstance(item, dict)]
    tools.sort(key=lambda tool: (tool["display_order"], tool["name"]))
    return tools


def get_tool(ref: str) -> dict[str, Any]:
    """A tool by id, slug or alias. Raises ``TetherError(404)`` if unknown."""
    return to_a_term(get_client().get_tool(ref))


def find_tool(ref: str) -> dict[str, Any] | None:
    try:
        return get_tool(ref)
    except TetherError as error:
        if error.status == 404:
            return None
        raise


def default_tool() -> dict[str, Any] | None:
    """Tether's default tool: the marked one, else the first enabled by order."""
    body = get_client().list_tools()
    if not isinstance(body, dict):
        return None
    items = [to_a_term(item) for item in (body.get("items") or []) if isinstance(item, dict)]
    default_slug = body.get("defaultSlug")
    for tool in items:
        if default_slug and tool["slug"] == default_slug:
            return tool
    enabled = sorted((tool for tool in items if tool["enabled"]), key=lambda tool: tool["display_order"])
    marked = next((tool for tool in enabled if tool["is_default"]), None)
    return marked or (enabled[0] if enabled else None)


def default_agent_slug() -> str:
    """Default tool slug for a project pane's agent session (never the bare shell)."""
    tool = default_tool()
    if tool and tool["slug"] != SHELL_SLUG:
        return str(tool["slug"])
    agents = [t for t in list_tools(enabled_only=True) if t["slug"] != SHELL_SLUG]
    return str(agents[0]["slug"]) if agents else SHELL_SLUG


def canonical_slug(ref: str) -> str:
    """Resolve an alias (``claude``) to its canonical slug (``claude-code``)."""
    if ref == SHELL_SLUG:
        return SHELL_SLUG
    tool = find_tool(ref)
    return str(tool["slug"]) if tool else ref


def create_tool(fields: dict[str, Any]) -> dict[str, Any]:
    tool = to_a_term(get_client().create_tool(to_tether_fields(fields)))
    reset_agent_tokens()
    return tool


def update_tool(ref: str, fields: dict[str, Any]) -> dict[str, Any]:
    tool = to_a_term(get_client().update_tool(ref, to_tether_fields(fields)))
    reset_agent_tokens()
    return tool


def delete_tool(ref: str) -> dict[str, Any]:
    result = get_client().delete_tool(ref)
    reset_agent_tokens()
    return result


def agent_tokens_from(tools: Iterable[dict[str, Any]]) -> dict[str, str]:
    """Command token -> canonical slug for every agent tool (the shell excluded).

    A tool is recognised by its slug, its aliases, its process name and the
    program its ``argv`` starts.
    """
    tokens: dict[str, str] = {}
    for tool in tools:
        slug = str(tool.get("slug") or "")
        if not slug or slug == SHELL_SLUG:
            continue
        argv = tool.get("argv") or []
        program = Path(str(argv[0])).name if argv else ""
        for token in (slug, *(tool.get("aliases") or []), tool.get("process_name") or "", program):
            normalized = str(token).strip().lower()
            if normalized:
                tokens.setdefault(normalized, slug)
    return tokens


class _AgentTokenCache:
    """Tether's agent tokens, re-read at most every ``ttl`` seconds.

    When Tether can't be read, the last tokens it gave stay in use; before it
    has ever answered, :data:`FALLBACK_AGENT_TOKENS` does. A failure is also
    held for ``ttl`` so a down Tether isn't asked on every listing.
    """

    def __init__(self, ttl: float = AGENT_TOKENS_TTL_SECONDS) -> None:
        self._ttl = ttl
        self._lock = Lock()
        self._tokens: dict[str, str] | None = None
        self._expires = 0.0

    def get(self) -> Mapping[str, str]:
        with self._lock:
            now = time.monotonic()
            if now >= self._expires:
                self._expires = now + self._ttl
                try:
                    self._tokens = agent_tokens_from(list_tools())
                except (TetherUnavailable, TetherError, TetherVersionError) as error:
                    logger.warning("agent_tokens_fallback", error=str(error), cached=self._tokens is not None)
            return self._tokens if self._tokens is not None else FALLBACK_AGENT_TOKENS

    def reset(self) -> None:
        with self._lock:
            self._tokens = None
            self._expires = 0.0


_AGENT_TOKENS = _AgentTokenCache()


def agent_tokens() -> Mapping[str, str]:
    """Command token -> canonical slug for recognising agents A-Term didn't start."""
    return _AGENT_TOKENS.get()


def reset_agent_tokens() -> None:
    """Forget the cached tokens, so the next listing reads Tether again."""
    _AGENT_TOKENS.reset()
