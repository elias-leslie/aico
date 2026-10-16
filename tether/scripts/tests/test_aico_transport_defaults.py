"""Owner endpoints each `st aico` command derives from its environment, with no flags."""

import json
import os
import socketserver
import threading
from http.server import BaseHTTPRequestHandler

import pytest

from conftest import REAL_A_TERM_IDENTITY_URL
from test_aico_admin import admin
from test_aico_create import BASE, descriptor

WIDGET = "aabbcc01"
GENERATION = "a" * 64
WIDGET_DESCRIPTOR = {"owner": "aico", "widgetId": WIDGET, "sessionId": "aico-widget-" + WIDGET,
                     "generation": GENERATION, "status": "running", "available": True}
ROOT = "root-fixture"
ROOT_DESCRIPTOR = {"owner": "aico", "requestId": ROOT, "hostIdentity": WIDGET,
                   "logicalSessionId": "aico-root-fixture", "surfaceLocator": f"aico://widget/{WIDGET}",
                   "generation": GENERATION, "status": "running"}
ATERM_DESCRIPTOR = {**ROOT_DESCRIPTOR, "owner": "a-term"}
TRANSPORT = ("XDG_RUNTIME_DIR", "AICO_GUI_CONTROL_SOCKET", "AICO_CONTROL_SOCKET",
             "A_TERM_ROOT_CONTROL_URL", "AICO_LAYOUT_FILE", "AICO_WIDGET_ID")
FALLBACK = f"/run/user/{os.getuid()}"


@pytest.fixture(autouse=True)
def bare_environment(monkeypatch):
    """Start every case with no transport variables set."""
    for name in TRANSPORT:
        monkeypatch.delenv(name, raising=False)


def record(monkeypatch, responses):
    calls, output = [], []

    def receipt(_, endpoint, route, payload=None, **_options):
        calls.append((endpoint, route, payload))
        return responses(payload) if callable(responses) else responses[len(calls) - 1]

    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    monkeypatch.setattr(admin, "emit_json", lambda _, value: output.append(value))
    return calls, output


@pytest.mark.parametrize("env,expected", [
    ({"XDG_RUNTIME_DIR": "/fixture/run"}, "/fixture/run/aico/gui-control.sock"),
    ({"XDG_RUNTIME_DIR": ""}, f"{FALLBACK}/aico/gui-control.sock"),
    ({}, f"{FALLBACK}/aico/gui-control.sock"),
    ({"XDG_RUNTIME_DIR": "/fixture/run", "AICO_GUI_CONTROL_SOCKET": "/fixture/gui.sock"}, "/fixture/gui.sock"),
])
def test_widget_status_resolves_the_gui_socket(monkeypatch, env, expected):
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    calls, _ = record(monkeypatch, [(200, WIDGET_DESCRIPTOR)])
    assert admin.main(["widget", "status", "--widget-id", WIDGET]) == 0
    assert calls == [(expected, f"/v1/widgets/{WIDGET}", None)]


@pytest.mark.parametrize("env,expected", [
    ({"XDG_RUNTIME_DIR": "/fixture/run"}, ("/fixture/run/aico/gui-control.sock", "/fixture/run/aico/control.sock")),
    ({}, (f"{FALLBACK}/aico/gui-control.sock", f"{FALLBACK}/aico/control.sock")),
    ({"XDG_RUNTIME_DIR": "/fixture/run", "AICO_GUI_CONTROL_SOCKET": "/fixture/gui.sock",
      "AICO_CONTROL_SOCKET": "/fixture/control.sock"}, ("/fixture/gui.sock", "/fixture/control.sock")),
])
def test_root_end_resolves_gui_and_owner_sockets(monkeypatch, env, expected):
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    calls, output = record(monkeypatch, [(200, ROOT_DESCRIPTOR), (200, {"status": "ended"})])
    assert admin.main(["root", "end", ROOT]) == 0
    assert calls == [(expected[0], f"/v1/roots/{ROOT}", None),
                     (expected[1], f"/v1/sessions/{WIDGET}/end", {"generation": GENERATION})]
    assert output[0]["status"] == "ended"


