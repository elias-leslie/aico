"""Owner endpoints each `st aico` command derives from its environment, with no flags."""

import json
import os

import pytest
from aico_cli_fixtures import BASE, admin, descriptor

WIDGET = "aabbcc01"
GENERATION = "a" * 64
WIDGET_DESCRIPTOR = {"owner": "aico", "widgetId": WIDGET, "sessionId": "aico-widget-" + WIDGET,
                     "generation": GENERATION, "status": "running", "available": True}
ROOT = "root-fixture"
ROOT_DESCRIPTOR = {"owner": "aico", "requestId": ROOT, "hostIdentity": WIDGET,
                   "logicalSessionId": "aico-root-fixture", "surfaceLocator": f"aico://widget/{WIDGET}",
                   "generation": GENERATION, "status": "running"}
TRANSPORT = ("XDG_RUNTIME_DIR", "TETHER_SOCKET", "TETHER_INSTANCE", "AICO_LAYOUT_FILE", "AICO_WIDGET_ID")
FALLBACK = f"/run/user/{os.getuid()}"
TETHER = "/fixture/run/tether/default/control.sock"


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


# Every command talks to Tether's own socket; the old Aico sockets are gone.
DEFAULTS = [
    ({"XDG_RUNTIME_DIR": "/fixture/run"}, TETHER),
    ({"XDG_RUNTIME_DIR": ""}, f"{FALLBACK}/tether/default/control.sock"),
    ({}, f"{FALLBACK}/tether/default/control.sock"),
    ({"XDG_RUNTIME_DIR": "/fixture/run", "TETHER_INSTANCE": "dev"}, "/fixture/run/tether/dev/control.sock"),
    ({"XDG_RUNTIME_DIR": "/fixture/run", "TETHER_SOCKET": "/fixture/tether.sock"}, "/fixture/tether.sock"),
]


def apply(monkeypatch, env):
    for name, value in env.items():
        monkeypatch.setenv(name, value)


@pytest.mark.parametrize("env,expected", DEFAULTS)
def test_widget_status_resolves_tether(monkeypatch, env, expected):
    apply(monkeypatch, env)
    calls, _ = record(monkeypatch, [(200, WIDGET_DESCRIPTOR)])
    assert admin.main(["widget", "status", "--widget-id", WIDGET]) == 0
    assert calls == [(expected, f"/v1/widgets/{WIDGET}", None)]


@pytest.mark.parametrize("env,expected", DEFAULTS)
def test_root_end_resolves_tether_for_lookup_and_end(monkeypatch, env, expected):
    apply(monkeypatch, env)
    calls, output = record(monkeypatch, [(200, ROOT_DESCRIPTOR), (200, {"status": "ended"})])
    assert admin.main(["root", "end", ROOT]) == 0
    assert calls == [(expected, f"/v1/roots/{ROOT}", None),
                     (expected, f"/v1/sessions/{WIDGET}/end", {"generation": GENERATION})]
    assert output[0]["status"] == "ended"


@pytest.mark.parametrize("env,expected", DEFAULTS[:1] + DEFAULTS[-1:])
def test_create_resolves_tether(monkeypatch, env, expected):
    apply(monkeypatch, env)
    calls, _ = record(monkeypatch, lambda payload: (200, descriptor(payload)))
    assert admin.main(BASE) == 0
    assert [call[:2] for call in calls] == [(expected, "/v1/roots")]


@pytest.mark.parametrize("argv,env", [
    (["widget", "status", "--widget-id", WIDGET], {"TETHER_SOCKET": "relative.sock"}),
    (["widget", "status", "--widget-id", WIDGET], {"XDG_RUNTIME_DIR": "/fixture/../run"}),
    (["root", "status", ROOT], {"TETHER_SOCKET": "relative.sock"}),
    ([*BASE], {"TETHER_SOCKET": "relative.sock"}),
])
def test_invalid_environment_is_an_owner_transport_error(monkeypatch, capsys, argv, env):
    apply(monkeypatch, env)
    calls, output = record(monkeypatch, [])
    with pytest.raises(SystemExit) as exit_info:
        admin.main(argv)
    assert exit_info.value.code == 2
    assert "invalid owner transport configuration" in capsys.readouterr().err
    assert calls == [] and output == []


@pytest.mark.parametrize("env,expected", DEFAULTS[:1] + DEFAULTS[-1:])
def test_admin_inspect_resolves_tether(monkeypatch, env, expected):
    apply(monkeypatch, env)
    calls, _ = record(monkeypatch, [(200, {})])
    assert admin.main(["admin", ROOT]) == 1
    assert calls == [(expected, f"/v1/roots/{ROOT}/admin", None)]


def test_admin_rejects_an_invalid_default_through_argparse(monkeypatch, capsys):
    monkeypatch.setenv("TETHER_SOCKET", "relative.sock")
    with pytest.raises(SystemExit) as exit_info:
        admin.main(["admin", ROOT])
    assert exit_info.value.code == 2
    assert "argument --root-socket: socket must be an exact normalized absolute path" in capsys.readouterr().err


@pytest.mark.parametrize("env,expected", DEFAULTS)
def test_roots_resolves_tether(monkeypatch, env, expected):
    apply(monkeypatch, env)
    seen = []

    def discover(self, request_id):
        seen.append((self.root_socket, self.owner_socket, request_id))
        return [], []

    monkeypatch.setattr(admin.Collector, "discover", discover)
    _, output = record(monkeypatch, [])
    assert admin.main(["roots"]) == 0
    assert seen == [(expected, expected, None)]
    assert output == [{"owner": "aico", "roots": []}]


def test_roots_rejects_an_invalid_default_through_argparse(monkeypatch, capsys):
    monkeypatch.setenv("TETHER_SOCKET", "relative.sock")
    with pytest.raises(SystemExit) as exit_info:
        admin.main(["roots"])
    assert exit_info.value.code == 2
    assert "socket must be an exact normalized absolute path" in capsys.readouterr().err


@pytest.mark.parametrize("env,expected", [
    ({"XDG_RUNTIME_DIR": "/fixture/run"}, "/fixture/run/tether/default/control.sock"),
    ({"XDG_RUNTIME_DIR": "/fixture/run", "TETHER_INSTANCE": "dev"}, "/fixture/run/tether/dev/control.sock"),
    ({"TETHER_SOCKET": "/fixture/tether.sock"}, "/fixture/tether.sock"),
])
def test_layout_reads_from_tether(monkeypatch, capsys, env, expected):
    for name in ("TETHER_SOCKET", "TETHER_INSTANCE"):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    layout = {"v": 1, "pid": os.getpid(), "startTime": None, "windows": []}
    calls, _ = record(monkeypatch, [(200, layout)])
    assert admin.main(["layout"]) == 0
    assert calls == [(expected, "/v1/gui/layout", None)]
    assert json.loads(capsys.readouterr().out) == {"owner": "aico", **layout}
