"""native/pve-sender/aico-push: the gem container's push-only forced command (a fake sender, no network)."""

import importlib.machinery
import importlib.util
import io
import json
import sys
import types
from pathlib import Path

import pytest

PATH = Path(__file__).resolve().parents[3] / "native" / "pve-sender" / "aico-push"

NOTICE = {
    "v": 1, "source": "aico", "kind": "question", "severity": "warning",
    "title": "An agent is waiting on you", "body": "A session has a question for you. Open Aico to answer it.",
    "key": "ask:0123456789ab", "push": "phone", "open": "https://aico.example/?ask=0123456789ab",
}


@pytest.fixture
def push(monkeypatch, tmp_path):
    sent, log, carried, pushed, details = [], tmp_path / "log.json", [], [], []
    def read_json(path, default):
        return json.loads(path.read_text()) if path.exists() else default

    def send(creds, title, body, detail, severity, key, now, log_path, fcm):
        sent.append((title, body, severity, key))
        details.append(detail)
        # What deadman.send does with a push: one Web Push payload and one app item.
        fake.push({"endpoint": "x"}, {"title": title, "url": "/"}, severity, b"", "sub", now)
        carried.append(json.loads(fake.fcm_item({"title": title}, "https://nightshift.example"))["actions"])
        log.write_text(json.dumps([*read_json(log, []), {"key": key, "ts": now}]))
        return "sent 1/1, app 1/1", False

    fake = types.SimpleNamespace(
        STATE_DIR=tmp_path, CREDS=tmp_path / "creds.json", _read_json=read_json,
        load_creds=lambda _: ("creds",), load_fcm=lambda _: None, send=send,
        push=lambda sub, payload, *rest: pushed.append(payload),
        fcm_item=lambda entry, base: json.dumps({"title": entry["title"], "actions": []}).encode(),
    )
    siteconf = types.SimpleNamespace(open_hosts=lambda: ["dev.example", "aico.example", "port.example"])
    pkg = types.SimpleNamespace(deadman=fake, siteconf=siteconf)
    monkeypatch.setitem(sys.modules, "nightshift", pkg)
    monkeypatch.setitem(sys.modules, "nightshift.deadman", fake)
    monkeypatch.setitem(sys.modules, "nightshift.siteconf", siteconf)
    loader = importlib.machinery.SourceFileLoader("aico_push", str(PATH))
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader("aico_push", loader))
    loader.exec_module(module)

    def run(text, *argv):
        monkeypatch.setattr(sys, "stdin", io.StringIO(text))
        return module.main(list(argv))

    return run, sent, types.SimpleNamespace(pushed=pushed, carried=carried, details=details, log=log, module=module)


def test_sends_the_notice_once_per_key(push, capsys):
    run, sent, _wire = push
    assert run(json.dumps(NOTICE)) == 0
    assert sent == [(NOTICE["title"], NOTICE["body"], "warning", "aico:ask:0123456789ab")]
    assert run(json.dumps(NOTICE)) == 0
    assert len(sent) == 1
    assert "already sent" in capsys.readouterr().out


def test_the_open_link_reaches_the_web_push_payload_and_the_app_button(push):
    run, _sent, wire = push
    assert run(json.dumps(NOTICE)) == 0
    assert wire.pushed == [{"title": NOTICE["title"], "url": "/", "open": NOTICE["open"]}]
    assert wire.carried == [[{"id": "open", "label": "Open", "tier": "view", "url": NOTICE["open"]}]]


def test_a_notice_without_a_link_goes_out_as_before(push):
    run, _sent, wire = push
    assert run(json.dumps({k: v for k, v in NOTICE.items() if k != "open"})) == 0
    assert wire.pushed == [{"title": NOTICE["title"], "url": "/"}]
    assert wire.carried == [[]]


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
    run, sent, wire = push
    assert run(json.dumps(NOTICE), "aico") == 0
    assert wire.details == ["Sent for Aico on the gem container, which has no Nightshift of its own."]
    assert run(json.dumps(NOTICE), "nobody") == 2
    assert run(json.dumps(NOTICE), "aico", "portfolio") == 2
    assert len(sent) == 1


def test_portfolio_notice_is_taken_as_built_and_ignores_actions(push):
    run, sent, wire = push
    assert run(json.dumps(PORT), "portfolio") == 0
    assert sent == [(PORT["title"], PORT["body"], "warning", "portfolio-ai:vehicle:truck-oil")]
    assert wire.details == ["Sent for Portfolio-AI on VM 180, which has no Nightshift of its own."]
    assert wire.pushed == [{"title": PORT["title"], "url": "/", "open": PORT["open"]}]


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
    assert len(sent) == 1 and "already sent" in capsys.readouterr().out
    old = json.loads(wire.log.read_text())
    old[0]["ts"] -= 90000
    wire.log.write_text(json.dumps(old))
    assert run(json.dumps(PORT), "portfolio") == 0
    assert len(sent) == 2
