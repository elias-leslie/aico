"""Project catalog, read from Tether.

Tether serves SummitFlow's projects when SummitFlow is installed (``source``
``summitflow`` or ``summitflow-cache``), else its local list
``~/.config/tether/projects.json``. A-Term can register projects only in the
local case, by adding an entry to that file.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Literal

from ..branding import get_project_identity_for_root
from ..tether import get_client

ProjectCatalogSource = Literal["local", "companion"]
_SLUG_RE = re.compile(r"[^a-z0-9]+")
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")


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


def local_projects_file() -> Path:
    configured = os.environ.get("TETHER_PROJECTS_FILE", "").strip()
    if configured:
        return Path(configured).expanduser()
    config_home = os.environ.get("XDG_CONFIG_HOME", "").strip()
    base = Path(config_home).expanduser() if config_home else Path.home() / ".config"
    return base / "tether" / "projects.json"


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


def register_local_project(*, root_path: str, name: str | None = None) -> dict[str, Any]:
    """Add a project to Tether's local list (only when SummitFlow is not the source)."""
    if not can_register_projects():
        raise PermissionError("Projects are managed by SummitFlow")
    root = _resolve_root(root_path)
    path = local_projects_file()
    try:
        entries = json.loads(path.read_text()) if path.exists() else []
    except (OSError, ValueError) as error:
        raise ValueError(f"Cannot read {path}: {error}") from error
    if not isinstance(entries, list):
        raise ValueError(f"{path} must contain a JSON list")
    for entry in entries:
        if isinstance(entry, dict) and entry.get("root") == str(root):
            return _normalize({**entry, "name": entry.get("name") or entry.get("id")}) or {}
    identity = get_project_identity_for_root(root)
    project = identity.get("project") if isinstance(identity, dict) else None
    manifest_id = project.get("id") if isinstance(project, dict) else None
    manifest_name = project.get("display_name") if isinstance(project, dict) else None
    display_name = (
        manifest_name
        if isinstance(manifest_name, str) and manifest_name.strip()
        else (name.strip() if name and name.strip() else root.name)
    )
    base_id = manifest_id if isinstance(manifest_id, str) and _ID_RE.fullmatch(manifest_id) else _slugify(name or root.name)
    taken = {entry.get("id") for entry in entries if isinstance(entry, dict)}
    project_id, suffix = base_id, 2
    while project_id in taken:
        project_id, suffix = f"{base_id}-{suffix}", suffix + 1
    entries.append({"id": project_id, "name": display_name, "root": str(root)})
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False, prefix=".projects.") as handle:
        json.dump(entries, handle, indent=2)
        handle.write("\n")
        temp_name = handle.name
    os.replace(temp_name, path)
    list_projects_sync(refresh=True)
    return {"id": project_id, "name": display_name, "root_path": str(root), "lifecycle": None}
