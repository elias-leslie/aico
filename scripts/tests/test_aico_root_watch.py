"""Bounded fixture-only tests; never connect to existing Aico roots or tmux servers."""

from __future__ import annotations

import importlib.util
import json
import os
import signal
import socketserver
import sys
import threading
import time
from contextlib import ExitStack, contextmanager
from http.server import BaseHTTPRequestHandler
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "aico_root_watch", Path(__file__).resolve().parents[1] / "aico-root-watch.py"
)
assert SPEC is not None and SPEC.loader is not None
watcher = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = watcher
SPEC.loader.exec_module(watcher)

PIN_DATA = {
    "requestId": "fixture-root",
    "widgetId": "deadbeef",
    "logicalSessionId": "aico-root-fixture",
    "generation": "a" * 64,
    "sessionId": "aico-widget-deadbeef",
    "tmuxSessionId": "$1",
    "paneId": "%2",
    "tmuxServerId": "b" * 32,
}
PIN = watcher.Pin(**PIN_DATA)


def classify(screen: str) -> dict:
    return watcher.classify(screen.encode())[0]


@pytest.mark.parametrize("screen,expected", [
    ("Worked for 3m 42s\nTask complete.\n› \n80% context left", "turn_finished"),
    ("─ Worked for 15s ──\n› ", "turn_finished"),
    ("Worked for 15s\nStill settling the summary.\n› ", "turn_finished"),
    ("Worked for 15s\nWorking toward a final summary.\n› ", "turn_finished"),
    ("Worked for 15s\nDone.\n› \n5% context left", "turn_finished"),
    ("Worked for 15s\n› earlier submission\n• Working (5s • esc to interrupt)\n› ", "busy"),
    ("Compacting context (45s • esc to interrupt)\nMaking room to continue.\n› ", "busy"),
    ("• Running tool (5s • esc to interrupt)\n› ", "busy"),
    ("• Working\n› ", "busy"),
    ("› ", "awaiting_input"),
    ("Cropped answer without current chrome", "ambiguous"),
    ("Worked for 5s\nThe answer is still redrawing", "ambiguous"),
])
def test_terminal_states(screen, expected):
    assert classify(screen)["terminal"] == expected


def test_low_context_is_advisory_and_not_incomplete():
    state = classify("Worked for 1m\nDone.\n› \n4% context left")
    assert state["terminal"] == "turn_finished"
    assert state["low_context"] is True


def test_real_aico_idle_placeholder_and_footer_are_not_a_draft():
    state = classify(
        "Worked for 1m 5s • 10:12 AM\n"
        "Done.\n\n"
        "› Ask Codex to do anything\n\n"
        "Daybreak Blue xhigh · Context 94% left · /srv/workspaces/projects/neri"
    )
    assert state["terminal"] == "turn_finished"
    assert state["draft_present"] is False
    assert state["low_context"] is False


def test_real_aico_low_context_footer_is_advisory():
    state = classify(
        "Worked for 1m 5s • 10:12 AM\n"
        "› Ask Codex to do anything\n"
        "Daybreak Blue xhigh · Context 7% left · /srv/workspaces/projects/neri"
    )
    assert state["terminal"] == "turn_finished"
    assert state["draft_present"] is False
    assert state["low_context"] is True


def test_draft_present_is_not_submission_and_is_suppressed():
    state, sample = watcher.classify(
        b"Worked for 15s\nDone.\n\xe2\x80\xba staged secret instruction\n"
        b"wrapped private draft\n5% context left"
    )
    assert state["terminal"] == "turn_finished"
    assert state["draft_present"] is True
    assert "staged secret" not in sample
    assert "wrapped private" not in sample
    assert "staged secret" not in json.dumps(state)


@pytest.mark.parametrize("warning", [
    "You've hit your usage limit. Try again later.",
    "Would you like to run the following command?",
    "⚠ Error: Connection failed",
])
def test_historical_and_quoted_warnings(warning):
    assert classify(f"{warning}\nWorked for 15s\n› ")["banners"] == []
    assert classify(f'> {warning}\n› ')["banners"] == []
    assert classify(f'"{warning}"\n› ')["banners"] == []
    assert classify(f"```text\n{warning}\n```\n› ")["banners"] == []


