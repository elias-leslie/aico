"""Agent tools, read from and written to Tether's merged registry.

Editing a tool here changes launches in Aico too. Tether stores ``argv``;
``command`` is its shell-quoted rendering. Slugs are canonical (``claude-code``)
and aliases (``claude``) resolve to them.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from ..tether import TetherError, get_client

SHELL_SLUG = "shell"

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
    return to_a_term(get_client().create_tool(to_tether_fields(fields)))


def update_tool(ref: str, fields: dict[str, Any]) -> dict[str, Any]:
    return to_a_term(get_client().update_tool(ref, to_tether_fields(fields)))


def delete_tool(ref: str) -> dict[str, Any]:
    return get_client().delete_tool(ref)
