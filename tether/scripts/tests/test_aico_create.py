"""Exact root create, with private owner fixtures only; no running panes."""

import hashlib
import json
import socketserver
import threading
from http.server import BaseHTTPRequestHandler

import pytest
from test_aico_admin import admin

THREAD = "00000000-0000-4000-8000-000000000001"
BASE = ["create", "recovery-1", "Reconcile after crash.", "--tool", "codex", "--project", "sample-app",
        "--project-root", "/fixture/project", "--work-role", "implementation", "--resume-session", THREAD]


@pytest.fixture(autouse=True)
def outside_aico(monkeypatch, tmp_path):
    """Run as if launched outside an Aico widget unless a test says otherwise."""
    monkeypatch.delenv("AICO_WIDGET_ID", raising=False)
    monkeypatch.setattr(admin, "PROC", tmp_path)


def fake_process(proc, pid, ppid, environ):
    (proc / str(pid)).mkdir()
    (proc / str(pid) / "stat").write_text(f"{pid} (codex (x) y) S {ppid} 1 1 0\n")
    (proc / str(pid) / "environ").write_bytes(b"\0".join(f"{k}={v}".encode() for k, v in environ.items()) + b"\0")


def descriptor(payload, owner="aico"):
    fields = [payload[k] for k in ("tool", "projectId", "projectRoot", "initialPrompt", "role", "leadRootReference", "facetCapsuleRef")]
    if payload.get("resumeSessionId"):
        fields.append(payload["resumeSessionId"])
    if payload.get("model") or payload.get("reasoningEffort") or payload.get("daybreak") is not None or payload.get("agentHubContext") is not None:
        fields.append({"model": payload.get("model"), "reasoningEffort": payload.get("reasoningEffort"),
                       **({"daybreak": payload["daybreak"]} if payload.get("daybreak") is not None else {}),
                       **({"agentHubContext": payload["agentHubContext"]} if payload.get("agentHubContext") is not None else {})})
    if payload.get("workRole"):
        fields.append({"workRole": payload.get("workRole"), "workRoleDisplayName": payload.get("workRoleDisplayName")})
    return {"owner": owner, "requestId": payload["requestId"],
            "digest": hashlib.sha256(json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest(),
            "hostIdentity": "12345678",
            "logicalSessionId": "aico-root-" + THREAD, "generation": "a" * 64,
            "surfaceLocator": "aico://widget/12345678",
            "status": "running", "role": payload["role"],
            "workRole": payload.get("workRole"), "workRoleDisplayName": payload.get("workRoleDisplayName"),
            "leadRootReference": payload["leadRootReference"], "facetCapsuleRef": payload["facetCapsuleRef"]}


def test_exact_create_is_one_content_free_request_with_no_fleet_ledger(monkeypatch):
    calls, output = [], []

    def receipt(_, path, route, payload, **kwargs):
        calls.append((path, route, payload))
        return 200, {**descriptor(payload), "text": "private-owner-content"}

    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    assert admin.main([*BASE, "--root-socket", "/fixture/gui.sock"]) == 0
    assert len(calls) == 1
    assert calls[0][0:2] == ("/fixture/gui.sock", "/v1/roots")
    assert calls[0][2]["resumeSessionId"] == THREAD
    assert output[0]["requestId"] == "recovery-1"
    assert "Reconcile after crash" not in json.dumps(output)
    assert "private-owner-content" not in json.dumps(output)


def test_create_from_a_session_names_its_launcher(monkeypatch):
    """Tether makes the launcher a coordinator; the CLI only names it."""
    calls, output = [], []

    def receipt(_, path, route, payload=None, **kwargs):
        calls.append((route, payload))
        return 200, descriptor(payload)

    monkeypatch.setenv("AICO_WIDGET_ID", "abcdef01")
    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    assert admin.main([*BASE, "--root-socket", "/fixture/gui.sock"]) == 0
    assert [route for route, _ in calls] == ["/v1/roots"]
    assert calls[0][1]["launchedBy"] == "abcdef01"
    assert output[0]["launchedBy"] == "abcdef01"


def test_create_from_a_filtered_agent_shell_names_its_ancestor_widget(monkeypatch, tmp_path):
    """Codex inherit = "core" drops AICO_WIDGET_ID from exec shells; its codex parent keeps it."""
    calls, output = [], []
    fake_process(tmp_path, 300, 200, {"HOME": "/home/fixture"})
    fake_process(tmp_path, 200, 100, {"AICO_WIDGET_ID": "e96c7f15"})
    fake_process(tmp_path, 100, 1, {"AICO_WIDGET_ID": "0f442411"})
    monkeypatch.setattr(admin.os, "getppid", lambda: 300)
    monkeypatch.setattr(admin.Collector, "receipt", lambda _, path, route, payload=None, **kw: (calls.append(payload), (200, descriptor(payload)))[1])
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    assert admin.main([*BASE, "--root-socket", "/fixture/gui.sock"]) == 0
    assert calls[0]["launchedBy"] == "e96c7f15"
    assert output[0]["launchedBy"] == "e96c7f15"


@pytest.mark.parametrize("ancestor", [{"AICO_WIDGET_ID": "E96C7F15"}, {"PATH": "/usr/bin"}])
def test_create_outside_aico_or_with_an_invalid_ancestor_id_names_no_launcher(monkeypatch, tmp_path, ancestor):
    calls = []
    fake_process(tmp_path, 300, 1, ancestor)
    monkeypatch.setattr(admin.os, "getppid", lambda: 300)
    monkeypatch.setattr(admin.Collector, "receipt", lambda _, path, route, payload=None, **kw: (calls.append(payload), (200, descriptor(payload)))[1])
    monkeypatch.setattr(admin, "emit_json", lambda *_: None)
    assert admin.main([*BASE, "--root-socket", "/fixture/gui.sock"]) == 0
    assert "launchedBy" not in calls[0]


@pytest.mark.parametrize("extra", [
    ["--resume-session", ""], ["--resume-session", "id; echo unsafe"],
    ["--project-root", "/fixture/../project"],
    ["--role", "invalid role"], ["--lead-root", ""],
    # The web app has no root route: --root-url is gone and --surface takes only aico.
    ["--root-url", "http://127.0.0.1:8002"], ["--surface", "a-term"],
])
def test_invalid_resume_or_metadata_never_contacts_owner(monkeypatch, extra):
    monkeypatch.setattr(admin.Collector, "receipt", lambda *_args, **_kwargs: pytest.fail("owner contacted"))
    with pytest.raises(SystemExit) as result:
        admin.main([*BASE, *extra])
    assert result.value.code == 2


@pytest.mark.parametrize("prompt", ["x" * 2001, "", "password=private", "x\rframing"])
def test_invalid_prompt_is_content_free_and_never_sent(monkeypatch, prompt, capsys):
    monkeypatch.setattr(admin.Collector, "receipt", lambda *_args, **_kwargs: pytest.fail("owner contacted"))
    with pytest.raises(SystemExit):
        admin.main([*BASE[:2], prompt, *BASE[3:]])
    assert prompt not in capsys.readouterr().err if prompt else True


@pytest.mark.parametrize(("prompt", "reason"), [
    ("x" * 2001, "prompt is 2001 bytes; the limit is 2000. Write the brief to a file"),
    ("   ", "missing prompt"),
    ("x\x1bframing", "control characters"),
    ("password=hunter2xyz", "looks like it contains a credential"),
])
def test_each_prompt_rejection_names_its_cause(monkeypatch, prompt, reason, capsys):
    monkeypatch.setattr(admin.Collector, "receipt", lambda *_args, **_kwargs: pytest.fail("owner contacted"))
    with pytest.raises(SystemExit):
        admin.main([*BASE[:2], prompt, *BASE[3:]])
    error = capsys.readouterr().err
    assert reason in error
    assert "hunter2xyz" not in error


@pytest.mark.parametrize("response", [
    (409, {"error": "request_conflict"}), (401, {"error": "private-auth-data"}),
    (200, {"owner": "aico", "requestId": "other", "text": "private-content"}),
])
def test_conflicts_auth_and_unknown_receipts_never_retry_or_echo(monkeypatch, response):
    calls, output = [], []
    monkeypatch.setattr(admin.Collector, "receipt", lambda *_args, **_kwargs: (calls.append(1) or response))
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    assert admin.main(BASE) == 1
    assert calls == [1]
    assert output[0]["reason"] == ("request_conflict" if response[0] == 409 else "create_receipt_unqualified")
    assert "private" not in json.dumps(output)


def test_actual_owner_transport_uses_compact_utf8_and_exact_resume(tmp_path, monkeypatch):
    requests, output = [], []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            raw = self.rfile.read(int(self.headers["Content-Length"]))
            body = json.loads(raw)
            requests.append((self.path, body, raw))
            response = json.dumps(descriptor(body)).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, format: str, *args: object) -> None:
            pass

    path = str(tmp_path / "fixture.sock")
    server = socketserver.UnixStreamServer(path, Handler)
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    with server:
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .01})
        thread.start()
        try:
            assert admin.main([*BASE[:2], "界" * 666 + "ab", *BASE[3:], "--root-socket", path]) == 0
        finally:
            server.shutdown()
            thread.join(timeout=1)
    assert len(requests) == 1
    assert requests[0][0] == "/v1/roots"
    assert requests[0][1]["resumeSessionId"] == THREAD
    assert b"\\u754c" not in requests[0][2] and "界".encode() in requests[0][2]
    assert b'": "' not in requests[0][2]
    assert "界" not in json.dumps(output, ensure_ascii=False)