@pytest.mark.parametrize("screen,banner,state", [
    ("You've hit your usage limit. Try again later.\n› ", "capacity", "ambiguous"),
    ("API Error: 429 Too many requests\n› ", "capacity", "ambiguous"),
    ("Would you like to run the following command?\n1. Yes\n2. No", "approval", "awaiting_input"),
    ("Approval required: run command\n› ", "approval", "awaiting_input"),
    ("⚠ Error: Connection failed\n› ", "error", "ambiguous"),
])
def test_current_banners(screen, banner, state):
    result = classify(screen)
    assert result["banners"] == [banner]
    assert result["terminal"] == state
    assert all(marker in ("visible_screen", "input_prompt", f"current_{banner}_banner")
               for marker in result["markers"])


def test_control_sequences_credentials_and_closed_output():
    raw = ("\x1b]0;secret title\x07\x1b[31mAPI_KEY=abc123\x1b[0m\n"
           "Authorization: Bearer abc123\npassword=abc123\n"
           "sk-private123\nghp_private123\nhttps://owner:password@example.test\n"
           "No recognizable chrome").encode()
    state, sample = watcher.classify(raw)
    assert "\x1b" not in sample
    assert "abc123" not in sample
    assert "private123" not in sample
    assert "owner:password" not in sample
    assert state["terminal"] == "ambiguous"
    assert state["markers"] == ["visible_screen"]
    assert "chrome" not in json.dumps(state)


def test_fenced_activity_is_not_current_busy():
    assert classify("```text\nWorking\n```\n› ")["terminal"] == "awaiting_input"


def test_fenced_completion_marker_is_not_current_completion():
    state = classify(
        "```text\nWorked for 15s\n```\n"
        "› Ask Codex to do anything\n"
        "Daybreak Blue · Context 80% left · /workspace"
    )
    assert state["terminal"] == "awaiting_input"


def test_multiline_draft_cannot_spoof_footer_or_busy_state():
    state, sample = watcher.classify(
        b"Worked for 15s\nDone.\n"
        b"\xe2\x80\xba Remember ctrl+c next time\nWorking\n"
        b"Daybreak Blue \xc2\xb7 Context 80% left \xc2\xb7 /workspace"
    )
    assert state["terminal"] == "turn_finished"
    assert state["draft_present"] is True
    assert "Remember ctrl+c" not in sample
    assert "Working" not in sample


def test_multiline_draft_cannot_spoof_a_later_completion_marker():
    state, sample = watcher.classify(
        b"Worked for 15s\nDone.\n"
        b"\xe2\x80\xba staged text\nWorked for 25s\n"
        b"Context 80% left"
    )
    assert state["terminal"] == "turn_finished"
    assert state["draft_present"] is True
    assert "staged text" not in sample
    assert "Worked for 25s" not in sample


def test_standalone_current_context_footer_ends_draft_region():
    state = classify("Worked for 15s\n› Ask Codex to do anything\nContext 7% left")
    assert state["terminal"] == "turn_finished"
    assert state["draft_present"] is False
    assert state["low_context"] is True


def test_current_context_footer_supersedes_old_footer():
    assert classify("4% context left\nWorked for 15s\n› \n60% context left")["low_context"] is False
    assert classify(
        "Context 4% left\nWorked for 15s\n› Ask Codex to do anything\nContext 60% left"
    )["low_context"] is False


def test_quoted_and_multiline_credentials_are_redacted():
    private_key = (
        b"-----BEGIN " + b"PRIVATE KEY-----\nprivate-key-data\n"
        + b"-----END " + b"PRIVATE KEY-----"
    )
    _, sample = watcher.classify(
        b'"password": "private phrase"\n' + private_key
    )
    assert "private phrase" not in sample
    assert "private-key-data" not in sample


def test_oversized_screen_rejected_and_cropped_screen_ambiguous():
    with pytest.raises(watcher.Unavailable, match="capture_limit"):
        watcher.classify(b"x" * (watcher.CAPTURE_LIMIT + 1))
    state = classify("Tail of an answer\nNo current input/status visible")
    assert state["terminal"] == "ambiguous"


def collector():
    return watcher.Collector("/fixture/root", "/fixture/owner", "/fixture/tmux",
                             time.monotonic() + 2, threading.Event())


def root_receipt():
    return {"owner": "aico", "requestId": PIN.requestId, "hostIdentity": PIN.widgetId,
            "logicalSessionId": PIN.logicalSessionId, "generation": PIN.generation,
            "surfaceLocator": f"aico://widget/{PIN.widgetId}", "status": "running"}


def pane_receipt():
    return {"owner": "aico", **{k: PIN_DATA[k] for k in
                                ("widgetId", "generation", "sessionId", "tmuxSessionId", "paneId")}}