@pytest.mark.parametrize("env,expected", [
    ({}, "http://127.0.0.1:8002"),
    ({"A_TERM_ROOT_CONTROL_URL": "http://localhost:9000/"}, "http://localhost:9000"),
])
def test_root_status_resolves_the_a_term_url(monkeypatch, env, expected):
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    calls, _ = record(monkeypatch, [(200, ATERM_DESCRIPTOR)])
    assert admin.main(["root", "status", ROOT, "--surface", "a-term"]) == 0
    assert calls == [(expected, f"/v1/roots/{ROOT}", None)]


@pytest.mark.parametrize("surface,env,expected", [
    ("aico", {"XDG_RUNTIME_DIR": "/fixture/run"}, "/fixture/run/aico/gui-control.sock"),
    ("aico", {"AICO_GUI_CONTROL_SOCKET": "/fixture/gui.sock"}, "/fixture/gui.sock"),
    ("a-term", {}, "http://127.0.0.1:8002"),
    ("a-term", {"A_TERM_ROOT_CONTROL_URL": "http://[::1]:9000"}, "http://[::1]:9000"),
])
def test_create_resolves_the_surface_endpoint(monkeypatch, surface, env, expected):
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    calls, _ = record(monkeypatch, lambda payload: (200, descriptor(payload, surface)))
    assert admin.main([*BASE, "--surface", surface]) == 0
    assert [call[:2] for call in calls] == [(expected, "/v1/roots")]


@pytest.mark.parametrize("argv,env", [
    (["widget", "status", "--widget-id", WIDGET], {"AICO_GUI_CONTROL_SOCKET": "relative.sock"}),
    (["widget", "status", "--widget-id", WIDGET], {"XDG_RUNTIME_DIR": "/fixture/../run"}),
    (["root", "status", ROOT], {"AICO_GUI_CONTROL_SOCKET": "relative.sock"}),
    # The owner socket is resolved for every Aico root operation, not only end.
    (["root", "status", ROOT], {"AICO_CONTROL_SOCKET": "relative.sock"}),
    (["root", "status", ROOT, "--surface", "a-term"], {"A_TERM_ROOT_CONTROL_URL": "https://127.0.0.1:8002"}),
    ([*BASE], {"AICO_GUI_CONTROL_SOCKET": "relative.sock"}),
    ([*BASE, "--surface", "a-term"], {"A_TERM_ROOT_CONTROL_URL": "http://example.test:8002"}),
])
def test_invalid_environment_is_an_owner_transport_error(monkeypatch, capsys, argv, env):
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    calls, output = record(monkeypatch, [])
    with pytest.raises(SystemExit) as exit_info:
        admin.main(argv)
    assert exit_info.value.code == 2
    assert "invalid owner transport configuration" in capsys.readouterr().err
    assert calls == [] and output == []


@pytest.mark.parametrize("env,expected", [
    ({"XDG_RUNTIME_DIR": "/fixture/run"}, "/fixture/run/aico/gui-control.sock"),
    ({"XDG_RUNTIME_DIR": "/fixture/run", "AICO_GUI_CONTROL_SOCKET": "/fixture/gui.sock"}, "/fixture/gui.sock"),
])
def test_admin_inspect_resolves_the_gui_socket(monkeypatch, env, expected):
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    calls, _ = record(monkeypatch, [(200, {})])
    assert admin.main(["admin", ROOT]) == 1
    assert calls == [(expected, f"/v1/roots/{ROOT}/admin", None)]


def test_admin_rejects_an_invalid_default_through_argparse(monkeypatch, capsys):
    monkeypatch.setenv("AICO_GUI_CONTROL_SOCKET", "relative.sock")
    with pytest.raises(SystemExit) as exit_info:
        admin.main(["admin", ROOT])
    assert exit_info.value.code == 2
    assert "argument --root-socket: socket must be an exact normalized absolute path" in capsys.readouterr().err


