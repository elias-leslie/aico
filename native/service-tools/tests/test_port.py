"""Aico discovery, committed-source acceptance and service-set compatibility."""

from __future__ import annotations

import ast
import json
import subprocess
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest
from typer.testing import CliRunner

from aico_service.commands import service
from aico_service.lib import acceptance, coord, registry, service_ops, service_release


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, text=True, capture_output=True, check=True).stdout.strip()


@pytest.fixture
def repo(tmp_path):
    git(tmp_path, "init", "-q")
    git(tmp_path, "config", "user.name", "Service Tests")
    git(tmp_path, "config", "user.email", "service@example.invalid")
    (tmp_path / "app.py").write_text("value = 'accepted'\n")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-qm", "source")
    return tmp_path


@pytest.fixture
def accepted_cli(monkeypatch):
    calls = []

    class Work:
        def run(self, argv, *, cwd, check):
            calls.append(argv)
            commit = argv[argv.index("--sha") + 1]
            tree = git(cwd, "rev-parse", f"{commit}^{{tree}}")
            common = Path(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"))
            directory = common / "aico-checks/receipts"
            directory.mkdir(parents=True, exist_ok=True)
            (directory / f"accept-{tree}.json").write_text(json.dumps({
                "passed": True, "tree": tree, "sha": commit, "scope": None,
                "results": [{"id": "full", "required": True, "state": "pass"}], "ms": len(calls),
            }))
            return SimpleNamespace(returncode=0)

    @contextmanager
    def admitted(_label):
        yield Work()

    monkeypatch.setattr(acceptance, "heavy_work", admitted)
    return calls


def test_registered_roots_and_versioned_service_sets(monkeypatch, tmp_path):
    identity = {
        "project": {"id": "example"}, "runtime": {"infra": [], "backend_dir": "api"},
        "services": {"backend": "example-api", "frontend": "example-page.service",
                     "default_workers": ["required.timer"], "optional_workers": ["optional.service"],
                     "manual_workers": ["manual.service"]},
    }
    (tmp_path / "project.identity.json").write_text(json.dumps(identity))
    calls = []

    def run(argv, **_kwargs):
        calls.append(argv)
        value = [{"id": "example"}] if argv[2] == "list" else {"id": "example", "root_path": str(tmp_path)}
        return SimpleNamespace(returncode=0, stdout=json.dumps(value))

    monkeypatch.setattr(registry.subprocess, "run", run)
    monkeypatch.setenv("AICO_BIN", "/aico")
    assert service_ops.project_ids() == ["example"]
    project = service_ops.load_project("example")
    assert project.root == tmp_path
    assert project.backend_dir == tmp_path / "api"
    assert project.all_services == ("example-api", "example-page.service", "required.timer", "optional.service")
    assert project.manual_workers == ("manual.service",)
    assert calls == [["/aico", "projects", "list"], ["/aico", "projects", "show", "example"]]


@pytest.mark.parametrize("value", [{}, [], {"id": "different", "root_path": "/tmp"}, {"id": "example", "root_path": "relative"}])
def test_invalid_registry_does_not_fall_back_to_summitflow(monkeypatch, value):
    monkeypatch.setattr(registry, "query", lambda *_args: value)
    with pytest.raises(service_ops.ServiceError):
        service_ops.load_project("example")


def test_missing_unit_state_stays_unknown_without_network_fallback(monkeypatch, tmp_path):
    project = service_ops._project_from_identity({"services": {"backend": "api.service"}, "runtime": {}}, "example", tmp_path)
    monkeypatch.setattr(service_ops, "service_exists", lambda _unit: False)
    monkeypatch.setattr(service_ops.httpx, "get", lambda *_args, **_kwargs: pytest.fail("No runtime API fallback"))
    assert service_ops.observed_service_states(project) == {"api.service": "unknown"}


def test_status_mapping_never_opens_or_probes_registered_source(monkeypatch, tmp_path):
    forbidden = tmp_path / "source-must-stay-closed"
    monkeypatch.setitem(service_ops._SERVICE_POLICY, "status_projects", {
        "example": {"services": {"backend": "example-backend.service"}, "runtime": {"infra": []}},
    })
    monkeypatch.setattr(registry, "query", lambda *_args: {
        "id": "example", "root_path": str(forbidden), "backend_port": 7000,
    })
    monkeypatch.setattr(registry, "project_identity", lambda *_args: pytest.fail("Status opened source identity"))
    original_read = Path.read_text
    original_is_file = Path.is_file

    def closed_read(path, *args, **kwargs):
        assert not path.is_relative_to(forbidden), "Status read a source file"
        return original_read(path, *args, **kwargs)

    def closed_is_file(path, *args, **kwargs):
        assert not path.is_relative_to(forbidden), "Status probed a source file"
        return original_is_file(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", closed_read)
    monkeypatch.setattr(Path, "is_file", closed_is_file)
    monkeypatch.setattr(service_ops, "observed_service_states", lambda project: {
        unit: "active" for unit in project.all_services
    })
    monkeypatch.setattr(service_release, "current_release_commit", lambda _project: None)
    result = CliRunner().invoke(service.app, ["status", "example"])
    assert result.exit_code == 0, result.output
    assert "example-backend.service:active" in result.output


def test_acceptance_and_materialization_keep_the_started_head(repo, accepted_cli, monkeypatch, tmp_path):
    first = git(repo, "rev-parse", "HEAD")
    source = acceptance.accept_source(repo, first)
    (repo / "app.py").write_text("value = 'later'\n")
    git(repo, "commit", "-qam", "later")
    (repo / "app.py").write_text("value = 'uncommitted'\n")
    monkeypatch.setenv("SUMMITFLOW_SERVICE_STATE_ROOT", str(tmp_path.parent / "service-state"))
    release = service_release.prepare_release("example", repo, source)
    assert release.source.source_commit == first
    assert (release.source_root / "app.py").read_text() == "value = 'accepted'\n"
    assert all(call[call.index("--sha") + 1] == first for call in accepted_cli)
    assert Path(release.source.acceptance_artifact).is_file()


def test_explicit_receipt_cannot_replace_the_pinned_commit(repo, accepted_cli):
    first = git(repo, "rev-parse", "HEAD")
    source = acceptance.accept_source(repo, first)
    (repo / "app.py").write_text("value = 'next'\n")
    git(repo, "commit", "-qam", "next")
    with pytest.raises(acceptance.AcceptanceError, match="different source commit"):
        acceptance.validate_acceptance_receipt(repo, source, sha=git(repo, "rev-parse", "HEAD"))
    assert len(accepted_cli) == 1


def test_queued_acceptance_keeps_its_identity_when_aico_refreshes_the_tree_report(repo, accepted_cli):
    source = acceptance.accept_source(repo, "HEAD")
    report_path = Path(source["aico_acceptance_report"])
    report = json.loads(report_path.read_text())
    report["ms"] = 999
    report_path.write_text(json.dumps(report))
    # Aico's next invocation may reuse or refresh that pass. Its mutable cache
    # must not change the identity already stored in a detached job.
    result = acceptance.validate_acceptance_receipt(repo, source)
    assert result["acceptance_id"] == source["acceptance_id"]


def test_legacy_receipt_always_gets_aico_acceptance(repo, accepted_cli):
    commit = git(repo, "rev-parse", "HEAD")
    result = acceptance.validate_acceptance_receipt(repo, {"source": {"commit": commit}, "state": "success"})
    assert result["source_commit"] == commit
    assert result["coverage"] == "full"
    assert len(accepted_cli) == 1


def test_aico_failure_never_issues_release_evidence(repo, monkeypatch):
    @contextmanager
    def admitted(_label):
        yield SimpleNamespace(run=lambda *_args, **_kwargs: SimpleNamespace(returncode=2))

    monkeypatch.setattr(acceptance, "heavy_work", admitted)
    with pytest.raises(acceptance.AcceptanceError, match="exit 2"):
        acceptance.accept_source(repo, "HEAD")
    assert not (repo / ".git/aico-checks/service-acceptance").exists()


def test_acceptance_forwards_the_existing_holder_ack(repo, accepted_cli):
    with coord.acked("holder-answer"):
        acceptance.accept_source(repo, "HEAD")
    assert accepted_cli[0][-2:] == ["--with-ack", "holder-answer"]
    assert coord.current_ack() is None


@pytest.mark.parametrize("verb", ["result", "wait"])
def test_aico_jobs_return_unhandled_silently(verb):
    result = CliRunner().invoke(service.app, [verb, "aico-job-123"])
    assert result.exit_code == 3
    assert result.output == ""


@pytest.mark.parametrize("args", [
    ["rebuild", "--detach", "aico"],
    ["rebuild", "aico", "--scope", "frontend"],
    ["rebuild", "--scope", "frontend", "aico"],
    ["rebuild", "--detach"],
])
def test_aico_rebuild_hands_off_after_option_parsing_without_host_work(monkeypatch, args):
    monkeypatch.setenv("AICO_PROJECT_ID", "aico")
    monkeypatch.setattr(service, "_load", lambda *_args, **_kwargs: pytest.fail("Aico handoff performed host work"))
    result = CliRunner().invoke(service.app, args)
    assert result.exit_code == 3, result.output
    assert result.output == ""


def test_no_import_or_client_runtime_depends_on_summitflow():
    root = Path(__file__).parents[1] / "aico_service"
    for path in root.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.ImportFrom) and node.level == 0:
                assert (node.module or "").split(".")[0] not in {"app", "cli"}, path
            if isinstance(node, ast.Name):
                assert node.id not in {"STClient", "wait_for_summitflow_api"}, path