def fake_commands(monkeypatch, instance, screen=b"Worked for 15s\n\xe2\x80\xba \n"):
    calls = []

    def command(args, limit):
        calls.append((args, limit))
        if args[0] == "show-environment":
            return ("AICO_OWNER=aico\nAICO_WORKLOAD_CLASS=durable-tmux-server\n"
                    f"AICO_TMUX_SERVER_ID={PIN.tmuxServerId}\n").encode()
        if args[0] == "display-message":
            return f"$1\t%2\taico-{PIN.widgetId}\t0\n".encode()
        assert args == ["capture-pane", "-p", "-t", PIN.paneId]
        assert limit == watcher.CAPTURE_LIMIT
        return screen

    monkeypatch.setattr(instance, "command", command)
    return calls


def fake_receipts(monkeypatch, instance):
    calls = []

    def receipt(path, route):
        calls.append((path, route))
        return 200, root_receipt() if "/roots/" in route else pane_receipt()

    monkeypatch.setattr(instance, "receipt", receipt)
    return calls


def test_receipts_surround_visible_only_capture(monkeypatch):
    instance = collector()
    calls = fake_receipts(monkeypatch, instance)
    commands = fake_commands(monkeypatch, instance)
    state = instance.sample(PIN)
    assert state["terminal"] == "turn_finished"
    assert calls == [("/fixture/root", "/v1/roots/fixture-root"),
                     ("/fixture/owner", "/v1/sessions/deadbeef")] * 2
    assert [args[0] for args, _ in commands] == [
        "show-environment", "display-message", "capture-pane", "show-environment", "display-message"
    ]


def test_generation_change_during_capture_discards_evidence(monkeypatch):
    instance = collector()
    captures = fake_commands(monkeypatch, instance)
    count = 0

    def receipt(path, route):
        nonlocal count
        count += 1
        data = root_receipt() if "/roots/" in route else pane_receipt()
        if count >= 3:
            data["generation"] = "c" * 64
        return 200, data

    monkeypatch.setattr(instance, "receipt", receipt)
    assert instance.sample(PIN) == {"observation": "unavailable", "identity": "changed"}
    assert any(args[0] == "capture-pane" for args, _ in captures)


@pytest.mark.parametrize("field", ["hostIdentity", "logicalSessionId", "surfaceLocator"])
def test_changed_root_identity_never_captures(monkeypatch, field):
    instance = collector()
    root = root_receipt()
    root[field] = "different"
    monkeypatch.setattr(instance, "receipt", lambda *_: (200, root))
    commands = fake_commands(monkeypatch, instance)
    assert instance.sample(PIN)["identity"] == "changed"
    assert commands == []


def test_root_ended_at_baseline(monkeypatch):
    instance = collector()
    root = {**root_receipt(), "status": "ended", "generation": None}
    monkeypatch.setattr(instance, "receipt", lambda *_: (200, root))
    output = []
    assert watcher.watch(instance, [PIN], .1, 3, output.append) == "identity_ended"
    assert output[0]["event"] == "baseline"
    assert output[0]["identity"] == "ended"


@pytest.mark.parametrize("status", ["pending", "uncertain"])
def test_nonrunning_root_at_baseline(monkeypatch, status):
    instance = collector()
    root = {**root_receipt(), "status": status}
    monkeypatch.setattr(instance, "receipt", lambda *_: (200, root))
    output = []
    assert watcher.watch(instance, [PIN], .1, 1, output.append) == "observation_failures"
    assert output[0]["event"] == "baseline"
    assert output[0]["reason"] == "root_not_running"


def test_completed_at_baseline_and_redraw_dedup(monkeypatch):
    instance = collector()
    fake_receipts(monkeypatch, instance)
    samples = iter([
        "Worked for 15s\nSummary\n› \n50% context left",
        "Worked for 16s\nSummary settling\n› \n49% context left",
        "Worked for 16s\nSummary complete\n› draft one\n49% context left",
        "Worked for 16s\nSummary complete\n› different draft\n48% context left",
    ])
    count = 0
    original = instance.sample

    def sample(pin):
        nonlocal count
        fake_commands(monkeypatch, instance, next(samples).encode())
        result = original(pin)
        count += 1
        if count == 4:
            instance.cancel.set()
        return result

    monkeypatch.setattr(instance, "sample", sample)
    output = []
    assert watcher.watch(instance, [PIN], .001, 3, output.append) == "cancelled"
    assert [r["event"] for r in output] == ["baseline", "transition"]
    assert [r["draft_present"] for r in output] == [False, True]
    assert output[0]["terminal"] == "turn_finished"


