"""Root ownership contract; every runtime fixture is isolated and unauthenticated."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import cast
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from a_term.api.root_control import router
from a_term.cli.root_launch import PROMPT_ENV
from a_term.services import agent_service, lifecycle
from a_term.services import root_workloads as roots
from a_term.storage import root_requests

THREAD_ID = "019a63b8-1234-789a-bcde-0123456789ab"


@pytest.fixture
def request_body(tmp_path):
    return {"requestId": "request-1", "tool": "codex", "projectId": "fixture",
            "projectRoot": str(tmp_path), "initialPrompt": "Fixture instruction",
            "role": "any-tool-neutral-role", "leadRootReference": "lead-root",
            "facetCapsuleRef": "capsule-1"}


@pytest.fixture
def owner(monkeypatch, request_body):
    rows, session_rows = {}, {}
    def reserve(request, digest, mode):
        key = request["requestId"]
        if key not in rows:
            rows[key] = {"request_id": key, "digest": digest, "session_id": str(uuid4()),
                         "pane_id": str(uuid4()), "logical_session_id": f"a-term-root-{uuid4()}",
                         "role": request["role"], "lead_root_reference": request["leadRootReference"],
                         "facet_capsule_ref": request["facetCapsuleRef"],
                         "launch_state": "reserved", "generation": None}
            session_rows[rows[key]["session_id"]] = {"mode": mode, "is_root": True}
        return dict(rows[key])
    def claim(key):
        if rows[key]["launch_state"] != "reserved":
            return False
        rows[key]["launch_state"] = "attempted"
        return True
    def observe(key, generation, process_pid, process_start_ticks):
        rows[key].update(generation=generation, launch_state="observed",
                         process_pid=process_pid, process_start_ticks=process_start_ticks)
        return True
    monkeypatch.setattr(root_requests, "get", lambda key: dict(rows[key]) if key in rows else None)
    monkeypatch.setattr(root_requests, "reserve", reserve)
    monkeypatch.setattr(root_requests, "claim_launch", claim)
    monkeypatch.setattr(root_requests, "observe", observe)
    monkeypatch.setattr(root_requests, "retire", lambda root: rows[root["request_id"]].update(launch_state="ended"))
    monkeypatch.setattr(root_requests, "list_all", lambda: list(rows.values()))
    monkeypatch.setattr(roots.sessions, "get_session", session_rows.get)
    monkeypatch.setattr(roots.sessions, "update_claude_state", MagicMock())
    def rename(key, session_id, generation, name):
        root = rows[key]
        if (root["session_id"] != session_id or root["generation"] != generation
                or root["launch_state"] != "observed" or session_id not in session_rows):
            return False
        session_rows[session_id]["name"] = name
        return True
    monkeypatch.setattr(roots.sessions, "update_root_name", MagicMock(side_effect=rename))
    monkeypatch.setattr(roots, "launch_argv", lambda _: ("codex", ["codex"]))
    launcher = MagicMock()
    monkeypatch.setattr(roots, "launch", launcher)
    monkeypatch.setattr(roots, "_identity", lambda _: ("running", "a" * 64,
                        ["1", "/fixture", "1", "$1", "%1", "123", "0", "1", "1", "100"]))
    return rows, session_rows, launcher


def test_replay_conflict_role_refs_and_prompt_non_persistence(owner, request_body):
    rows, _, launcher = owner
    first = roots.create(request_body)
    assert roots.create(dict(request_body)) == first
    launcher.assert_called_once()
    assert first["owner"] == "a-term"
    assert first["logicalSessionId"].startswith("a-term-root-")
    assert first["role"] == request_body["role"]
    assert first["leadRootReference"] == "lead-root"
    assert first["facetCapsuleRef"] == "capsule-1"
    assert request_body["initialPrompt"] not in json.dumps(rows)
    for field, value in [("initialPrompt", "changed"), ("role", "different-role"),
                         ("leadRootReference", None), ("facetCapsuleRef", "different"),
                         ("tool", "claude-code"), ("projectId", "different"),
                         ("projectRoot", request_body["projectRoot"] + "/different")]:
        with pytest.raises(roots.RootError, match="request_conflict"):
            roots.create({**request_body, field: value})
    launcher.assert_called_once()


def test_ambiguous_launch_is_retained_without_retry(owner, request_body, monkeypatch):
    _, _, launcher = owner
    launcher.side_effect = subprocess.TimeoutExpired("redacted", 10)
    monkeypatch.setattr(roots, "_identity", lambda _: ("absent", None, []))
    first = roots.create(request_body)
    assert first["status"] == "uncertain" and first["generation"] is None
    assert roots.create(request_body) == first
    launcher.assert_called_once()


def test_ended_root_and_changed_generation_never_relaunch(owner, request_body, monkeypatch):
    _, sessions, launcher = owner
    first = roots.create(request_body)
    monkeypatch.setattr(roots, "_identity", lambda _: ("running", "b" * 64, []))
    assert roots.create(request_body)["status"] == "uncertain"
    assert roots.get(request_body["requestId"])["generation"] is None
    sessions.clear()
    monkeypatch.setattr(roots, "_identity", lambda _: ("absent", None, []))
    monkeypatch.setattr(roots, "process_identity", lambda _: ("gone", ""))
    ended = roots.create(request_body)
    assert ended["status"] == "ended" and ended["generation"] is None
    assert ended["hostIdentity"] == first["hostIdentity"]
    assert roots.get(request_body["requestId"]) == ended
    launcher.assert_called_once()


def test_reserved_recovery_launches_once_with_same_transient_prompt(owner, request_body):
    root_requests.reserve(request_body, roots.request_digest(request_body), "codex")
    descriptor = roots.create(request_body)
    assert descriptor["status"] == "running"
    owner[2].assert_called_once()


def test_socket_loss_retains_live_or_unknown_process(owner, request_body, monkeypatch):
    roots.create(request_body)
    monkeypatch.setattr(roots, "_identity", lambda _: ("absent", None, []))
    monkeypatch.setattr(roots, "process_identity", lambda _: ("S", "100"))
    assert roots.get("request-1")["status"] == "uncertain"
    monkeypatch.setattr(roots, "process_identity", lambda _: None)
    assert roots.get("request-1")["status"] == "uncertain"
    monkeypatch.setattr(roots, "process_identity", lambda _: ("gone", ""))
    assert roots.get("request-1")["status"] == "ended"


def test_end_fences_generation_retains_uncertainty_and_never_recreates(owner, request_body, monkeypatch):
    first = roots.create(request_body)
    end = MagicMock(return_value=False)
    monkeypatch.setattr(roots, "end_exact", end)
    with pytest.raises(roots.RootError, match="stale_generation"):
        roots.mutate("request-1", "end", {"generation": "b" * 64})
    end.assert_not_called()
    with pytest.raises(roots.RootError, match="close_uncertain"):
        roots.mutate("request-1", "end", {"generation": first["generation"]})
    assert roots.get("request-1")["status"] == "running"
    end.return_value = True
    ended = roots.mutate("request-1", "end", {"generation": first["generation"]})
    assert ended["status"] == "ended" and ended["generation"] is None
    assert roots.create(request_body) == ended
    assert roots.mutate("request-1", "end", {"generation": first["generation"]}) == ended
    owner[2].assert_called_once()


def test_show_generation_fence_and_capability_failures(owner, request_body, monkeypatch):
    first = roots.create(request_body)
    attach = MagicMock(return_value={"is_detached": False})
    monkeypatch.setattr(roots.panes, "get_pane", lambda _: {"is_detached": True})
    monkeypatch.setattr(roots.panes, "attach_pane", attach)
    with pytest.raises(roots.RootError, match="stale_generation"):
        roots.mutate("request-1", "show", {"generation": "b" * 64})
    attach.assert_not_called()
    assert roots.mutate("request-1", "show", {"generation": first["generation"]})["hostIdentity"] == first["hostIdentity"]
    attach.assert_called_once()
    with pytest.raises(roots.RootError, match="position_unavailable"):
        roots.mutate("request-1", "position", {"generation": first["generation"], "bounds": {}})
    with pytest.raises(roots.RootError, match="directed_delivery_unavailable"):
        roots.mutate("request-1", "send", None)
    assert first["directedDelivery"]["available"] is False


def test_http_contract_and_body_limits(owner, request_body):
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        assert client.post("/v1/roots", json=request_body).status_code == 200
        assert client.get("/v1/roots").json()["roots"][0]["requestId"] == "request-1"
        assert client.get("/v1/roots/request-1").status_code == 200
        assert client.post("/v1/roots/request-1/send", content=b"not a message").status_code == 503
        assert client.post("/v1/roots", content=b"x" * (128 * 1024 + 1)).status_code == 400
        assert client.post("/v1/roots", json={**request_body, "unexpected": "field"}).status_code == 400
        assert client.post("/v1/roots", content=json.dumps(request_body),
                           headers={"content-type": "text/plain"}).status_code == 400
        assert client.post("/v1/roots", json=request_body,
                           headers={"origin": "https://untrusted.invalid"}).status_code == 403
    with TestClient(app, client=("192.0.2.1", 1234)) as client:
        assert client.post("/v1/roots", json=request_body).status_code == 403


def test_title_updates_only_exact_session_name_with_content_free_receipt(owner, request_body):
    descriptor = roots.create(request_body)
    other = roots.create({**request_body, "requestId": "other-root"})
    label = "Project · Focus 🐾"
    result = roots.mutate("request-1", "title", {"generation": descriptor["generation"], "label": f"  {label}  "})
    assert result == descriptor
    assert owner[1][descriptor["hostIdentity"]]["name"] == label
    assert "name" not in owner[1][other["hostIdentity"]]
    assert label not in json.dumps(owner[0]) and label not in json.dumps(result)
    cast(MagicMock, roots.sessions.update_root_name).assert_called_once_with("request-1", descriptor["hostIdentity"], descriptor["generation"], label)
    assert roots.create(request_body) == descriptor


@pytest.mark.parametrize("label", [None, [], "", " ", "x" * 161, "🐾" * 41,
    "\ud800", "Focus\nNext", "Focus\rNext", "Focus\tNext", "Focus\x1b[31m",
    "Focus\x00", "Focus\x7f", "Focus\u2028Next", "Focus\u2029Next"])
def test_title_rejects_unbounded_or_control_label_before_mutation(owner, request_body, label):
    first = roots.create(request_body)
    with pytest.raises(roots.RootError, match="invalid_body") as error:
        roots.mutate("request-1", "title", {"generation": first["generation"], "label": label})
    assert error.value.status == 400
    cast(MagicMock, roots.sessions.update_root_name).assert_not_called()


def test_title_generation_ended_and_storage_race_fail_closed(owner, request_body, monkeypatch):
    first = roots.create(request_body)
    value = {"generation": first["generation"], "label": "Focus"}
    with pytest.raises(roots.RootError, match="stale_generation"):
        roots.mutate("request-1", "title", {**value, "generation": "b" * 64})
    cast(MagicMock, roots.sessions.update_root_name).assert_not_called()
    monkeypatch.setattr(roots.sessions, "update_root_name", lambda *_: False)
    with pytest.raises(roots.RootError, match="workload_unavailable"):
        roots.mutate("request-1", "title", value)
    root_requests.retire(owner[0]["request-1"])
    with pytest.raises(roots.RootError, match="ended") as error:
        roots.mutate("request-1", "title", value)
    assert error.value.status == 410


@pytest.mark.parametrize("label,expected", [("\nFocus\r", "Focus"), ("Project\u00a0Focus", "Project\u00a0Focus"),
    ("Focus\u202eNext", "Focus\u202eNext"), ("🐾" * 40, "🐾" * 40)])
def test_title_unicode_contract_matches_aico(label, expected):
    assert roots.parse_label(label) == expected


def test_title_http_contract_and_root_marker(owner, request_body):
    from a_term.api.models.pane_responses import SessionInPaneResponse
    from a_term.api.sessions import ATermSessionResponse

    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        first = client.post("/v1/roots", json=request_body).json()
        body = {"generation": first["generation"], "label": "é" * 80}
        success = client.post("/v1/roots/request-1/title", json=body)
        assert success.status_code == 200 and success.json() == first
        assert body["label"] not in success.text
        for invalid in [{**body, "extra": "field"}, {"generation": body["generation"]},
                        {**body, "generation": "wrong"}, {**body, "label": "é" * 81}]:
            response = client.post("/v1/roots/request-1/title", json=invalid)
            assert response.status_code == 400 and response.json() == {"error": "invalid_body"}
        assert client.post("/v1/roots/missing/title", json=body).status_code == 404
        assert client.post("/v1/roots/request-1/title", json=body, headers={"origin": "https://untrusted.invalid"}).status_code == 403
    session = {"id": first["hostIdentity"], "name": "Focus", "is_root": True,
               "mode": "codex", "session_number": 1, "is_alive": True, "working_dir": "/fixture",
               "user_id": None, "project_id": "fixture", "display_order": 0,
               "created_at": None, "last_accessed_at": None}
    assert SessionInPaneResponse.model_validate(session).is_root is True
    assert ATermSessionResponse.model_validate(session).is_root is True


@pytest.mark.parametrize("field,value", [("initialPrompt", "\0"), ("initialPrompt", " "),
    ("initialPrompt", "x" * (64 * 1024 + 1)), ("projectRoot", "/tmp/../tmp"),
    ("role", "-invalid"), ("projectId", "a" * 65), ("tool", "shell"), ("tool", []),
    ("leadRootReference", "bad/ref"), ("facetCapsuleRef", {}), ("initialPrompt", "\ud800")])
def test_create_validation(request_body, field, value):
    with pytest.raises(roots.RootError, match="invalid_body"):
        roots.parse_create({**request_body, field: value})


def test_digest_matches_aico_canonical_array(request_body):
    parsed = roots.parse_create(request_body)
    content = json.dumps([parsed[k] for k in ("tool", "projectId", "projectRoot", "initialPrompt", "role",
                            "leadRootReference", "facetCapsuleRef")], separators=(",", ":"))
    assert roots.request_digest(parsed) == hashlib.sha256(content.encode()).hexdigest()
    assert roots.request_digest({**parsed, "requestId": "different"}) == roots.request_digest(parsed)


def test_resume_digest_is_canonical_and_preserves_fresh_receipts(request_body):
    fresh = roots.parse_create(request_body)
    resumed = roots.parse_create({**request_body, "resumeSessionId": THREAD_ID})
    content = json.dumps([resumed[k] for k in ("tool", "projectId", "projectRoot", "initialPrompt", "role",
                            "leadRootReference", "facetCapsuleRef", "resumeSessionId")], separators=(",", ":"))
    assert roots.request_digest(resumed) == hashlib.sha256(content.encode()).hexdigest()
    assert roots.request_digest(resumed) != roots.request_digest(fresh)
    assert roots.request_digest(roots.parse_create({**request_body, "resumeSessionId": None})) == roots.request_digest(fresh)


def test_resume_http_replay_and_conflict_are_content_free(owner, request_body):
    request = {**request_body, "resumeSessionId": THREAD_ID}
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        first = client.post("/v1/roots", json=request)
        assert first.status_code == 200
        assert client.post("/v1/roots", json=request).json() == first.json()
        for changed in [{**request, "resumeSessionId": "019a63b8-1234-789a-bcde-0123456789ac"}, request_body]:
            response = client.post("/v1/roots", json=changed)
            assert response.status_code == 409
            assert response.json() == {"error": "request_conflict"}
        assert THREAD_ID not in first.text
        assert request["initialPrompt"] not in first.text
    assert THREAD_ID not in json.dumps(owner[0])
    owner[2].assert_called_once()


@pytest.mark.parametrize("resume_thread", ["", "latest", "--last", "thread-name", THREAD_ID.upper(),
    THREAD_ID.replace("-", ""), " " + THREAD_ID, THREAD_ID + "\n", THREAD_ID + ";", 123, [], {}])
def test_resume_rejects_malformed_before_allocation(owner, request_body, resume_thread):
    with pytest.raises(roots.RootError, match="invalid_body") as error:
        roots.create({**request_body, "resumeSessionId": resume_thread})
    assert error.value.status == 400
    assert not owner[0] and not owner[1]
    owner[2].assert_not_called()


def test_resume_rejects_unsupported_tools_and_requires_prompt_before_allocation(owner, request_body):
    request = {**request_body, "resumeSessionId": THREAD_ID}
    for invalid in [{**request, "tool": "claude-code"}, {**request, "tool": "antigravity"},
                    {**request, "initialPrompt": ""},
                    {key: value for key, value in request.items() if key != "initialPrompt"}]:
        with pytest.raises(roots.RootError, match="invalid_body"):
            roots.create(invalid)
    assert not owner[0] and not owner[1]
    owner[2].assert_not_called()


def test_resume_requires_registered_tool_adapter_before_allocation(owner, request_body, monkeypatch):
    monkeypatch.setattr(roots, "_RESUME_ADAPTERS", {})
    with pytest.raises(roots.RootError, match="invalid_body"):
        roots.create({**request_body, "resumeSessionId": THREAD_ID})
    assert not owner[0] and not owner[1]
    owner[2].assert_not_called()


def test_resume_rejects_tool_specific_wire_field_before_allocation(owner, request_body):
    with pytest.raises(roots.RootError, match="invalid_body"):
        roots.create({**request_body, "resumeThreadId": THREAD_ID})
    assert not owner[0] and not owner[1]
    owner[2].assert_not_called()


def test_resume_reserved_recovery_and_tombstone_never_relaunch(owner, request_body):
    request = roots.parse_create({**request_body, "resumeSessionId": THREAD_ID})
    root_requests.reserve(request, roots.request_digest(request), "codex")
    first = roots.create(request)
    assert first["status"] == "running"
    assert roots.create(request) == first
    root_requests.retire(owner[0][request["requestId"]])
    assert roots.create(request)["status"] == "ended"
    owner[2].assert_called_once()


def test_resume_ambiguous_launch_never_retries(owner, request_body, monkeypatch):
    request = {**request_body, "resumeSessionId": THREAD_ID}
    owner[2].side_effect = subprocess.TimeoutExpired("redacted", 10)
    monkeypatch.setattr(roots, "_identity", lambda _: ("absent", None, []))
    first = roots.create(request)
    assert first["status"] == "uncertain"
    assert roots.create(request) == first
    owner[2].assert_called_once()


def test_resume_launch_argv_uses_exact_thread_and_configured_native_binary(request_body, monkeypatch):
    monkeypatch.setattr(roots.shutil, "which", lambda _: "/fixture/codex")
    monkeypatch.setattr(roots.agent_tools, "get_by_slug", lambda _: {"enabled": True, "command": "/fixture/codex"})
    request = roots.parse_create({**request_body, "resumeSessionId": THREAD_ID})
    assert roots.launch_argv(request) == ("codex", ["/fixture/codex", "resume", THREAD_ID])


@pytest.mark.parametrize("command", ["claude", "claude --dangerously-skip-permissions"])
def test_null_resume_keeps_fresh_claude_launch(request_body, monkeypatch, command):
    monkeypatch.setattr(roots.shutil, "which", lambda _: "/fixture/claude")
    monkeypatch.setattr(roots.agent_tools, "get_by_slug", lambda _: {"enabled": True, "command": command})
    request = roots.parse_create({**request_body, "tool": "claude-code", "resumeSessionId": None})
    assert roots.launch_argv(request) == ("claude", command.split())


def test_root_guards_never_resurrect_reset_or_send_keys(monkeypatch):
    monkeypatch.setattr(lifecycle.a_term_store, "get_session", lambda _: {"is_root": True})
    monkeypatch.setattr(root_requests, "for_session", lambda _: {"request_id": "fixture"})
    monkeypatch.setattr(roots, "describe", lambda _: {"status": "uncertain"})
    with patch.object(lifecycle, "create_tmux_session") as create_tmux:
        assert lifecycle.ensure_session_alive("fixture") is False
        assert lifecycle.reset_session("fixture") is None
        assert agent_service.ensure_agent_running_sync("fixture") is False
    create_tmux.assert_not_called()


@pytest.mark.parametrize("resume_thread", [None, THREAD_ID])
def test_launch_configuration_rejects_disabled_missing_and_shell_wrappers(request_body, monkeypatch, resume_thread):
    request_body = roots.parse_create({**request_body, "resumeSessionId": resume_thread})
    monkeypatch.setattr(roots.shutil, "which", lambda _: "/fixture/codex")
    for tool in [None, {"enabled": False}, {"enabled": True, "command": "bash -c codex"},
                 {"enabled": True, "command": "codex ; echo unsafe"},
                 {"enabled": True, "command": "codex resume"}]:
        monkeypatch.setattr(roots.agent_tools, "get_by_slug", lambda _, tool=tool: tool)
        with pytest.raises(roots.RootError, match="launch_unavailable"):
            roots.launch_argv(request_body)
    monkeypatch.setattr(roots.agent_tools, "get_by_slug", lambda _: {"enabled": True, "command": "codex"})
    tail = ["resume", resume_thread] if resume_thread else []
    assert roots.launch_argv(request_body) == ("codex", ["codex", *tail])


@pytest.mark.parametrize("resume_thread", [None, THREAD_ID])
def test_reservation_sql_never_receives_prompt_or_resume_uuid(request_body, resume_thread):
    request_body = roots.parse_create({**request_body, "resumeSessionId": resume_thread})
    row = {"request_id": "request-1", "session_id": uuid4(), "pane_id": uuid4()}
    conn = MagicMock()
    cur = conn.cursor.return_value.__enter__.return_value
    cur.fetchone.return_value = row
    with patch.object(root_requests, "get_connection") as connection:
        connection.return_value.__enter__.return_value = conn
        root_requests.reserve(request_body, roots.request_digest(request_body), "codex")
    assert request_body["initialPrompt"] not in repr(cur.execute.call_args_list)
    assert THREAD_ID not in repr(cur.execute.call_args_list)
    assert "ON CONFLICT (request_id) DO NOTHING" in cur.execute.call_args_list[0].args[0]
    conn.commit.assert_called_once()


def test_migration_receipts_survive_deletion_and_follow_verified_head():
    path = Path(__file__).parents[1] / "alembic/versions/e92a6d4b8c10_add_root_requests.py"
    spec = importlib.util.spec_from_file_location("root_migration", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.down_revision == "d71b3e920c64"
    with patch.object(module.op, "execute") as execute:
        module.upgrade()
    sql = execute.call_args.args[0]
    assert "REFERENCES" not in sql and "initial_prompt" not in sql
    assert "session_id UUID NOT NULL UNIQUE" in sql


@pytest.mark.parametrize("prompt", ["line one\nline two", "quotes ' and \"", "--leading-option",
    "$(touch SHOULD_NOT_EXIST) `touch SHOULD_NOT_EXIST`", "ESC\x1b\tTAB", ";", "unicode é 🐾"])
@pytest.mark.parametrize("resume_thread", [None, THREAD_ID])
def test_initial_launch_exact_argv_in_private_tmux(tmp_path, monkeypatch, prompt, resume_thread):
    if shutil.which("tmux") is None:
        pytest.skip("tmux is unavailable")
    socket = f"a-term-root-test-{uuid4().hex}"
    output = tmp_path / "receipt.json"
    fixture = tmp_path / "fixture.py"
    fixture.write_text(
        "import json, os, pathlib, sys, time\n"
        f"pathlib.Path({str(output)!r}).write_text(json.dumps({{'argv': sys.argv[1:], "
        f"'logical': os.getenv('ST_SESSION_ID'), 'prompt_env': os.getenv({PROMPT_ENV!r}), "
        "'secret': os.getenv('DATABASE_URL')}))\n"
        "time.sleep(20)\n"
    )
    run = subprocess.run
    def private_run(args, **kwargs):
        return run([args[0], "-L", socket, *args[1:]], **kwargs) if args[0] == "tmux" else run(args, **kwargs)
    monkeypatch.setattr(roots.subprocess, "run", private_run)
    monkeypatch.setattr(roots, "_can_spawn_tmux_scope", lambda: False)
    monkeypatch.setattr(roots, "_apply_session_options", lambda _: None)
    monkeypatch.setenv("ST_SESSION_ID", "center-must-not-leak")
    monkeypatch.setenv("DATABASE_URL", "fixture-secret")
    root = {"session_id": str(uuid4()), "logical_session_id": "isolated-logical"}
    request = {"projectRoot": str(tmp_path), "initialPrompt": prompt}
    tail = ["resume", resume_thread] if resume_thread else []
    try:
        roots.launch(root, request, [sys.executable, str(fixture), *tail])
        deadline = time.monotonic() + 5
        while not output.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        receipt = json.loads(output.read_text())
        assert receipt == {"argv": [*tail, "--", prompt], "logical": "isolated-logical", "prompt_env": None, "secret": None}
        assert not (tmp_path / "SHOULD_NOT_EXIST").exists()
        assert roots.probe(root["session_id"])[0] == "running"
        env = private_run(["tmux", "show-environment", "-t", roots.get_tmux_session_name(root["session_id"])],
                          capture_output=True, text=True)
        assert f"{PROMPT_ENV}=" not in env.stdout
        start = private_run(["tmux", "display-message", "-p", "-t", roots.get_tmux_session_name(root["session_id"]), "#{pane_start_command}"],
                            capture_output=True, text=True)
        assert prompt not in start.stdout
        generation = roots.probe(root["session_id"])[1]
        assert generation is not None
        assert roots.end_exact(root["session_id"], "b" * 64) is False
        assert roots.probe(root["session_id"])[0] == "running"
        _, _, identity = roots._identity(root["session_id"])
        changed = [str(int(identity[0]) + 1), *identity[1:]]
        # Simulate server replacement after the owner's pre-check. tmux must
        # reject it in its own queue even though the retained hash still matches.
        with patch.object(roots, "_identity", return_value=("running", generation, changed)):
            assert roots.end_exact(root["session_id"], generation) is False
        assert roots.probe(root["session_id"])[0] == "running"
        assert roots.end_exact(root["session_id"], generation) is True
    finally:
        run(["tmux", "-L", socket, "kill-server"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
