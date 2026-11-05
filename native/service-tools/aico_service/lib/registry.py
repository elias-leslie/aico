"""Project discovery through Aico's registry and the registered project's identity."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any


class RegistryError(RuntimeError):
    """The registry or a registered project's runtime identity is unavailable."""


def aico_binary() -> str:
    return os.environ.get("AICO_BIN") or "aico"


def query(*args: str) -> Any:
    try:
        result = subprocess.run([aico_binary(), "projects", *args], text=True, capture_output=True, check=False)
        if result.returncode:
            raise RegistryError(f"Aico project registry did not answer (exit {result.returncode})")
        return json.loads(result.stdout)
    except (OSError, ValueError) as exc:
        raise RegistryError("Aico project registry is unavailable") from exc


def project_ids(*, include_inactive: bool = False) -> list[str]:
    rows = query("list", *(["--all"] if include_inactive else []))
    if not isinstance(rows, list) or any(not isinstance(row, dict) or not isinstance(row.get("id"), str) for row in rows):
        raise RegistryError("Aico project list must contain project ids")
    return sorted({row["id"] for row in rows})


def selected_project_id() -> str:
    if selected := os.environ.get("AICO_PROJECT_ID") or os.environ.get("ST_PROJECT_ID"):
        return selected
    rows = query("list")
    current = [row["id"] for row in rows if isinstance(row, dict) and row.get("current") is True
               and isinstance(row.get("id"), str)] if isinstance(rows, list) else []
    if len(current) != 1:
        raise RegistryError("No project selected. Pass the project id to rebuild.")
    return current[0]


def project_record(project_id: str) -> tuple[dict[str, Any], Path]:
    row = query("show", project_id)
    if not isinstance(row, dict) or row.get("id") != project_id:
        raise RegistryError(f"Unknown registered project: {project_id}")
    root_raw = row.get("root_path")
    if not isinstance(root_raw, str) or not Path(root_raw).is_absolute():
        raise RegistryError(f"Registered project {project_id} has no absolute root")
    return row, Path(root_raw)


def project_identity(project_id: str) -> tuple[dict[str, Any], Path]:
    _row, root = project_record(project_id)
    try:
        identity = json.loads((root / "project.identity.json").read_text())
    except (OSError, ValueError) as exc:
        raise RegistryError(f"Registered project {project_id} has no readable project.identity.json") from exc
    if (not isinstance(identity, dict) or not isinstance(identity.get("project"), dict)
            or identity["project"].get("id") != project_id
            or not isinstance(identity.get("runtime"), dict)
            or not isinstance(identity.get("services"), dict)):
        raise RegistryError(f"Registered project {project_id} has an invalid runtime identity")
    return identity, root
