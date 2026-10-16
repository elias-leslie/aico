"""Exact root create, with private owner fixtures only; no running panes."""

import hashlib
import json
import socketserver
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from test_aico_admin import admin


THREAD = "00000000-0000-4000-8000-000000000001"
BASE = ["create", "recovery-1", "Reconcile after crash.", "--tool", "codex", "--project", "sample-app",
        "--project-root", "/fixture/project", "--resume-session", THREAD]


@pytest.fixture(autouse=True)
def outside_aico(monkeypatch):
    """Run as if launched outside an Aico widget unless a test says otherwise."""
    monkeypatch.delenv("AICO_WIDGET_ID", raising=False)


def descriptor(payload, surface="aico", tether=False):
    fields = [payload[k] for k in ("tool", "projectId", "projectRoot", "initialPrompt", "role", "leadRootReference", "facetCapsuleRef")]
    if payload.get("resumeSessionId"):
        fields.append(payload["resumeSessionId"])
    return {"owner": surface, "requestId": payload["requestId"],
            "digest": hashlib.sha256(json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest(),
            "hostIdentity": "12345678" if surface == "aico" or tether else THREAD,
            "logicalSessionId": "aico-root-" + THREAD, "generation": "a" * 64,
            "surfaceLocator": "aico://widget/12345678" if surface == "aico" or tether
                              else "a-term://pane/" + THREAD,
            "status": "running", "role": payload["role"],
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


@pytest.mark.parametrize("surface", ["aico", "a-term"])
def test_create_from_a_session_names_its_launcher(monkeypatch, surface):
    """Tether makes the launcher a coordinator; the CLI only names it."""
    calls, output = [], []

    def receipt(_, path, route, payload=None, **kwargs):
        calls.append((route, payload))
        return 200, descriptor(payload, surface)

    monkeypatch.setenv("AICO_WIDGET_ID", "abcdef01")
    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    transport = ["--root-socket", "/fixture/gui.sock"] if surface == "aico" else ["--root-url", "http://127.0.0.1:8002"]
    assert admin.main([*BASE, "--surface", surface, *transport]) == 0
    assert [route for route, _ in calls] == ["/v1/roots"]
    assert calls[0][1]["launchedBy"] == "abcdef01"
    assert output[0]["launchedBy"] == "abcdef01"


@pytest.mark.parametrize("extra", [
    ["--resume-session", ""], ["--resume-session", "id; echo unsafe"],
    ["--project-root", "/fixture/../project"],
    ["--role", "invalid role"], ["--lead-root", ""], ["--root-url", "http://127.0.0.1:8002"],
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


@pytest.mark.parametrize("surface", ["aico", "a-term"])
def test_actual_owner_transport_uses_compact_utf8_and_exact_resume(tmp_path, monkeypatch, surface):
    requests, output = [], []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            raw = self.rfile.read(int(self.headers["Content-Length"]))
            body = json.loads(raw)
            requests.append((self.path, body, raw))
            response = json.dumps(descriptor(body, surface)).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, format: str, *args: object) -> None:
            pass

    path = str(tmp_path / "fixture.sock")
    server = socketserver.UnixStreamServer(path, Handler) if surface == "aico" else HTTPServer(("127.0.0.1", 0), Handler)
    transport = (["--root-url", f"http://127.0.0.1:{server.server_port}"]
                 if isinstance(server, HTTPServer) else ["--root-socket", path])
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    with server:
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .01})
        thread.start()
        try:
            assert admin.main([*BASE[:2], "界" * 666 + "ab", *BASE[3:], "--surface", surface, *transport]) == 0
        finally:
            server.shutdown()
            thread.join(timeout=1)
    assert len(requests) == 1
    assert requests[0][0] == "/v1/roots"
    assert requests[0][1]["resumeSessionId"] == THREAD
    assert b"\\u754c" not in requests[0][2] and "界".encode() in requests[0][2]
    assert b'": "' not in requests[0][2]
    assert "界" not in json.dumps(output, ensure_ascii=False)


@pytest.mark.parametrize("url", ["http://external.example:8002", "https://localhost:8002", "http://user:pass@localhost:8002", "http://localhost:8002?query=x"])
def test_aterm_transport_rejects_external_credentials_and_proxy_routes(url):
    with pytest.raises(admin.argparse.ArgumentTypeError):
        admin.local_root_url(url)


def test_aterm_create_accepts_tether_shaped_receipt(monkeypatch):
    """A-Term's /v1/roots now proxies Tether: 8-hex id, aico://widget locator, owner a-term."""
    output = []
    monkeypatch.setattr(admin.Collector, "receipt",
                        lambda _self, _endpoint, _route, payload=None, **_kw: (200, descriptor(payload, "a-term", tether=True)))
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    assert admin.main([*BASE, "--surface", "a-term"]) == 0
    assert output[0]["owner"] == "a-term" and output[0]["hostIdentity"] == "12345678"
    assert output[0]["surfaceLocator"] == "aico://widget/12345678"


def test_tool_is_required():
    without = [arg for arg in BASE if arg not in ("--tool", "codex")]
    with pytest.raises(SystemExit):
        admin.main(without)


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


def test_a_new_root_tool_needs_no_client_change(monkeypatch):
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
    with pytest.raises(SystemExit):
        admin.main(["create", "--help"])
    help_text = " ".join(capsys.readouterr().out.split())
    assert "claude-code" in help_text and "codex" in help_text
    for policy in ("routing", "default choice", "delegated", "Neri"):
        assert policy not in help_text
