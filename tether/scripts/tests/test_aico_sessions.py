"""Full catalog inventory, including the ordinary windows roots cannot list."""

import json
import socketserver
import threading
from http.server import BaseHTTPRequestHandler

import pytest
from test_aico_admin import admin


def session(id="12345678", **overrides):
    return {"id": id, "ownershipId": "aico-widget-" + id, "tool": "pi",
            "projectId": None, "displayTitle": "Personal workspace", "origin": "aico",
            "coordinator": False, "coordinatorId": None, "rootRequestId": None,
            "status": "running", "state": "unknown", **overrides}


def test_inventory_includes_unlinked_pi_codex_and_coordinator_root(monkeypatch):
    calls, output = [], []
    rows = [session(), session("aabbcc01", tool="codex", projectId="agent-hub", state="idle"),
            session("aabbcc02", tool="codex", origin="root", coordinator=True,
                    coordinatorId="aabbcc02", rootRequestId="root-fixture"),
            session("aabbcc03", projectId="Personal Workspace")]
    def receipt(_, endpoint, route, payload=None, **kwargs):
        calls.append((endpoint, route, payload))
        return 200, {"items": rows, "text": "private terminal content"}
    monkeypatch.setenv("TETHER_SOCKET", "/fixture/tether.sock")
    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    monkeypatch.setattr(admin, "emit_json", lambda _, value: output.append(value))
    assert admin.main(["sessions"]) == 0
    assert calls == [("/fixture/tether.sock", "/v1/sessions", None)]
    assert [row["widgetId"] for row in output[0]["items"]] == [row["id"] for row in rows]
    assert output[0]["items"][0]["rootRequestId"] is None
    assert output[0]["items"][1]["state"] == "idle"
    assert output[0]["items"][2]["coordinator"] is True
    assert output[0]["items"][3]["projectId"] == "Personal Workspace"
    assert "private terminal content" not in json.dumps(output)


@pytest.mark.parametrize("items", [[session(id="bad")], [session(), session()], [None]])
def test_inventory_refuses_unqualified_or_duplicate_identity(monkeypatch, capsys, items):
    monkeypatch.setattr(admin.Collector, "receipt", lambda *args, **kwargs: (200, {"items": items}))
    assert admin.main(["sessions", "--owner-socket", "/fixture/control.sock"]) == 1
    assert json.loads(capsys.readouterr().out)["reason"] == "sessions_receipt_unqualified"


def test_inventory_redacts_secret_shaped_titles():
    assert admin.session_inventory_item(session(displayTitle="secret=fixture-value"))["title"] == "[redacted]"


def test_inventory_uses_catalog_response_bound_without_dropping_windows(tmp_path, capfd):
    rows = [session(f"{index:08x}", displayTitle="x" * 300) for index in range(60)]
    payload = json.dumps({"items": rows}).encode()
    assert admin.RECEIPT_LIMIT < len(payload) < admin.CATALOG_LIMIT
    routes = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            pass
        def do_GET(self):
            routes.append(self.path)
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
    socket_path = str(tmp_path / "catalog.sock")
    with socketserver.UnixStreamServer(socket_path, Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            assert admin.main(["sessions", "--owner-socket", socket_path]) == 0
        finally:
            server.shutdown()
            thread.join()
    assert routes == ["/v1/sessions"]
    assert len(json.loads(capfd.readouterr().out)["items"]) == 60
