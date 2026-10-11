"""Project catalog, read from Tether.

Tether serves SummitFlow's projects when SummitFlow is installed (``source``
``summitflow`` or ``summitflow-cache``), else its local list
``~/.config/tether/projects.json``. Registering a project is Tether's
``POST /v1/projects``, which only the local source accepts.
"""

from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path
from typing import Any, Literal

from ..branding import get_project_identity_for_root
from ..tether import TetherError, get_client

ProjectCatalogSource = Literal["local", "companion"]
_SLUG_RE = re.compile(r"[^a-z0-9]+")
# Tether's project id rule.
_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_MAX_ID_SUFFIX = 50


def _fetch(refresh: bool = False) -> dict[str, Any]:
    body = get_client().list_projects(refresh=refresh)
    return body if isinstance(body, dict) else {}


def _normalize(project: dict[str, Any]) -> dict[str, Any] | None:
    project_id = project.get("id")
    if not isinstance(project_id, str) or not project_id:
        return None
    return {
        "id": project_id,
        "name": project.get("name") or project_id,
        "root_path": project.get("root"),
        "lifecycle": project.get("lifecycle"),
    }


def list_projects_sync(refresh: bool = False) -> list[dict[str, Any]]:
    projects = _fetch(refresh).get("projects") or []
    return [normalized for item in projects if isinstance(item, dict) and (normalized := _normalize(item))]


async def list_projects(refresh: bool = False) -> list[dict[str, Any]]:
    return await asyncio.to_thread(list_projects_sync, refresh)


def tether_source() -> str:
    return str(_fetch().get("source") or "local")


def get_catalog_source() -> ProjectCatalogSource:
    """``companion`` when Tether serves SummitFlow's projects, else ``local``."""
    return "local" if tether_source() == "local" else "companion"


def can_register_projects() -> bool:
    return get_catalog_source() == "local"


def _slugify(value: str) -> str:
    return _SLUG_RE.sub("-", value.strip().lower()).strip("-") or "project"


def _resolve_root(root_path: str) -> Path:
    if "\x00" in root_path:
        raise ValueError("Invalid project path")
    resolved = Path(os.path.realpath(os.path.abspath(os.path.expanduser(root_path))))
    if not resolved.exists():
        raise ValueError(f"Project path does not exist: {resolved}")
    if not resolved.is_dir():
        raise ValueError(f"Project path is not a directory: {resolved}")
    return resolved


def _identity(root: Path, name: str | None) -> tuple[str, str]:
    """(id, display name) from the root's project manifest, else from ``name`` or the folder."""
    identity = get_project_identity_for_root(root)
    project = identity.get("project") if isinstance(identity, dict) else None
    manifest_id = project.get("id") if isinstance(project, dict) else None
    manifest_name = project.get("display_name") if isinstance(project, dict) else None
    display_name = (
        manifest_name
        if isinstance(manifest_name, str) and manifest_name.strip()
        else (name.strip() if name and name.strip() else root.name)
    )
    if isinstance(manifest_id, str) and _ID_RE.match(manifest_id):
        return manifest_id, display_name
    return _slugify(name or root.name)[:100], display_name


def register_local_project(*, root_path: str, name: str | None = None) -> dict[str, Any]:
    """Register a project with Tether (``POST /v1/projects``, local source only).

    A root that is already listed returns that project. A taken id gets a
    numeric suffix. Raises ``PermissionError`` when SummitFlow supplies the
    projects and ``ValueError`` for a root Tether refuses.
    """
    root = _resolve_root(root_path)
    for project in list_projects_sync():
        if project.get("root_path") == str(root):
            return project
    base_id, display_name = _identity(root, name)
    client = get_client()
    for suffix in range(1, _MAX_ID_SUFFIX + 1):
        project_id = base_id if suffix == 1 else f"{base_id}-{suffix}"
        try:
            created = client.register_project(project_id, str(root), display_name)
        except TetherError as error:
            if error.code == "project_exists":
                continue
            if error.code == "projects_managed_by_summitflow":
                raise PermissionError("Projects are managed by SummitFlow") from None
            if error.code in {"invalid_project_root", "invalid_project_id"}:
                raise ValueError(f"Tether refused the project ({error.code})") from None
            raise
        return _normalize(created) or {"id": project_id, "name": display_name, "root_path": str(root), "lifecycle": None}
    raise ValueError(f"No free project id for {base_id}")
