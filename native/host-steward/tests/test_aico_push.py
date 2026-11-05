"""native/pve-sender/aico-push: the gem container's push-only forced command (a fake sender, no network)."""

import io
import json
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "pve-sender"))

PATH = Path(__file__).resolve().parents[3] / "native" / "pve-sender" / "aico-push"

NOTICE = {
    "v": 1, "source": "aico", "kind": "question", "severity": "warning",
    "title": "An agent is waiting on you", "body": "A session has a question for you. Open Aico to answer it.",
    "key": "ask:0123456789ab", "push": "phone", "open": "https://aico.example/?ask=0123456789ab",
}


@pytest.fixture
def push(monkeypatch, tmp_path):
    from pve_sender import cli, sender
    sent, carried = [], []
    cfg = json.loads((PATH.parent / "config.json").read_text())
    cfg["state_dir"] = str(tmp_path)
    cfg["callers"]["aico"]["origin"] = "https://aico.example"
    cfg["callers"]["portfolio"]["origin"] = "https://port.example"
    config = tmp_path / "config.json"
    config.write_text(json.dumps(cfg))
    def send(_cfg, notice, _now):
        sent.append((notice["title"], notice["body"], notice["severity"], notice["key"]))
        carried.append(notice.get("open"))
        return {"ok": True, "result": "sent"}
    monkeypatch.setattr(sender, "send", send)
    def run(text, *argv):
        monkeypatch.setattr(sys, "stdin", io.StringIO(text))
        try:
            return cli.main(["--config", str(config), "push", *argv])
        except SystemExit as error:
            return error.code
    return run, sent, types.SimpleNamespace(carried=carried, log=tmp_path / "receipts.json")


def test_sends_the_notice_once_per_key(push, capsys):
    run, sent, _wire = push
    assert run(json.dumps(NOTICE)) == 0
    assert sent == [(NOTICE["title"], NOTICE["body"], "warning", "aico:ask:0123456789ab")]
    assert run(json.dumps(NOTICE)) == 0
    assert len(sent) == 1
    assert "Already sent" in capsys.readouterr().out


def test_the_open_link_reaches_the_sender(push):
    run, _sent, wire = push
    assert run(json.dumps(NOTICE)) == 0
    assert wire.carried == [NOTICE["open"]]


def test_a_notice_without_a_link_goes_out_as_before(push):
    run, _sent, wire = push
    assert run(json.dumps({k: v for k, v in NOTICE.items() if k != "open"})) == 0
    assert wire.carried == [None]


@pytest.mark.parametrize("patch", [
    {"source": "nightshift"}, {"v": 2}, {"kind": "critical"}, {"severity": "critical"}, {"title": ""},
    {"title": "x" * 121}, {"body": "bell\u0007"}, {"key": "ask:../x"}, {"key": "nokey"}, {"key": 7},
    {"open": "https://evil.example/?ask=0123456789ab"}, {"open": "http://aico.example/?ask=0123456789ab"},
    {"open": "https://aico.example.evil.example/"}, {"open": "https://aico.example/?ask=" + "a" * 300},
])
def test_refuses_anything_that_is_not_a_plain_aico_notice(push, patch):
    run, sent, _wire = push
    assert run(json.dumps({**NOTICE, **patch})) == 2
    assert sent == []


@pytest.mark.parametrize("text", ["", "not json", "[]", "x" * 9000])
def test_refuses_bad_input(push, text):
    run, sent, _wire = push
    assert run(text) == 2
    assert sent == []


PORT = {
    "v": 1, "source": "portfolio-ai", "kind": "todo", "severity": "warning",
    "title": "Truck: oil change is coming up", "body": "Oil change on the Truck (300 mi to go).",
    "open": "https://port.example/vehicles", "actions": ["open"], "primary": "open", "cooldown": 0,
    "key": "portfolio-ai:vehicle:truck-oil",
}


def test_the_default_caller_is_aico_and_an_extra_argument_is_refused(push):
    run, sent, _wire = push
    assert run(json.dumps(NOTICE), "aico") == 0
    assert run(json.dumps(NOTICE), "nobody") == 2
    assert run(json.dumps(NOTICE), "aico", "portfolio") == 2
    assert len(sent) == 1


def test_portfolio_notice_is_taken_as_built_and_ignores_actions(push):
    run, sent, wire = push
    assert run(json.dumps(PORT), "portfolio") == 0
    assert sent == [(PORT["title"], PORT["body"], "warning", "portfolio-ai:vehicle:truck-oil")]
    assert wire.carried == [PORT["open"]]


@pytest.mark.parametrize("patch", [
    {"kind": "alert", "severity": "critical", "body": "b" * 1000},
    {"open": "https://port.example/money?tab=cards#card-strategy"},
    {"open": "https://port.example/money?tab=spending"},
    {"kind": "info", "severity": "info", "push": "tray"},
])
def test_portfolio_accepts_what_its_alerts_send(push, patch):
    run, sent, _wire = push
    assert run(json.dumps({**PORT, **patch}), "portfolio") == 0
    assert len(sent) == 1


def test_a_tray_only_portfolio_notice_goes_out_silent(push):
    run, sent, _wire = push
    assert run(json.dumps({**PORT, "severity": "warning", "push": "tray"}), "portfolio") == 0
    assert sent[0][2] == "info"


@pytest.mark.parametrize("patch", [
    {"source": "aico"}, {"kind": "question"}, {"title": ""}, {"title": "x" * 201}, {"body": "b" * 1001},
    {"key": "aico:ask:0123456789ab"}, {"key": "portfolio-ai:a b"}, {"key": "portfolio-ai:" + "k" * 81},
    {"key": "portfolio-ai:"}, {"key": "other:x"},
    {"open": "https://aico.example/"}, {"open": "https://evil.example/money"},
    {"open": "https://port.example.evil.example/"}, {"open": "http://port.example/money"},
    {"open": "https://port.example/money#a b"},
])
def test_portfolio_refuses_what_is_not_its_notice(push, patch):
    run, sent, _wire = push
    assert run(json.dumps({**PORT, **patch}), "portfolio") == 2
    assert sent == []


def test_an_aico_notice_is_refused_over_the_portfolio_caller_and_the_reverse(push):
    run, sent, _wire = push
    assert run(json.dumps(NOTICE), "portfolio") == 2
    assert run(json.dumps(PORT)) == 2
    assert run(json.dumps(PORT), "aico") == 2
    assert sent == []


def test_aico_keeps_its_strict_key_and_links(push):
    run, sent, _wire = push
    assert run(json.dumps({**NOTICE, "key": "portfolio-ai:x"})) == 2
    assert run(json.dumps({**NOTICE, "open": "https://port.example/"})) == 2
    assert run(json.dumps({**NOTICE, "severity": "critical"})) == 2
    assert sent == []


def test_portfolio_dedupes_within_its_window_only(push, capsys):
    run, sent, wire = push
    assert run(json.dumps(PORT), "portfolio") == 0
    assert run(json.dumps(PORT), "portfolio") == 0
    assert len(sent) == 1 and "Already sent" in capsys.readouterr().out
    old = json.loads(wire.log.read_text())
    old[PORT["key"]] -= 90000
    wire.log.write_text(json.dumps(old))
    assert run(json.dumps(PORT), "portfolio") == 0
    assert len(sent) == 2