def test_create_refuses_a_receipt_owned_by_the_web_app(monkeypatch):
    """Only Aico-owned roots come back from create; the web app is not an owner."""
    output = []
    monkeypatch.setattr(admin.Collector, "receipt",
                        lambda _self, _endpoint, _route, payload=None, **_kw: (200, descriptor(payload, "a-term")))
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    assert admin.main(BASE) == 1
    assert output[0]["reason"] == "create_receipt_unqualified"


def test_tool_is_required():
    without = [arg for arg in BASE if arg not in ("--tool", "codex")]
    with pytest.raises(SystemExit):
        admin.main(without)


def test_requested_model_and_effort_are_digest_bound(monkeypatch):
    calls = []

    def receipt(_, endpoint, route, payload, **kwargs):
        calls.append(payload)
        return 200, descriptor(payload)

    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    assert admin.main([*BASE, "--model", "gpt-6.1-sol", "--reasoning-effort", "high", "--daybreak", "off"]) == 0
    assert calls[0]["model"] == "gpt-6.1-sol"
    assert calls[0]["reasoningEffort"] == "high"
    assert calls[0]["daybreak"] is False


@pytest.mark.parametrize("args, refused", [
    (["--daybreak", "on"], True),  # configured default lacks Daybreak
    (["--model", "gpt-6.1-sol", "--daybreak", "on"], True),
    (["--model", "gpt-6-sol", "--daybreak", "on"], False),
    (["--model", "gpt-6.1-sol", "--daybreak", "off"], False),
    (["--model", "unlisted", "--daybreak", "on"], False),
])
def test_codex_daybreak_on_a_model_without_it_is_refused_before_tether(monkeypatch, tmp_path, capsys, args, refused):
    """Codex rejects that pair before the first turn, which would leave an idle root."""
    (tmp_path / ".codex").mkdir()
    (tmp_path / ".codex/config.toml").write_text('model = "gpt-6.1-sol"\n')
    (tmp_path / ".codex/models_cache.json").write_text(json.dumps({"models": [
        {"slug": "gpt-6.1-sol", "available_access_programs": {"cyber": ["standard"]}},
        {"slug": "gpt-6-sol", "available_access_programs": {"cyber": ["standard", "daybreak_blue"]}}]}))
    monkeypatch.setattr(admin.Path, "home", lambda: tmp_path)
    calls = []

    def receipt(_, endpoint, route, payload, **kwargs):
        calls.append(payload)
        return 200, descriptor(payload)

    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    if refused:
        with pytest.raises(SystemExit):
            admin.main([*BASE, *args])
        assert not calls
        assert "--model gpt-6-sol or --daybreak off" in capsys.readouterr().err
    else:
        assert admin.main([*BASE, *args]) == 0
        assert len(calls) == 1


