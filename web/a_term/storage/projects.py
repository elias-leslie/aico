"""Local project registry helpers backed by the shared projects table."""

from __future__ import annotations

import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from psycopg.rows import dict_row

from ..branding import get_project_identity_for_root, list_workspace_project_identities
from .connection import get_connection

_PROJECT_FIELDS = "id, name, root_path, created_at"
_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _normalize_row(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    return {
        "id": str(row["id"]),
        "name": str(row["name"]),
        "root_path": row.get("root_path"),
        "created_at": row.get("created_at"),
    }


def list_projects() -> list[dict[str, Any]]:
    """List locally registered projects."""
    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            f"SELECT {_PROJECT_FIELDS} FROM projects ORDER BY lower(name), lower(id)"
        )
        rows = cur.fetchall()
    projects: list[dict[str, Any]] = []
    for row in rows:
        normalized = _normalize_row(row)
        if normalized:
            projects.append(normalized)
    return projects


def get_project(project_id: str) -> dict[str, Any] | None:
    """Get one project by ID."""
    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            f"SELECT {_PROJECT_FIELDS} FROM projects WHERE id = %s",
            (project_id,),
        )
        row = cur.fetchone()
    return _normalize_row(row)


def get_project_by_root_path(root_path: str) -> dict[str, Any] | None:
    """Get one project by canonical root path."""
    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            f"SELECT {_PROJECT_FIELDS} FROM projects WHERE root_path = %s",
            (root_path,),
        )
        row = cur.fetchone()
    return _normalize_row(row)


def _slugify(value: str) -> str:
    slug = _SLUG_RE.sub("-", value.strip().lower()).strip("-")
    return slug or "project"


def _humanize_slug(value: str) -> str:
    parts = [part for part in _SLUG_RE.split(value.strip()) if part]
    return " ".join(part.capitalize() for part in parts) or "Project"


def _next_available_project_id(base_id: str) -> str:
    candidate = base_id
    suffix = 2
    while get_project(candidate):
        candidate = f"{base_id}-{suffix}"
        suffix += 1
    return candidate


def _resolve_root_path(root_path: str) -> str:
    if "\x00" in root_path:
        raise ValueError("Invalid project path")
    try:
        resolved = Path(os.path.realpath(os.path.abspath(os.path.expanduser(root_path))))
    except OSError as err:
        raise ValueError(f"Unable to resolve project path: {root_path}") from err
    if not resolved.exists():
        raise ValueError(f"Project path does not exist: {resolved}")
    if not resolved.is_dir():
        raise ValueError(f"Project path is not a directory: {resolved}")
    return str(resolved)


def create_project(*, name: str | None, root_path: str) -> dict[str, Any]:
    """Register one local project by path, deriving identity when possible."""
    resolved_root = _resolve_root_path(root_path)
    existing = get_project_by_root_path(resolved_root)
    if existing:
        return existing

    identity = get_project_identity_for_root(resolved_root)
    project = identity.get("project") if isinstance(identity, dict) else None
    manifest_id = project.get("id") if isinstance(project, dict) else None
    manifest_name = project.get("display_name") if isinstance(project, dict) else None

    requested_name = name.strip() if isinstance(name, str) and name.strip() else None
    display_name = (
        manifest_name
        if isinstance(manifest_name, str) and manifest_name.strip()
        else requested_name or _humanize_slug(Path(resolved_root).name)
    )
    base_id = (
        manifest_id
        if isinstance(manifest_id, str) and manifest_id.strip()
        else _slugify(requested_name or Path(resolved_root).name)
    )
    project_id = _next_available_project_id(base_id)

    now = datetime.now(tz=UTC)
    with get_connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            INSERT INTO projects (id, name, base_url, root_path, category, created_at)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id, name, root_path, created_at
            """,
            (project_id, display_name, "", resolved_root, "dev", now),
        )
        row = cur.fetchone()
        conn.commit()
    normalized = _normalize_row(row)
    if not normalized:
        raise RuntimeError("Failed to create project")
    return normalized


def sync_workspace_projects() -> int:
    """Upsert sibling manifest-backed projects into the local registry."""
    manifests = list_workspace_project_identities()
    if not manifests:
        return 0

    now = datetime.now(tz=UTC)
    with get_connection() as conn, conn.cursor() as cur:
        for manifest in manifests:
            project_id = str(manifest["id"])
            display_name = str(manifest["display_name"])
            root_path = str(manifest["root_path"])
            frontend_port = manifest.get("frontend_port")
            backend_port = manifest.get("backend_port")
            health_endpoint = manifest.get("health_endpoint") or "/health"
            base_url = f"http://127.0.0.1:{frontend_port}" if frontend_port else ""
            cur.execute(
                """
                INSERT INTO projects (
                    id,
                    name,
                    base_url,
                    health_endpoint,
                    frontend_port,
                    backend_port,
                    root_path,
                    category,
                    created_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    base_url = CASE
                        WHEN EXCLUDED.base_url = '' THEN projects.base_url
                        ELSE EXCLUDED.base_url
                    END,
                    health_endpoint = EXCLUDED.health_endpoint,
                    frontend_port = COALESCE(EXCLUDED.frontend_port, projects.frontend_port),
                    backend_port = COALESCE(EXCLUDED.backend_port, projects.backend_port),
                    root_path = EXCLUDED.root_path,
                    category = EXCLUDED.category
                """,
                (
                    project_id,
                    display_name,
                    base_url,
                    health_endpoint,
                    frontend_port,
                    backend_port,
                    root_path,
                    "dev",
                    now,
                ),
            )
        conn.commit()
    return len(manifests)