def test_busy_spinner_timer_context_redraw_quiet(monkeypatch):
    instance = collector()
    screens = iter(["• Working (1s • esc to interrupt)\n› \n50% context left",
                    "⠹ Working (3s • esc to interrupt)\n› \n48% context left"])
    count = 0

    def sample(_):
        nonlocal count
        count += 1
        state = {"observation": "available", "identity": "pinned", **classify(next(screens))}
        if count == 2:
            instance.cancel.set()
        return state

    monkeypatch.setattr(instance, "sample", sample)
    output = []
    watcher.watch(instance, [PIN], .001, 3, output.append)
    assert len(output) == 1


def test_transient_unmarked_idle_redraw_is_settled(monkeypatch):
    instance = collector()
    states = iter([
        {"observation": "available", "identity": "pinned", **classify("• Working\n› ")},
        {"observation": "available", "identity": "pinned", **classify("› ")},
        {"observation": "available", "identity": "pinned", **classify("• Working\n› ")},
    ])
    count = 0

    def sample(_):
        nonlocal count
        count += 1
        state = next(states)
        if count == 3:
            instance.cancel.set()
        return state

    monkeypatch.setattr(instance, "sample", sample)
    output = []
    watcher.watch(instance, [PIN], .001, 3, output.append)
    assert [(item["event"], item["terminal"]) for item in output] == [("baseline", "busy")]


def test_persistent_unmarked_idle_emits_after_two_samples(monkeypatch):
    instance = collector()
    states = iter(["• Working\n› ", "› ", "› "])
    count = 0

    def sample(_):
        nonlocal count
        count += 1
        state = {"observation": "available", "identity": "pinned", **classify(next(states))}
        if count == 3:
            instance.cancel.set()
        return state

    monkeypatch.setattr(instance, "sample", sample)
    output = []
    watcher.watch(instance, [PIN], .001, 3, output.append)
    assert [(item["event"], item["terminal"]) for item in output] == [
        ("baseline", "busy"), ("transition", "awaiting_input")]


@contextmanager
def owner_server(tmp_path, state):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            state["routes"].append(self.path)
            status, data = state["answer"](self.path)
            raw = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, format: str, *args: object) -> None:
            pass

    path = str(tmp_path / "owner.sock")
    with socketserver.UnixStreamServer(path, Handler) as server:
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .01})
        thread.start()
        try:
            yield path
        finally:
            server.shutdown()
            thread.join(timeout=1)


def test_private_socket_transient_failure_and_exact_recovery(tmp_path, monkeypatch):
    state = {"routes": [], "answer": lambda route: (
        200, root_receipt() if "/roots/" in route else pane_receipt())}
    instance = collector()
    output = []
    with ExitStack() as stack:
        path = str(tmp_path / "owner.sock")
        instance.root_socket = path
        instance.owner_socket = path
        fake_commands(monkeypatch, instance)
        original = instance.sample
        count = 0

        def sample(pin):
            nonlocal count
            result = original(pin)
            count += 1
            if count == 1:
                assert stack.enter_context(owner_server(tmp_path, state)) == path
            else:
                instance.cancel.set()
            return result

        monkeypatch.setattr(instance, "sample", sample)
        watcher.watch(instance, [PIN], .001, 3, output.append)
    assert [r["observation"] for r in output] == ["unavailable", "available"]
    assert output[1]["generation"] == PIN.generation
    assert output[1]["terminal"] == "turn_finished"
    assert state["routes"] == ["/v1/roots/fixture-root", "/v1/sessions/deadbeef"] * 2


def test_repeated_observation_failures_stop_without_duplicate_records(monkeypatch):
    instance = collector()
    calls = 0

    def sample(_):
        nonlocal calls
        calls += 1
        return {"observation": "unavailable", "identity": "pinned", "reason": "owner_unavailable"}

    monkeypatch.setattr(instance, "sample", sample)
    output = []
    assert watcher.watch(instance, [PIN], .001, 3, output.append) == "observation_failures"
    assert calls == 3
    assert len(output) == 1


def test_expired_deadline_and_cancel_do_not_start_capture(monkeypatch):
    instance = collector()
    monkeypatch.setattr(instance, "sample", lambda _: pytest.fail("capture after stop"))
    instance.deadline = time.monotonic() - 1
    assert watcher.watch(instance, [PIN], .1, 3, lambda _: None) == "deadline"
    instance.cancel.set()
    assert watcher.watch(instance, [PIN], .1, 3, lambda _: None) == "cancelled"