def fresh(tool):
    return ["create", "fresh-1", "Start.", "--tool", tool, "--project", "sample-app",
            "--project-root", "/fixture/project"]


@pytest.mark.parametrize("supported, shown", [
    (["claude-code", "codex"], ["claude-code", "codex"]),
    (["bad slug!"], None), ("codex", None),
])
def test_tether_decides_which_tools_can_start_a_root(monkeypatch, supported, shown):
    """No local tool list: Tether's refusal, and the tools it names, reach the caller."""
    calls, output = [], []

    def receipt(_, path, route, payload, **kwargs):
        calls.append(payload["tool"])
        return 400, {"error": "unsupported_tool", "supported": supported}

    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    assert admin.main(fresh("pi")) == 1
    assert calls == ["pi"]
    assert output[0]["reason"] == "unsupported_tool"
    assert output[0].get("supportedTools") == shown


def test_a_new_root_tool_needs_no_create_change(monkeypatch):
    # create keeps no tool list; `roots` observation still needs a per-tool status
    # profile (see classify), so a new tool is unobservable until one is added.
    output = []
    monkeypatch.setattr(admin.Collector, "receipt", lambda _, path, route, payload, **kw: (200, descriptor(
        {**payload, "resumeSessionId": None})))
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    assert admin.main(fresh("future-agent")) == 0
    assert output[0]["status"] == "running"


