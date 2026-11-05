"""Durable detached rebuild results and explicit backend feature selection."""

import json
import subprocess
from pathlib import Path

import pytest
from typer.testing import CliRunner

from aico_service.commands import service
from aico_service.lib import service_ops, service_release


@pytest.fixture
def jobs(tmp_path, monkeypatch):
    monkeypatch.setattr(service_ops, "get_repo_root", lambda: tmp_path)
    monkeypatch.setenv("SUMMITFLOW_SERVICE_STATE_ROOT", str(tmp_path / "service-state"))
    monkeypatch.setattr(service_ops, "systemctl", lambda *args: subprocess.CompletedProcess([], 0, "inactive\n", ""))
    monkeypatch.setattr(service_ops, "capture", lambda *args: subprocess.CompletedProcess([], 0, "queued\n", ""))
    return tmp_path / "service-state" / "jobs"


def queued_job(jobs):
    assert service_ops.queue_detached("example", False) == 0
    paths = list(jobs.glob("*.json"))
    assert len(paths) == 1
    return paths[0].stem


def test_queue_creates_durable_unique_result(jobs):
    identifier = queued_job(jobs)
    record = json.loads((jobs / f"{identifier}.json").read_text())
    assert record["state"] == "queued"
    assert record["exit_code"] is None
    assert record["command"] == ["st", "service", "rebuild", "example"]


def test_detached_rebuild_unit_has_memory_high_and_max_backstop(jobs, monkeypatch):
    calls = []
    monkeypatch.setattr(service_ops, "capture",
                        lambda argv: calls.append(argv) or subprocess.CompletedProcess([], 0, "", ""))
    queued_job(jobs)
    argv = calls[0]
    properties = [argv[index + 1] for index, value in enumerate(argv) if value == "-p"]
    assert properties == ["MemoryHigh=8G", "MemoryMax=12G"]
    assert argv.index("-p") < argv.index("st")


