"""Configuration and project resolution through Aico's local registry CLI."""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

from ._cli import run_json
from .execution_context import canonical_repo_root


@dataclass(frozen=True)
class Config:
    api_base: str
    project_id: str
    project_root: str | None = None
    source: str = "unknown"


@dataclass(frozen=True)
class _RuntimeConfig:
    api_base: str
    agent_hub_url: str
    project_id: str | None
    project_root: str | None
    cwd: str


_project_override: str | None = None
_runtime_config: _RuntimeConfig | None = None
_default_api_base: str | None = None
_default_agent_hub_url: str | None = None


def configure_defaults(*, api_base: str | None = None, agent_hub_url: str | None = None) -> None:
    """Set explicit caller-owned URLs; no retired service endpoint is assumed."""
    global _default_api_base, _default_agent_hub_url
    if api_base:
        _default_api_base = api_base
    if agent_hub_url:
        _default_agent_hub_url = agent_hub_url
    get_config.cache_clear()


def configure_runtime_context(
    *, api_base: str, agent_hub_url: str, project_id: str | None,
    project_root: str | None, cwd: str,
) -> None:
    """Install the validated v1 dispatcher context before callback resolution."""
    global _runtime_config
    _runtime_config = _RuntimeConfig(api_base, agent_hub_url, project_id, project_root, cwd)
    get_config.cache_clear()


def clear_runtime_context() -> None:
    global _runtime_config
    _runtime_config = None
    get_config.cache_clear()


def _aico_api_base() -> str:
    """Use the registered Aico runtime rather than hardcoding its current port."""
    root = get_project_root_path("aico")
    if root:
        try:
            identity = json.loads((Path(root) / "project.identity.json").read_text())
            port = identity["runtime"]["backend_port"]
            if type(port) is int and 0 < port <= 65535:
                return f"http://127.0.0.1:{port}/api"
        except (OSError, ValueError, TypeError, KeyError):
            pass
    return ""


def get_api_base() -> str:
    """Return an explicit URL or the local Aico runtime URL, if registered."""
    if _runtime_config is not None:
        return _runtime_config.api_base
    for value in (os.getenv("AICO_API_BASE"), os.getenv("AICO_WEB_URL"),
                  os.getenv("ST_API_BASE"), _default_api_base):
        if value and value.strip():
            return value.strip().rstrip("/")
    return _aico_api_base()


def get_agent_hub_url() -> str:
    """Compatibility name for an explicit service URL, otherwise Aico's URL."""
    if _runtime_config is not None:
        return _runtime_config.agent_hub_url
    return _default_agent_hub_url or get_api_base().removesuffix("/api")


def set_project_override(project_id: str | None) -> None:
    global _project_override
    _project_override = project_id
    get_config.cache_clear()


def get_project_override() -> str | None:
    return _project_override


def _resolve_project_from_list(projects: list[object], cwd: Path) -> tuple[str | None, str | None]:
    # A nested registered project wins over its parent regardless of registry order.
    matches: list[tuple[str, str]] = []
    for project in projects:
        if not isinstance(project, dict):
            continue
        root_path, project_id = project.get("root_path"), project.get("id")
        if not isinstance(root_path, str) or not root_path or not isinstance(project_id, str):
            continue
        root = Path(root_path).resolve()
        if cwd.is_relative_to(root):
            matches.append((project_id, str(root)))
    if not matches:
        return None, None
    selected = max(matches, key=lambda item: len(Path(item[1]).parts))
    return selected


def _read_project_id_from_index(root: Path) -> str | None:
    try:
        data = yaml.safe_load((root / ".index.yaml").read_text())
    except (OSError, yaml.YAMLError):
        return None
    project_id = data.get("project") if isinstance(data, dict) else None
    return project_id.strip() if isinstance(project_id, str) and project_id.strip() else None


def _detect_project_from_local_metadata(cwd: Path) -> tuple[str | None, str | None]:
    candidates = [canonical_repo_root(cwd), cwd, *cwd.parents]
    for candidate in dict.fromkeys(candidates):
        if candidate is not None and (project_id := _read_project_id_from_index(candidate)):
            return project_id, str(candidate)
    return None, None


def _projects() -> list[object]:
    data = run_json("projects", "list", "--json")
    return data if isinstance(data, list) else []


def get_project(project_id: str) -> dict[str, Any] | None:
    """Read a registry row without contacting a service or loading project code."""
    data = run_json("projects", "show", project_id, "--json")
    return data if isinstance(data, dict) and data.get("id") == project_id else None


def _detect_project_from_cwd() -> tuple[str | None, str | None]:
    try:
        cwd = Path.cwd().resolve()
    except OSError:
        return None, None
    if (local := _detect_project_from_local_metadata(cwd))[0]:
        return local
    projects = _projects()
    if (resolved := _resolve_project_from_list(projects, cwd))[0]:
        return resolved
    canonical_root = canonical_repo_root(cwd)
    return _resolve_project_from_list(projects, canonical_root) if canonical_root else (None, None)


def _resolve_project() -> tuple[str | None, str | None, str]:
    if _runtime_config is not None:
        return _runtime_config.project_id, _runtime_config.project_root, "context"
    if _project_override:
        return _project_override, get_project_root_path(_project_override), "flag"
    if project_id := os.getenv("AICO_PROJECT_ID") or os.getenv("ST_PROJECT_ID"):
        return project_id, None, "env"
    project_id, root = _detect_project_from_cwd()
    return project_id, root, "cwd"


@lru_cache
def get_config() -> Config:
    """Resolve configuration, exiting when a required project is unavailable."""
    result = get_config_optional()
    if result.project_id:
        return result
    print("No project for cwd. Run from a registered project tree, or pass -P <id>.\n"
          "Resolution: aico projects list", file=sys.stderr)
    raise SystemExit(1)


def get_config_optional() -> Config:
    project_id, root, source = _resolve_project()
    return Config(get_api_base(), project_id or "", root, source)


def get_available_projects() -> list[str]:
    return [project["id"] for project in _projects()
            if isinstance(project, dict) and isinstance(project.get("id"), str)]


def get_project_root_path(project_id: str) -> str | None:
    root = (get_project(project_id) or {}).get("root_path")
    return root if isinstance(root, str) and root else None