@pytest.mark.parametrize("env,expected", [
    ({"XDG_RUNTIME_DIR": "/fixture/run"}, ("/fixture/run/aico/gui-control.sock", "/fixture/run/aico/control.sock")),
    ({}, (f"{FALLBACK}/aico/gui-control.sock", f"{FALLBACK}/aico/control.sock")),
    ({"AICO_GUI_CONTROL_SOCKET": "/fixture/gui.sock", "AICO_CONTROL_SOCKET": "/fixture/control.sock"},
     ("/fixture/gui.sock", "/fixture/control.sock")),
])
def test_roots_resolves_gui_and_owner_sockets(monkeypatch, env, expected):
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    seen = []

    def discover(self, request_id):
        seen.append((self.root_socket, self.owner_socket, request_id))
        return [], []

    monkeypatch.setattr(admin.Collector, "discover", discover)
    _, output = record(monkeypatch, [])
    assert admin.main(["roots"]) == 0
    assert seen == [(*expected, None)]
    assert output == [{"owner": "aico", "roots": []}]


@pytest.mark.parametrize("name,option", [
    ("AICO_GUI_CONTROL_SOCKET", "--root-socket"), ("AICO_CONTROL_SOCKET", "--owner-socket"),
])
def test_roots_rejects_an_invalid_default_through_argparse(monkeypatch, capsys, name, option):
    monkeypatch.setenv(name, "relative.sock")
    with pytest.raises(SystemExit) as exit_info:
        admin.main(["roots"])
    assert exit_info.value.code == 2
    assert f"argument {option}: socket must be an exact normalized absolute path" in capsys.readouterr().err


def test_layout_reads_from_the_runtime_directory(tmp_path, monkeypatch, capsys):
    (tmp_path / "aico").mkdir()
    layout = {"v": 1, "pid": os.getpid(), "startTime": None, "windows": []}
    (tmp_path / "aico" / "layout.json").write_text(json.dumps(layout))
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    assert admin.main(["layout"]) == 0
    assert json.loads(capsys.readouterr().out) == {"owner": "aico", **layout}


class _Projects(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def _tether_projects(path, projects):
    """A fake Tether control socket answering GET /v1/projects."""

    class Handler(BaseHTTPRequestHandler):
        def address_string(self):
            return "tether"

        def log_message(self, format, *args):
            pass

        def do_GET(self):
            body = json.dumps({"source": "summitflow", "projects": projects}).encode()
            self.send_response(200 if self.path == "/v1/projects" else 404)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = _Projects(str(path), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def test_a_term_url_comes_from_its_project_identity(monkeypatch, tmp_path):
    """No URL configured: A-Term's backend port from the project.identity.json in the checkout Tether lists."""
    root = tmp_path / "a-term"
    root.mkdir()
    (root / "project.identity.json").write_text(json.dumps({"runtime": {"backend_port": 9123}}))
    server = _tether_projects(tmp_path / "t.sock", [{"id": "agent-hub", "root": "/nowhere"},
                                                     {"id": "a-term", "root": str(root)}])
    monkeypatch.setattr(admin, "a_term_identity_url", REAL_A_TERM_IDENTITY_URL)
    monkeypatch.setenv("TETHER_SOCKET", str(tmp_path / "t.sock"))
    try:
        calls, _ = record(monkeypatch, [(200, ATERM_DESCRIPTOR)])
        assert admin.main(["root", "status", ROOT, "--surface", "a-term"]) == 0
    finally:
        server.shutdown()
        server.server_close()
    assert calls == [("http://127.0.0.1:9123", f"/v1/roots/{ROOT}", None)]


@pytest.mark.parametrize("case", ["tether_down", "no_a_term", "no_identity"])
def test_unknown_a_term_port_says_how_to_set_it(monkeypatch, tmp_path, capsys, case):
    monkeypatch.setattr(admin, "a_term_identity_url", REAL_A_TERM_IDENTITY_URL)
    monkeypatch.setenv("TETHER_SOCKET", str(tmp_path / "t.sock"))
    server = None
    if case != "tether_down":
        projects = [{"id": "a-term", "root": str(tmp_path / "missing")}] if case == "no_identity" else []
        server = _tether_projects(tmp_path / "t.sock", projects)
    calls, output = record(monkeypatch, [])
    try:
        with pytest.raises(SystemExit) as exit_info:
            admin.main(["root", "status", ROOT, "--surface", "a-term"])
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
    assert exit_info.value.code == 2
    err = capsys.readouterr().err
    assert "invalid owner transport configuration" in err and "A_TERM_ROOT_CONTROL_URL" in err
    assert calls == [] and output == []
