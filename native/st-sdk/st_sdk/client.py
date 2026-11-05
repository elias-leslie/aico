"""Public client for explicit project APIs and local Aico task promotion."""

from __future__ import annotations

import json as json_module
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

from . import _cli
from .config import get_api_base, get_config, get_config_optional
from .http import APIError, BaseHTTPClient

if TYPE_CHECKING:
    import httpx


class STClient(BaseHTTPClient):
    """Generic JSON client scoped to a selected project."""

    def __init__(
        self,
        base_url: str | None = None,
        project_id: str | None = None,
        timeout: float | None = 330.0,
        require_project: bool = True,
        *,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._local_tasks = base_url is None
        resolved_base_url = base_url
        resolved_project_id = project_id
        if project_id is None:
            config = get_config() if require_project else get_config_optional()
            resolved_base_url = base_url or config.api_base
            resolved_project_id = project_id or config.project_id
        elif base_url is None:
            resolved_base_url = get_api_base()
        assert resolved_base_url is not None
        assert resolved_project_id is not None
        super().__init__(
            resolved_base_url,
            resolved_project_id,
            timeout,
            transport=transport,
        )

    def request(
        self,
        method: str,
        path: str,
        *,
        project_scoped: bool = True,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Request a project-scoped API path, or a global path when requested."""
        if not path.startswith("/"):
            path = f"/{path}"
        url = self._url(path) if project_scoped else self._global_url(path)
        response = self._client.request(method, url, params=params, json=json)
        return self._handle_response(response)

    def create_task(self, data: dict[str, Any]) -> dict[str, Any]:
        """Create a task in the selected project (the Learn promotion seam)."""
        if not self._local_tasks:
            return self.request("POST", "/tasks", json=data)
        with tempfile.TemporaryDirectory(prefix="aico-task-") as directory:
            path = Path(directory) / "task.json"
            path.write_text(json_module.dumps({"tasks": [data]}), encoding="utf-8")
            try:
                result = _cli.run("tasks", "create", "--from-file", str(path), "-P", self.project_id)
            except OSError as exc:
                raise APIError(503, "Aico task command is unavailable") from exc
        if result.returncode != 0:
            raise APIError(400, result.stderr.strip() or "Aico could not create the task")
        for line in result.stdout.splitlines():
            if line.startswith("IMPORT:") and (task_id := line[7:].split("|", 1)[0]):
                return {**data, "id": task_id, "project_id": self.project_id}
        raise APIError(502, "Aico returned no created task identity")