def test_bounded_child_cleanup_at_deadline(monkeypatch):
    instance = collector()
    instance.deadline = time.monotonic() + .1
    original = watcher.subprocess.Popen
    processes = []

    def launch(argv, **kwargs):
        assert argv[:3] == ["tmux", "-S", "/fixture/tmux"]
        process = original([sys.executable, "-c", "import time; time.sleep(10)"], **kwargs)
        processes.append(process)
        return process

    monkeypatch.setattr(watcher.subprocess, "Popen", launch)
    with pytest.raises(watcher.Stopped):
        instance.command(["capture-pane", "-p", "-t", "%2"], 10)
    assert len(processes) == 1
    assert processes[0].poll() == -signal.SIGKILL
    assert processes[0].stdout.closed


def test_oversized_child_cleanup(monkeypatch):
    instance = collector()
    original = watcher.subprocess.Popen
    processes = []

    def launch(_argv, **kwargs):
        process = original([sys.executable, "-c",
                            "import os,time; os.write(1,b'x'*50000); time.sleep(10)"], **kwargs)
        processes.append(process)
        return process

    monkeypatch.setattr(watcher.subprocess, "Popen", launch)
    with pytest.raises(watcher.Unavailable, match="capture_limit"):
        instance.command(["capture-pane", "-p", "-t", "%2"], watcher.CAPTURE_LIMIT)
    assert processes[0].poll() == -signal.SIGKILL
    assert processes[0].stdout.closed


def test_cancel_terminates_running_child(monkeypatch):
    instance = collector()
    original = watcher.subprocess.Popen
    processes = []

    def launch(_argv, **kwargs):
        process = original([sys.executable, "-c", "import time; time.sleep(10)"], **kwargs)
        processes.append(process)
        instance.cancel.set()
        return process

    monkeypatch.setattr(watcher.subprocess, "Popen", launch)
    with pytest.raises(watcher.Stopped):
        instance.command(["capture-pane", "-p", "-t", "%2"], 10)
    assert processes[0].poll() is not None


def test_stalled_output_pipe_stops_at_deadline_and_restores_flags():
    instance = collector()
    instance.deadline = time.monotonic() + .05
    reader, writer = os.pipe()
    try:
        os.set_blocking(writer, False)
        while True:
            try:
                os.write(writer, b"x" * 4096)
            except BlockingIOError:
                break
        os.set_blocking(writer, True)
        with pytest.raises(watcher.Stopped):
            watcher.emit_json(instance, {"event": "baseline"}, writer)
        assert os.get_blocking(writer)
    finally:
        os.close(reader)
        os.close(writer)


def test_pin_and_socket_validation():
    assert watcher.Pin.parse(json.dumps(PIN_DATA)) == PIN
    for field in ("paneId", "generation", "tmuxServerId"):
        with pytest.raises(ValueError):
            watcher.Pin.parse(json.dumps({**PIN_DATA, field: "wrong"}))
    for value in ("relative.sock", "/tmp/../wrong", "/tmp//wrong", "/tmp/a\n.sock"):
        with pytest.raises(watcher.argparse.ArgumentTypeError):
            watcher.socket_path(value)


def test_cli_rejects_roots_from_different_tmux_servers():
    other = {**PIN_DATA, "requestId": "other-root", "widgetId": "feedface",
             "logicalSessionId": "aico-root-other", "tmuxServerId": "c" * 32}
    with pytest.raises(SystemExit) as error:
        watcher.main([
            "--root-socket", "/tmp/root", "--owner-socket", "/tmp/owner",
            "--tmux-socket", "/tmp/tmux", "--root", json.dumps(PIN_DATA),
            "--root", json.dumps(other), "--duration", "1",
        ])
    assert error.value.code == 2


@pytest.mark.parametrize("duration", ["nan", "inf", "0", "3601"])
def test_cli_rejects_unbounded_duration(duration):
    with pytest.raises(SystemExit) as error:
        watcher.main(["--root-socket", "/tmp/root", "--owner-socket", "/tmp/owner",
                      "--tmux-socket", "/tmp/tmux", "--root", json.dumps(PIN_DATA),
                      "--duration", duration])
    assert error.value.code == 2


def test_cli_does_not_print_invalid_secret_configuration(capsys):
    with pytest.raises(SystemExit):
        watcher.main(["--root-socket", "/tmp/root", "--owner-socket", "/tmp/owner",
                      "--tmux-socket", "/tmp/tmux", "--root", '{"api_key":"private-secret"}',
                      "--duration", "1"])
    assert "private-secret" not in capsys.readouterr().err
