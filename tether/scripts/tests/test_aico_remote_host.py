"""st aico on a remote host (hosts.json): create --host and the hub's remote roots."""

import shlex

import pytest
from aico_cli_fixtures import admin, descriptor


@pytest.fixture(autouse=True)
def outside_aico(monkeypatch, tmp_path):
    monkeypatch.delenv("AICO_WIDGET_ID", raising=False)
    monkeypatch.setattr(admin, "PROC", tmp_path)
    monkeypatch.setattr(admin.Path, "home", lambda: tmp_path)
    monkeypatch.setenv("XDG_RUNTIME_DIR", "/run/user/1000")


CONTROL = "/run/user/1000/tether/peers/agent-work/ssh.ctl"
HOSTS = {"items": [{"name": "agent-work", "ssh": "agent-work", "control": CONTROL, "state": "connected"}]}
TOOLS = {"items": [{"slug": "claude-code", "enabled": True, "rootCapable": True},
                   {"slug": "shell", "enabled": True, "rootCapable": False}]}


def on_host(tool="claude-code"):
    return ["create", "remote-1", "Start.", "--tool", tool, "--project", "aico",
            "--project-root", "/srv/workspaces/projects/aico", "--host", "agent-work"]


def owner(calls, create=None, tools=(200, TOOLS)):
    def receipt(_, path, route, payload=None, **kwargs):
        calls.append((route, payload, kwargs.get("timeout")))
        if route.startswith("/v1/tools"):
            return tools
        if create:
            return create(payload)
        return 200, descriptor(payload)
    return receipt


def test_create_on_a_host_sends_the_host_outside_the_digest_and_waits_for_it(monkeypatch, capsys):
    calls, output = [], []
    monkeypatch.setattr(admin.Collector, "receipt", owner(calls))
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    # This computer's Codex catalog says nothing about the host's.
    monkeypatch.setattr(admin, "codex_model_unavailable", lambda *_: pytest.fail("checked local Codex"))
    assert admin.main(on_host()) == 0
    assert [route for route, *_ in calls] == ["/v1/tools?host=agent-work", "/v1/roots"]
    _, payload, timeout = calls[1]
    assert payload["host"] == "agent-work" and timeout == admin.HOST_CREATE_SECONDS
    # The digest the fixture computes ignores host, and the receipt matched it.
    assert output[0]["status"] == "running" and output[0]["host"] == "agent-work"
    assert "power on" in capsys.readouterr().err


