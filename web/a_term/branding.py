"""Repo-local branding and identity helpers for A-Term."""

from __future__ import annotations

import json
import os
import shutil
from functools import lru_cache
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
_MANIFEST_PATH = REPO_ROOT / "project.identity.json"


@lru_cache
def _identity() -> dict[str, Any]:
    return json.loads(_MANIFEST_PATH.read_text())


def _project_section() -> dict[str, Any]:
    return _identity().get("project", {})


def _branding_section() -> dict[str, Any]:
    return _identity().get("branding", {})


def _runtime_section() -> dict[str, Any]:
    return _identity().get("runtime", {})


def _artifacts_section() -> dict[str, Any]:
    return _identity().get("artifacts", {})


def _workspace_projects_root() -> Path | None:
    candidate = REPO_ROOT.parent
    if candidate.name == "projects" and candidate.exists():
        return candidate
    return None


def _project_aliases(project: dict[str, Any]) -> tuple[str, ...]:
    aliases: list[str] = []
    seen: set[str] = set()
    for key in ("id", "repo_name"):
        value = project.get(key)
        if isinstance(value, str) and value and value not in seen:
            seen.add(value)
            aliases.append(value)
    for key in ("legacy_ids", "repo_aliases"):
        values = project.get(key)
        if isinstance(values, list):
            for value in values:
                if isinstance(value, str) and value and value not in seen:
                    seen.add(value)
                    aliases.append(value)
    return tuple(aliases)


def _read_manifest_payload(manifest_path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(manifest_path.read_text())
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def _manifest_path_for_root(root_path: str | Path) -> Path | None:
    root = Path(os.path.realpath(os.path.abspath(os.path.expanduser(str(root_path)))))
    candidate = (root / "project.identity.json").resolve()
    try:
        inside_root = os.path.commonpath([str(root), str(candidate)]) == str(root)
    except ValueError:
        return None
    if not inside_root:
        return None
    return candidate


def get_project_identity_for_root(root_path: str | Path) -> dict[str, Any] | None:
    """Load a project identity manifest from an explicit repo root when present."""
    candidate = _manifest_path_for_root(root_path)
    if candidate is None:
        return None
    return _read_manifest_payload(candidate) if candidate.is_file() else None


@lru_cache
def list_workspace_project_identities() -> tuple[dict[str, Any], ...]:
    """Return manifest-backed workspace project identities, including this repo."""
    manifest_paths: list[Path] = [_MANIFEST_PATH]
    projects_root = _workspace_projects_root()
    if projects_root is not None:
        manifest_paths.extend(sorted(projects_root.glob("*/project.identity.json")))

    entries: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for manifest_path in manifest_paths:
        payload = _read_manifest_payload(manifest_path)
        if payload is None:
            continue
        project = payload.get("project")
        runtime = payload.get("runtime", {})
        if not isinstance(project, dict):
            continue
        project_id = project.get("id")
        display_name = project.get("display_name")
        if not isinstance(project_id, str) or not project_id:
            continue
        if not isinstance(display_name, str) or not display_name:
            display_name = project_id
        if project_id in seen_ids:
            continue
        seen_ids.add(project_id)
        entries.append(
            {
                "id": project_id,
                "display_name": display_name,
                "root_path": str(manifest_path.parent),
                "frontend_port": runtime.get("frontend_port"),
                "backend_port": runtime.get("backend_port"),
                "health_endpoint": runtime.get("health_endpoint"),
            }
        )

    entries.sort(key=lambda entry: str(entry.get("display_name", entry["id"])).lower())
    return tuple(entries)


@lru_cache
def _workspace_display_names() -> dict[str, str]:
    display_names: dict[str, str] = {}
    for entry in list_workspace_project_identities():
        payload = get_project_identity_for_root(entry["root_path"])
        project = payload.get("project") if isinstance(payload, dict) else None
        if not isinstance(project, dict):
            continue
        display_name = entry["display_name"]
        for alias in _project_aliases(project):
            display_names.setdefault(alias, display_name)
    return display_names


def get_project_display_name(project_id: str, fallback: str | None = None) -> str | None:
    """Return the manifest-backed display name for any workspace project when available."""
    if project_id == PROJECT_ID:
        return DISPLAY_NAME
    return _workspace_display_names().get(project_id, fallback)


def _legacy_path_candidates(parent: Path, names: list[str]) -> list[Path]:
    return [parent / name for name in names if name]


def _migrate_path(legacy_paths: list[Path], target_path: Path) -> Path:
    if target_path.exists():
        return target_path

    legacy_path = next((candidate for candidate in legacy_paths if candidate.exists()), None)
    if legacy_path is None:
        return target_path

    target_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(legacy_path), str(target_path))
    return target_path


PROJECT_ID = _project_section().get("id", "a-term")
DISPLAY_NAME = _project_section().get("display_name", "A-Term")
SHORT_NAME = _branding_section().get("short_name", DISPLAY_NAME)
DESCRIPTION = _branding_section().get(
    "description",
    "Host-native browser workspace for persistent tmux, shell, and agent sessions.",
)
BACKEND_PORT = int(_runtime_section().get("backend_port", 8002))
FRONTEND_PORT = int(_runtime_section().get("frontend_port", 3002))
PYTHON_DISTRIBUTION = _artifacts_section().get("python_distribution", "a-term")
CACHE_DIR_NAME = _artifacts_section().get("cache_dir_name", "a-term")
UPLOAD_DIR_NAME = _artifacts_section().get("upload_dir_name", "a-term-uploads")
LEGACY_CACHE_DIR_NAMES = [
    str(name)
    for name in _artifacts_section().get(
        "legacy_cache_dir_names",
        [],
    )
    if isinstance(name, str) and name
]
LEGACY_UPLOAD_DIR_NAMES = [
    str(name)
    for name in _artifacts_section().get(
        "legacy_upload_dir_names",
        [],
    )
    if isinstance(name, str) and name
]


def get_cache_root() -> Path:
    """Return the current cache directory, migrating the legacy path if needed."""
    target = Path.home() / ".cache" / CACHE_DIR_NAME
    legacy_paths = _legacy_path_candidates(Path.home() / ".cache", LEGACY_CACHE_DIR_NAMES)
    return _migrate_path(legacy_paths, target)


def get_recordings_dir() -> Path:
    """Return the recordings directory under the canonical cache root."""
    return get_cache_root() / "recordings"


def get_upload_dir() -> Path:
    """Return the current upload directory, migrating the legacy path if needed."""
    target = Path.home() / UPLOAD_DIR_NAME
    legacy_paths = _legacy_path_candidates(Path.home(), LEGACY_UPLOAD_DIR_NAMES)
    return _migrate_path(legacy_paths, target)