@pytest.mark.parametrize("tool", ["", "Codex", "pi; echo", "a" * 51])
def test_malformed_tool_never_contacts_owner(monkeypatch, tool):
    monkeypatch.setattr(admin.Collector, "receipt", lambda *_a, **_k: pytest.fail("contacted owner"))
    with pytest.raises(SystemExit) as exit_info:
        admin.main(fresh(tool))
    assert exit_info.value.code == 2


def test_tool_help_lists_tools_only(capsys):
    # Direct script help only: `st aico create --help` prints SummitFlow's aico
    # manifest page, which SummitFlow's own extension test covers.
    with pytest.raises(SystemExit):
        admin.main(["create", "--help"])
    help_text = " ".join(capsys.readouterr().out.split())
    assert "claude-code" in help_text and "codex" in help_text
    assert "codex or pi" in help_text
    assert "opencode" not in help_text.lower()
    for policy in ("routing", "default choice", "delegated", "Neri"):
        assert policy not in help_text


@pytest.mark.parametrize("provider,effort", [("openai-codex", "xhigh"), ("openai", "high")])
def test_pi_selection_is_forwarded_without_using_another_tool(monkeypatch, provider, effort):
    calls = []
    def receipt(_, path, route, payload, **kwargs):
        calls.append(payload)
        return 200, descriptor(payload)
    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    monkeypatch.setattr(admin, "emit_json", lambda *_: None)
    argv = ["pi" if arg == "codex" else arg for arg in BASE]
    assert admin.main([*argv, "--model", f"{provider}/gpt-6.1-sol", "--reasoning-effort", effort]) == 0
    assert calls[0]["tool"] == "pi"
    assert calls[0]["model"] == f"{provider}/gpt-6.1-sol"
    assert calls[0]["reasoningEffort"] == effort
    assert calls[0]["resumeSessionId"] == THREAD


@pytest.mark.parametrize("context", ["on", "off"])
def test_pi_daybreak_and_optional_context_are_bound_to_create_digest(monkeypatch, context):
    calls = []
    def receipt(_, path, route, payload, **kwargs):
        calls.append(payload)
        return 200, descriptor(payload)
    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    monkeypatch.setattr(admin, "emit_json", lambda *_: None)
    argv = ["pi" if arg == "codex" else arg for arg in BASE]
    assert admin.main([*argv, "--model", "openai/gpt-6-sol", "--reasoning-effort", "xhigh",
                       "--daybreak", "on", "--agent-hub-context", context]) == 0
    assert calls[0]["daybreak"] is True
    assert calls[0]["agentHubContext"] is (context == "on")


@pytest.mark.parametrize("role", ["unknown", "invalid role", ""])
def test_work_role_refuses_unregistered_ids(monkeypatch, role):
    monkeypatch.setattr(admin.Collector, "receipt", lambda *_a, **_kw: pytest.fail("owner contacted"))
    with pytest.raises(SystemExit) as result:
        admin.main([*BASE, "--work-role", role])
    assert result.value.code == 2


