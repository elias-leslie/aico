"""Deploy through a pinned source mirror and the per-user deploy gate."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from aico_service.lib import service_ops


@pytest.fixture
def project(tmp_path: Path) -> service_ops.ProjectServices:
    return service_ops.ProjectServices(
        project_id="example", root=tmp_path / "checkout", backend_service="backend.service",
        frontend_service="frontend.service", default_workers=(), optional_workers=(),
        backend_port=8001, frontend_port=3001, backend_dir=tmp_path / "backend",
        frontend_dir=tmp_path / "frontend", health_endpoint="/health",
        runtime_user="svc",
    )


def _git(*args: str, cwd: Path) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def _identity(project):
    return {"project": {"id": project.project_id}, "runtime": {
        "runtime_user": project.runtime_user, "backend_port": project.backend_port,
        "frontend_port": project.frontend_port, "backend_dir": "api", "frontend_dir": "web",
        "health_endpoint": "/ready", "backend_extras": ["runtime"], "infra": [],
    }, "services": {"backend": project.backend_service, "frontend": project.frontend_service,
                    "default_workers": list(project.default_workers), "optional_workers": list(project.optional_workers)}}


def _source_repo(tmp_path, identity):
    work = tmp_path / "work"
    work.mkdir()
    _git("init", "-q", "-b", "main", cwd=work)
    _git("config", "user.email", "t@example.test", cwd=work)
    _git("config", "user.name", "t", cwd=work)
    (work / "project.identity.json").write_text(json.dumps(identity))
    _git("add", ".", cwd=work)
    _git("commit", "-qm", "identity", cwd=work)
    return work, _git("rev-parse", "HEAD", cwd=work)


def test_source_repo_is_checked_out_at_the_pinned_commit(project, tmp_path, monkeypatch):
    monkeypatch.setenv("SUMMITFLOW_SERVICE_STATE_ROOT", str(tmp_path / "state"))
    work = tmp_path / "work"
    work.mkdir()
    _git("init", "-q", "-b", "main", cwd=work)
    _git("config", "user.email", "t@example.test", cwd=work)
    _git("config", "user.name", "t", cwd=work)
    (work / "project.identity.json").write_text(json.dumps(_identity(project)))
    (work / "file").write_text("one")
    _git("add", ".", cwd=work)
    _git("commit", "-qm", "one", cwd=work)
    first = _git("rev-parse", "HEAD", cwd=work)
    (work / "file").write_text("two")
    later_identity = _identity(project)
    later_identity["runtime"]["health_endpoint"] = "/later"
    (work / "project.identity.json").write_text(json.dumps(later_identity))
    _git("commit", "-qam", "two", cwd=work)
    mirror = tmp_path / "mirror.git"
    _git("clone", "-q", "--bare", str(work), str(mirror), cwd=tmp_path)

    pinned = service_ops.use_source_repo(project, mirror, first)

    assert pinned.git_root == pinned.source_repo != project.root
    assert pinned.source_sha == first
    assert (pinned.git_root / "file").read_text() == "one"
    assert pinned.backend_dir == project.root / "api"
    assert pinned.frontend_dir == project.root / "web"
    assert pinned.health_endpoint == "/ready"
    assert pinned.backend_extras == ("runtime",)
    assert pinned.infra == ()
    # Running again (a later deploy) reuses the clone and moves it to the new pin.
    second = _git("rev-parse", "HEAD", cwd=work)
    again = service_ops.use_source_repo(project, mirror, second)
    assert (again.git_root / "file").read_text() == "two"
    assert again.health_endpoint == "/later"
    assert project.git_root == project.root


@pytest.mark.parametrize(("section", "field", "value"), [
    ("project", "id", "other"), ("project", "id", ""),
    ("runtime", "runtime_user", "owner"), ("runtime", "runtime_user", "broker"),
    ("runtime", "runtime_user", ""), ("runtime", "backend_port", 9999),
    ("runtime", "runtime_user", []), ("runtime", "backend_port", True),
    ("runtime", "frontend_port", "3001"), ("runtime", "backend_dir", "../outside"),
    ("runtime", "deployment", {}), ("runtime", "deployment", {"kind": "unknown"}),
    ("runtime", "deployment", {"kind": "proxmox", "ssh_host": "example-pve", "vmid": 456, "manager": "system"}),
    ("runtime", "frontend_dir", "/outside"), ("services", "backend", "foreign.service"),
    ("services", "frontend", "foreign.service"),
    ("services", "default_workers", ["foreign.service"]),
    ("services", "optional_workers", ["foreign.service"]),
    ("services", "manual_workers", ["foreign.service"]),
])
def test_source_repo_rejects_identity_outside_the_admitted_request(project, tmp_path, monkeypatch,
                                                                 section, field, value):
    monkeypatch.setenv("SUMMITFLOW_SERVICE_STATE_ROOT", str(tmp_path / "state"))
    identity = _identity(project)
    identity[section][field] = value
    repo, sha = _source_repo(tmp_path, identity)
    with pytest.raises(service_ops.ServiceError, match="identity"):
        service_ops.use_source_repo(project, repo, sha)


def test_retired_monitor_is_not_carried_into_service_rebuild_workers(tmp_path):
    identity = {"project": {"id": "summitflow"}, "runtime": {}, "services": {
        "backend": "summitflow-backend.service", "default_workers": ["summitflow-host-monitor.service", "kept.service"]}}
    project = service_ops._project_from_identity(identity, "summitflow", tmp_path)
    assert project.default_workers == ("kept.service",)


def test_unset_infrastructure_does_not_require_the_retired_shared_stack(tmp_path, monkeypatch):
    project = service_ops._project_from_identity({"project": {"id": "example"}}, "example", tmp_path)
    assert project.infra == ()
    monkeypatch.setattr(service_ops, "capture", lambda *_a, **_k: pytest.fail("undeclared infrastructure probe"))
    monkeypatch.setattr(service_ops.httpx, "get", lambda *_a, **_k: pytest.fail("undeclared Hatchet probe"))
    assert service_ops.ensure_infra(project) == 0