@pytest.mark.parametrize("name", ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"])
def test_detached_job_preserves_native_harness_identity(jobs, monkeypatch, name):
    for variable in ("ST_SESSION_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID", "CODEX_THREAD_ID"):
        monkeypatch.delenv(variable, raising=False)
    monkeypatch.setenv(name, "native-session-123")
    calls = []
    monkeypatch.setattr(service_ops, "capture", lambda argv: calls.append(argv) or subprocess.CompletedProcess([], 0, "", ""))
    queued_job(jobs)
    argv = calls[0]
    forwarded = [argv[index + 1] for index, value in enumerate(argv) if value == "--setenv"]
    assert f"{name}=native-session-123" in forwarded


def test_detached_job_binds_accepted_source_and_verified_deployment(jobs, monkeypatch):
    source = {
        "acceptance_id": "acceptance-1",
        "acceptance_artifact": "/stable/acceptance-1.json",
        "source_commit": "c" * 40,
        "source_tree": "d" * 40,
    }
    assert service_ops.queue_detached("example", False, accepted_source=source) == 0
    path = next(jobs.glob("*.json"))
    identifier = path.stem
    queued = json.loads(path.read_text())
    assert queued["source"]["source_commit"] == "c" * 40
    assert queued["command"] == [
        "st",
        "service",
        "rebuild",
        "--acceptance",
        "/stable/acceptance-1.json",
        "example",
    ]

    def run(command, **kwargs):
        assert command == queued["command"]
        result_path = kwargs["env"]["SUMMITFLOW_DEPLOYMENT_RESULT"]
        Path(result_path).write_text("{}")
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(service_ops.subprocess, "run", run)
    monkeypatch.setattr(
        service_release,
        "validate_deployment_receipt",
        lambda _path: {
            "state": "succeeded",
            "artifact": "/stable/deployment.json",
            "build_id": "build-1",
            "acceptance_id": "acceptance-1",
            "source_commit": "c" * 40,
            "source_tree": "d" * 40,
        },
    )
    assert service_ops.run_detached_job(identifier) == 0
    completed = service_ops.detached_result(identifier)
    assert completed["state"] == "succeeded"
    assert completed["deployment"]["build_id"] == "build-1"
    assert completed["deployment"]["artifact"] == "/stable/deployment.json"


@pytest.mark.parametrize("code,state", [(0, "succeeded"), (7, "failed")])
def test_runner_persists_actual_result_after_unit_collection(jobs, monkeypatch, code, state):
    identifier = queued_job(jobs)
    monkeypatch.setattr(service_ops.subprocess, "run", lambda *args, **kwargs: subprocess.CompletedProcess([], code))
    assert service_ops.run_detached_job(identifier) == code
    result = service_ops.detached_result(identifier)
    assert result["state"] == state
    assert result["exit_code"] == code


def test_missing_unit_without_terminal_result_is_interrupted(jobs):
    identifier = queued_job(jobs)
    result = service_ops.detached_result(identifier)
    assert result["state"] == "interrupted"
    assert result["exit_code"] is None


def test_unavailable_systemd_is_unknown(jobs, monkeypatch):
    identifier = queued_job(jobs)
    monkeypatch.setattr(service_ops, "systemctl", lambda *args: subprocess.CompletedProcess([], 1, "", "bus unavailable"))
    assert service_ops.detached_result(identifier)["state"] == "unknown"


def test_reused_unit_does_not_hide_interrupted_job(jobs, monkeypatch):
    identifier = queued_job(jobs)
    path = jobs / f"{identifier}.json"
    record = json.loads(path.read_text())
    record.update(state="running", invocation_id="old")
    path.write_text(json.dumps(record))
    monkeypatch.setattr(service_ops, "systemctl", lambda *args: subprocess.CompletedProcess([], 0, "ActiveState=active\nInvocationID=new\nLoadState=loaded\n", ""))
    assert service_ops.detached_result(identifier)["state"] == "interrupted"


def test_result_rejects_path_traversal(jobs):
    with pytest.raises(service_ops.ServiceError):
        service_ops.detached_result("../other")


def test_wait_returns_terminal_failure_code(monkeypatch):
    monkeypatch.setattr(service_ops, "detached_result", lambda _: {"job_id": "fixture", "state": "failed", "exit_code": 7})
    result = CliRunner().invoke(service.app, ["wait", "fixture"])
    assert result.exit_code == 7, result.output


def test_wait_omits_embedded_receipt_and_shows_failure_log_tail(monkeypatch, tmp_path):
    log = tmp_path / "job.log"
    log.write_text("\n".join(f"line {index}" for index in range(20)))
    record = {"job_id": "fixture", "state": "failed", "exit_code": 1, "log_path": str(log),
              "source": {"acceptance_id": "a1", "checks": [{"detail": "x" * 10000}]}}
    monkeypatch.setattr(service_ops, "detached_result", lambda _: record)
    result = CliRunner().invoke(service.app, ["wait", "fixture"])
    payload = json.loads(result.output)
    assert payload["source"] == {"acceptance_id": "a1"}
    assert payload["log_tail"] == [f"line {index}" for index in range(12, 20)]


def test_wait_prints_one_summary_line_in_compact_mode(monkeypatch, tmp_path):
    from st_sdk.state import set_compact_output

    log = tmp_path / "job.log"
    log.write_text("ok\nboom")
    record = {"job_id": "fixture", "project": "example", "state": "failed", "exit_code": 1, "log_path": str(log),
              "source": {"source_commit": "abcdef1234567890", "checks": [{"detail": "x" * 10000}]},
              "deployment": {"state": "failed"}}
    monkeypatch.setattr(service_ops, "detached_result", lambda _: record)
    set_compact_output(True)
    try:
        result = CliRunner().invoke(service.app, ["wait", "fixture"])
    finally:
        set_compact_output(False)
    assert result.exit_code == 1
    assert result.output.splitlines() == [
        f"JOB:fixture|example|failed|exit=1|commit=abcdef123456|deploy=failed|log={log}", "  ok", "  boom",
    ]