def test_work_role_is_explicit_independent_metadata(monkeypatch):
    calls = []
    monkeypatch.setenv("ST_WORK_ROLE", "coordinator")
    def receipt(_, path, route, payload, **kwargs):
        calls.append(payload)
        return 200, descriptor(payload)
    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    monkeypatch.setattr(admin, "emit_json", lambda *_: None)
    assert admin.main([*BASE, "--role", "opaque-facet", "--work-role-name", "Builder"]) == 0
    assert calls[0]["workRole"] == "implementation"
    assert calls[0]["workRoleDisplayName"] == "Builder"
    assert calls[0]["role"] == "opaque-facet"
    assert calls[0]["initialPrompt"] == "Reconcile after crash."


def test_legacy_create_retry_keeps_its_original_digest(monkeypatch):
    calls = []
    def receipt(_, path, route, payload, **kwargs):
        calls.append(payload)
        return 200, descriptor(payload)
    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    monkeypatch.setattr(admin, "emit_json", lambda *_: None)
    assert admin.main(fresh("codex")) == 0
    assert "workRole" not in calls[0]


PI = ["create", "pi-1", "Read the brief.", "--tool", "pi", "--project", "sample-app",
      "--project-root", "/fixture/project", "--work-role", "implementation", "--model", "opencode-go/sample-model"]


def usage_server(windows, seen):
    class Usage(BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append((self.path, self.headers.get("X-Client-Id")))
            body = json.dumps({"state": "ok", "windows": windows}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):
            pass

    server = socketserver.TCPServer(("127.0.0.1", 0), Usage)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


@pytest.fixture
def agent_hub(monkeypatch, tmp_path):
    def start(windows):
        seen: list = []
        server = usage_server(windows, seen)
        (tmp_path / ".env.local").write_text('SUMMITFLOW_CLIENT_ID="client-fixture"\n')
        monkeypatch.setattr(admin.Path, "home", lambda: tmp_path)
        monkeypatch.setenv("ST_EXTENSION_CONTEXT", json.dumps({"agent_hub_url": f"http://127.0.0.1:{server.server_address[1]}"}))
        return server, seen
    return start


def test_pi_launch_waits_out_a_rate_limited_opencode_go_window(monkeypatch, agent_hub, capsys):
    server, seen = agent_hub([{"key": "rolling", "label": "5 hours", "status": "rate-limited", "percent": 100,
                               "resets_at": "2026-10-26T22:19:40+00:00"}])
    monkeypatch.setattr(admin.Collector, "receipt", lambda *_args, **_kwargs: pytest.fail("owner contacted"))
    with pytest.raises(SystemExit):
        admin.main(PI)
    server.shutdown()
    error = capsys.readouterr().err
    assert "opencode-go quota is used up (5 hours window resets 2026-10-26T22:19:40+00:00)" in error
    assert "client-fixture" not in error
    assert seen == [("/api/analytics/subscriptions/opencode-go/usage", "client-fixture")]


def test_pi_launch_goes_ahead_with_quota_left_or_without_agent_hub(monkeypatch, agent_hub):
    calls = []
    monkeypatch.setattr(admin.Collector, "receipt", lambda *_args, **_kwargs: (calls.append(1) or (409, {"error": "request_conflict"})))
    monkeypatch.setattr(admin, "emit_json", lambda *_: None)
    server, _ = agent_hub([{"key": "weekly", "label": "Week", "status": "ok", "percent": 85}])
    assert admin.main(PI) == 1
    server.shutdown()
    server.server_close()
    assert admin.main(PI) == 1  # Agent Hub unreachable: launch as before
    monkeypatch.delenv("ST_EXTENSION_CONTEXT")
    assert admin.main(PI) == 1
    assert calls == [1, 1, 1]


def test_quota_is_only_checked_for_opencode_go_models(monkeypatch):
    monkeypatch.setattr(admin.http.client, "HTTPConnection", lambda *_a, **_k: pytest.fail("quota checked"))
    assert admin.opencode_go_quota_block("openai/gpt-6-sol") is None
    assert admin.opencode_go_quota_block(None) is None
