"""Private owner protocol fixtures only; no existing Aico or tmux connections."""

import importlib.util
import json
import os
import socketserver
import sys
import threading
from http.server import BaseHTTPRequestHandler
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "aico_admin_fixture", Path(__file__).resolve().parents[1] / "aico-root-watch.py"
)
assert SPEC is not None and SPEC.loader is not None
admin = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = admin
SPEC.loader.exec_module(admin)

GENERATION = "a" * 64
THREAD = "00000000-0000-4000-8000-000000000001"
CAPABILITY = {
    "available": False, "reason": "native_tui_atomic_compare_and_apply_unavailable",
    "operations": ["clear", "submit"], "framing": "bracketed_paste",
    "missing": ["current_thread_fence", "idle_empty_draft_input_fence", "idempotent_native_receipt"],
}


def invoke(monkeypatch, argv, response, text=None):
    calls = []
    output = []
    monkeypatch.setattr(admin.Collector, "receipt", lambda self, path, route, payload=None:
                        (calls.append((path, route, payload)) or response))
    monkeypatch.setattr(admin, "emit_json", lambda _, value: output.append(value))
    if text is not None:
        monkeypatch.setattr(admin, "admin_stdin", lambda _: text)
    code = admin.main(["admin", "fixture-root", *argv, "--root-socket", "/fixture/gui.sock"])
    return code, calls, output


def test_inspection_projects_capability_without_untrusted_text(monkeypatch):
    code, calls, output = invoke(monkeypatch, [], (200, {
        "owner": "aico", "requestId": "fixture-root", "generation": GENERATION,
        "currentThreadId": None, "terminalAdmin": CAPABILITY, "text": "private-secret",
    }))
    assert code == 0
    assert calls == [("/fixture/gui.sock", "/v1/roots/fixture-root/admin", None)]
    assert output[0]["terminalAdmin"] == CAPABILITY
    assert "private-secret" not in json.dumps(output)


@pytest.mark.parametrize("operation", ["clear", "submit"])
def test_exact_pin_denial_is_one_request_no_capture_no_retry(monkeypatch, operation):
    body = {"error": "native_tui_atomic_admin_unavailable", "applied": False,
            "terminalAdmin": CAPABILITY}
    args = [operation, "--generation", GENERATION, "--thread", THREAD, "--request-key", "scope-1"]
    if operation == "submit":
        args.append("--stdin")
    code, calls, output = invoke(monkeypatch, args, (503, body), "private synthetic text")
    assert code == 1 and len(calls) == 1
    assert calls[0][2] == {"kind": operation, "requestKey": "scope-1", "generation": GENERATION,
                          "expectedThreadId": THREAD, **({"text": "private synthetic text"} if operation == "submit" else {})}
    assert output[0]["applied"] is False
    assert output[0]["requestKey"] == "scope-1"
    assert "private synthetic" not in json.dumps(output)


def test_unknown_receipt_never_claims_nonapplication_or_native_success(monkeypatch):
    code, calls, output = invoke(monkeypatch,
        ["clear", "--generation", GENERATION, "--thread", THREAD, "--request-key", "scope-1"],
        (200, {"applied": True, "text": "private-secret"}))
    assert code == 1 and len(calls) == 1
    assert output[0]["applied"] is None
    assert output[0]["reason"] == "admin_receipt_unqualified"
    assert "private-secret" not in json.dumps(output)


@pytest.mark.parametrize("argv", [
    ["submit"], ["clear", "--stdin"], ["--stdin"],
    ["submit", "--generation", GENERATION, "--thread", "invalid", "--request-key", "scope-1", "--stdin"],
])
def test_invalid_calls_never_contact_owner(monkeypatch, argv):
    monkeypatch.setattr(admin.Collector, "receipt", lambda *_: pytest.fail("unexpected owner call"))
    with pytest.raises(SystemExit) as error:
        admin.main(["admin", "fixture-root", *argv])
    assert error.value.code == 2


def test_stdin_is_bounded_utf8_and_rejects_frame_escapes(monkeypatch):
    # Use a real finite pipe, not a text mock, to cover the byte-oriented boundary.
    for text in [b"fixture", b"a" * 2001, b"\xff", b"a\x1b[201~", b"a\rb"]:
        read, write = os.pipe()
        try:
            os.write(write, text)
            os.close(write)
            write = -1
            monkeypatch.setattr(sys, "stdin", type("Input", (), {"fileno": lambda _: read})())
            collector = admin.Collector("", "", "", admin.time.monotonic() + 1, admin.threading.Event())
            if text == b"fixture":
                assert admin.admin_stdin(collector) == "fixture"
            else:
                with pytest.raises(ValueError):
                    admin.admin_stdin(collector)
        finally:
            os.close(read)
            if write >= 0:
                os.close(write)


def test_actual_private_http_request_is_once_and_projection_is_content_free(tmp_path, monkeypatch):
    requests = []
    output = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append((self.path, body))
            response = json.dumps({"error": "native_tui_atomic_admin_unavailable",
                                   "applied": False, "terminalAdmin": CAPABILITY,
                                   "text": "must not leave owner"}).encode()
            self.send_response(503)
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, format: str, *args: object) -> None:
            pass

    monkeypatch.setattr(admin, "emit_json", lambda _, value: output.append(value))
    path = str(tmp_path / "fixture.sock")
    with socketserver.UnixStreamServer(path, Handler) as server:
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .01})
        thread.start()
        try:
            assert admin.main(["admin", "fixture-root", "clear", "--generation", GENERATION,
                "--thread", THREAD, "--request-key", "scope-1", "--root-socket", path]) == 1
        finally:
            server.shutdown()
            thread.join(timeout=1)
    assert len(requests) == 1 and requests[0][0] == "/v1/roots/fixture-root/admin"
    assert requests[0][1]["requestKey"] == "scope-1"
    assert output[0]["applied"] is False
    assert "must not leave owner" not in json.dumps(output)


def test_transport_uncertainty_retains_key_without_retry(monkeypatch):
    calls = []
    output = []

    def unavailable(*_):
        calls.append(1)
        raise admin.Unavailable("owner_unavailable")

    monkeypatch.setattr(admin.Collector, "receipt", unavailable)
    monkeypatch.setattr(admin, "emit_json", lambda _, value: output.append(value))
    assert admin.main(["admin", "fixture-root", "clear", "--generation", GENERATION,
                       "--thread", THREAD, "--request-key", "scope-1"]) == 1
    assert calls == [1]
    assert output[0]["requestKey"] == "scope-1"
    assert output[0]["applied"] is None