def test_a_tool_the_host_cannot_start_is_refused_before_the_create(monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(admin.Collector, "receipt", owner(calls))
    with pytest.raises(SystemExit) as exit_info:
        admin.main(on_host("shell"))
    assert exit_info.value.code == 2
    assert [route for route, *_ in calls] == ["/v1/tools?host=agent-work"]
    assert "agent-work cannot start --tool shell; tools it can start: claude-code" in capsys.readouterr().err


def test_an_unknown_host_is_refused_before_the_create(monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(admin.Collector, "receipt", owner(calls, tools=(400, {"error": "unknown_host"})))
    with pytest.raises(SystemExit):
        admin.main(on_host())
    assert len(calls) == 1 and "no host named agent-work" in capsys.readouterr().err


def test_a_host_that_cannot_list_its_tools_yet_still_gets_the_create(monkeypatch):
    calls, output = [], []
    monkeypatch.setattr(admin.Collector, "receipt", owner(calls, tools=(409, {"error": "host_unavailable"})))
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    assert admin.main(on_host()) == 0
    assert calls[-1][0] == "/v1/roots"


def test_a_host_that_does_not_come_up_says_why(monkeypatch):
    calls, output = [], []
    refusal = (409, {"error": "host_unavailable", "host": "agent-work",
                     "reason": "agent-work did not come up within 240 s"})
    monkeypatch.setattr(admin.Collector, "receipt", owner(calls, create=lambda _: refusal))
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    assert admin.main(on_host()) == 1
    assert output[0]["reason"] == "host_unavailable"
    assert output[0]["detail"] == "agent-work did not come up within 240 s"


@pytest.mark.parametrize("host", ["Agent-Work", "-x", "a b", "a" * 40])
def test_malformed_host_never_contacts_owner(monkeypatch, host):
    monkeypatch.setattr(admin.Collector, "receipt", lambda *_a, **_k: pytest.fail("contacted owner"))
    with pytest.raises(SystemExit) as exit_info:
        admin.main([*on_host()[:-1], host])
    assert exit_info.value.code == 2


def collector(hosts=(200, HOSTS)):
    item = admin.Collector("/fixture/gui.sock", "/fixture/owner.sock", "/tmp/tmux-1000/default",
                           admin.time.monotonic() + 5, admin.threading.Event())
    item.receipt = lambda *_a, **_k: hosts
    return item


def test_the_link_to_a_host_is_the_hubs_own_control_socket():
    assert collector().link("agent-work") == ("agent-work", "agent-work", CONTROL)


@pytest.mark.parametrize("item", [
    {"name": "agent-work", "ssh": "agent-work", "control": "/tmp/elsewhere.ctl"},
    {"name": "agent-work", "ssh": "-oProxyCommand=x", "control": CONTROL},
    {"name": "other", "ssh": "other", "control": CONTROL},
])
def test_a_link_that_does_not_check_out_is_unavailable(item):
    with pytest.raises(admin.Unavailable) as error:
        collector((200, {"items": [item]})).link("agent-work")
    assert str(error.value) == "host_unavailable"


def test_a_remote_roots_tmux_runs_through_the_link(monkeypatch):
    seen = []

    class Process:
        def __init__(self, argv, **_kwargs):
            seen.append(argv)
            raise OSError("stop here")

    monkeypatch.setattr(admin.subprocess, "Popen", Process)
    remote = collector()
    remote.remote = remote.link("agent-work")
    with pytest.raises(admin.Unavailable):
        remote.command(["display-message", "-p", "-t", "%1", "#{pane_id} x"], 100)
    argv = seen[0]
    assert argv[:11] == [admin.SSH, "-F", "/dev/null", "-T", "-o", "BatchMode=yes",
                         "-o", "ProxyCommand=false", "-S", CONTROL, "agent-work"]
    assert argv[11] == "--"
    assert shlex.split(argv[12]) == [admin.REMOTE_TMUX, "-S", "/tmp/tmux-1000/default",
                                     "display-message", "-p", "-t", "%1", "#{pane_id} x"]


def test_roots_of_a_host_the_hub_cannot_reach_are_reported_unavailable():
    roots = {"owner": "aico", "roots": [{"requestId": "remote-1", "status": "running", "owner": "aico",
                                         "host": "agent-work", "peer": "offline"}]}
    discovery = collector()
    discovery.receipt = lambda *_a, **_k: (200, roots)
    resolved, unavailable = discovery.discover(None)
    assert resolved == []
    assert unavailable == [{"requestId": "remote-1", "observation": "unavailable", "identity": "unresolved",
                            "host": "agent-work", "reason": "host_unavailable"}]


@pytest.mark.parametrize("model", [[], ["--model", "gpt-6-sol"]])
@pytest.mark.parametrize("host", [[], ["--host", "agent-work"]])
def test_pi_without_a_provider_model_is_refused_with_the_reason(monkeypatch, capsys, model, host):
    # Pi has no default model, here or on a host: say so instead of a bare invalid_body.
    monkeypatch.setattr(admin.Collector, "receipt", lambda *_a, **_k: pytest.fail("contacted owner"))
    argv = [*on_host("pi")[:-2], *host, *model] if host else [*on_host("pi")[:-2], *model]
    with pytest.raises(SystemExit) as exit_info:
        admin.main(argv)
    assert exit_info.value.code == 2
    assert "pi needs --model provider/model" in capsys.readouterr().err


def test_pi_with_a_provider_model_is_sent_to_the_host(monkeypatch):
    calls, output = [], []
    tools = {"items": [{"slug": "pi", "enabled": True, "rootCapable": True}]}
    monkeypatch.setattr(admin.Collector, "receipt", owner(calls, tools=(200, tools)))
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    assert admin.main([*on_host("pi"), "--model", "openai/gpt-6-sol"]) == 0
    assert calls[1][1]["model"] == "openai/gpt-6-sol"


def test_the_hosts_reason_for_a_refused_model_is_printed(monkeypatch):
    calls, output = [], []
    tools = {"items": [{"slug": "claude-code", "enabled": True, "rootCapable": True}]}
    refusal = (400, {"error": "invalid_body", "field": "model", "reason": "pi needs --model provider/model"})
    monkeypatch.setattr(admin.Collector, "receipt", owner(calls, create=lambda _: refusal, tools=(200, tools)))
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    assert admin.main(on_host()) == 1
    assert output[0]["reason"] == "invalid_body"
    assert output[0]["detail"] == "pi needs --model provider/model"


# root status: the host of a remote root, and whether its agent is still in the pane.
STATUS = {"owner": "aico", "requestId": "remote-1", "hostIdentity": "aabbcc01", "logicalSessionId": "aico-root-x",
          "surfaceLocator": "aico://widget/aabbcc01", "generation": "a" * 64, "status": "running"}


def root_status(monkeypatch, data):
    output = []

    def receipt(_, endpoint, route, payload=None, **_options):
        return 200, data

    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    code = admin.main(["root", "status", "remote-1", "--root-socket", "/fixture/gui.sock"])
    return code, output


def test_root_status_names_the_host_of_a_remote_root(monkeypatch):
    code, output = root_status(monkeypatch, {**STATUS, "host": "agent-work"})
    assert code == 0 and output[0]["host"] == "agent-work"


@pytest.mark.parametrize("host", [None, "", "-x", "A b", 7])
def test_root_status_shows_no_host_for_a_local_root(monkeypatch, host):
    code, output = root_status(monkeypatch, {**STATUS, "host": host})
    assert code == 0 and "host" not in output[0]


@pytest.mark.parametrize("foreground, agent", [("bash", "exited"), ("-bash", "exited"), ("node", "running")])
def test_root_status_says_when_the_agent_left_the_pane(monkeypatch, foreground, agent):
    # A Pi root that failed closed (no credential) leaves the pane at bash; the session record still runs.
    pin = admin.Pin("remote-1", "aabbcc01", "aico-root-x", "a" * 64, "sess-1", "$1", "%2", "abcdef01")
    shown = []

    class Child:
        def owners(self, _pin):
            shown.append("owners")

        def pane(self, _pin):
            return foreground

    monkeypatch.setattr(admin.Collector, "discover", lambda self, request_id: ([(pin, Child())], []))
    code, output = root_status(monkeypatch, {**STATUS, "host": "agent-work", "tool": "pi"})
    assert code == 0 and output[0]["status"] == "running" and output[0]["agent"] == agent
    assert ("detail" in output[0]) == (agent == "exited")
    assert output[0]["host"] == "agent-work"


def test_root_status_without_a_readable_pane_says_nothing_about_the_agent(monkeypatch):
    def unreachable(self, request_id):
        raise admin.Unavailable("host_unavailable")

    monkeypatch.setattr(admin.Collector, "discover", unreachable)
    code, output = root_status(monkeypatch, {**STATUS, "host": "agent-work", "tool": "pi"})
    assert code == 0 and output[0]["status"] == "running" and "agent" not in output[0]
