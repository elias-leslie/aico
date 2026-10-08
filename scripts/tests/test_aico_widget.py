"""Exact current-widget owner controls, using isolated receipts and sockets."""

import json
import socketserver
import threading
from http.server import BaseHTTPRequestHandler

import pytest

from test_aico_admin import admin


WIDGET = "aabbcc01"
GENERATION = "a" * 64
DESCRIPTOR = {"owner": "aico", "widgetId": WIDGET, "sessionId": "aico-widget-" + WIDGET,
              "generation": GENERATION, "status": "running", "available": True}


def invoke(monkeypatch, args, responses):
    calls, output = [], []

    def receipt(_, endpoint, route, payload=None):
        calls.append((endpoint, route, payload))
        return responses[len(calls) - 1]

    monkeypatch.setenv("AICO_WIDGET_ID", WIDGET)
    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    return admin.main(["widget", *args, "--root-socket", "/fixture/gui.sock"]), calls, output


@pytest.mark.parametrize("args,payload", [
    (["title", "  Private new label  "], {"generation": GENERATION, "label": "Private new label"}),
    (["position", "-10", "20", "900", "560"],
     {"generation": GENERATION, "bounds": {"x": -10, "y": 20, "width": 900, "height": 560}}),
])
def test_pins_current_widget_before_one_mutation_and_emits_no_label(monkeypatch, args, payload):
    response = {**DESCRIPTOR, "text": "private-owner-text", "label": "Private new label"}
    code, calls, output = invoke(monkeypatch, args, [(200, response), (200, response)])
    assert code == 0
    assert calls == [("/fixture/gui.sock", f"/v1/widgets/{WIDGET}", None),
                     ("/fixture/gui.sock", f"/v1/widgets/{WIDGET}/{args[0]}", payload)]
    assert output == [{**DESCRIPTOR, "operation": args[0], "applied": True}]
    assert "Private new label" not in json.dumps(output)
    assert "private-owner-text" not in json.dumps(output)


def test_status_is_content_free_and_explicit_widget_overrides_environment(monkeypatch):
    other = "aabbcc02"
    code, calls, output = invoke(monkeypatch, ["status", "--widget-id", other],
                                [(200, {**DESCRIPTOR, "widgetId": other, "prompt": "private"})])
    assert code == 0
    assert calls[0][1] == f"/v1/widgets/{other}"
    assert output == [{**DESCRIPTOR, "widgetId": other}]


@pytest.mark.parametrize("args", [
    ["status"], ["status", "--widget-id", ""], ["status", "--widget-id", "AABBCC01"],
    ["status", "--widget-id", "aabbcc01/title"],
])
def test_missing_or_invalid_widget_id_has_no_active_view_fallback(monkeypatch, args):
    monkeypatch.delenv("AICO_WIDGET_ID", raising=False)
    monkeypatch.setattr(admin.Collector, "receipt", lambda *_: pytest.fail("owner contacted"))
    with pytest.raises(SystemExit) as error:
        admin.main(["widget", *args])
    assert error.value.code == 2


@pytest.mark.parametrize("args", [
    ["title", ""], ["title", "control\x1b"], ["title", "line\nbreak"],
    ["title", "\u0085"], ["title", "\u2028"], ["title", "界" * 54],
    ["position", "0", "0", "359", "240"], ["position", "0", "0", "360", "239"],
    ["position", "100001", "0", "360", "240"], ["position", "0.5", "0", "360", "240"],
])
def test_invalid_label_or_bounds_never_contacts_owner(monkeypatch, args):
    monkeypatch.setenv("AICO_WIDGET_ID", WIDGET)
    monkeypatch.setattr(admin.Collector, "receipt", lambda *_: pytest.fail("owner contacted"))
    with pytest.raises(SystemExit) as error:
        admin.main(["widget", *args])
    assert error.value.code == 2


@pytest.mark.parametrize("changed", [
    {"owner": "other"}, {"widgetId": "aabbcc02"}, {"sessionId": ""},
    {"generation": "invalid"}, {"status": "ended"}, {"available": "true"},
    {"status": "uncertain"},
])
def test_unqualified_descriptor_never_authorizes_mutation(monkeypatch, changed):
    code, calls, output = invoke(monkeypatch, ["title", "Rejected"], [(200, {**DESCRIPTOR, **changed})])
    assert code == 1 and len(calls) == 1
    assert output[0]["applied"] is False
    assert output[0]["reason"] == "widget_receipt_unqualified"


def test_qualified_unavailable_widget_never_mutates(monkeypatch):
    code, calls, output = invoke(monkeypatch, ["title", "Rejected"],
                                [(200, {**DESCRIPTOR, "status": "uncertain", "available": False})])
    assert code == 1 and len(calls) == 1
    assert output[0]["reason"] == "workload_unavailable"
    assert output[0]["applied"] is False


@pytest.mark.parametrize("changed", [
    {"widgetId": "aabbcc02"}, {"sessionId": "aico-widget-aabbcc02"}, {"generation": "b" * 64},
])
def test_success_requires_same_widget_session_and_generation_without_retry(monkeypatch, changed):
    code, calls, output = invoke(monkeypatch, ["title", "Rejected"],
                                [(200, DESCRIPTOR), (200, {**DESCRIPTOR, **changed})])
    assert code == 1 and len(calls) == 2
    assert output[0]["reason"] == "widget_receipt_unqualified"
    assert output[0]["applied"] is None


@pytest.mark.parametrize("status,error", [(404, "not_found"), (410, "ended"),
                                        (409, "stale_generation"), (503, "gui_unavailable")])
def test_missing_ended_or_stale_owner_replies_are_closed_without_retry(monkeypatch, status, error):
    code, calls, output = invoke(monkeypatch, ["title", "Rejected"],
                                [(200, DESCRIPTOR), (status, {"error": error, "text": "private"})])
    assert code == 1 and len(calls) == 2
    assert output[0]["reason"] == error
    assert output[0]["applied"] is None
    assert "private" not in json.dumps(output)


def test_actual_private_owner_transport_pins_then_positions(tmp_path, monkeypatch):
    calls, output = [], []

    class Handler(BaseHTTPRequestHandler):
        def answer(self, payload=None):
            calls.append((self.command, self.path, payload))
            response = json.dumps(DESCRIPTOR).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def do_GET(self):
            self.answer()

        def do_POST(self):
            self.answer(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))

        def log_message(self, format, *args):
            pass

    monkeypatch.setenv("AICO_WIDGET_ID", WIDGET)
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    path = str(tmp_path / "owner.sock")
    with socketserver.UnixStreamServer(path, Handler) as server:
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .01})
        thread.start()
        try:
            assert admin.main(["widget", "position", "-10", "20", "900", "560", "--root-socket", path]) == 0
        finally:
            server.shutdown()
            thread.join(timeout=1)
    assert calls == [("GET", f"/v1/widgets/{WIDGET}", None),
                     ("POST", f"/v1/widgets/{WIDGET}/position",
                      {"generation": GENERATION, "bounds": {"x": -10, "y": 20, "width": 900, "height": 560}})]
    assert output == [{**DESCRIPTOR, "operation": "position", "applied": True}]
