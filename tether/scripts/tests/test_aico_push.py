"""scripts/pve-push/aico-push: the gem container's push-only forced command (a fake sender, no network)."""

import importlib.machinery
import importlib.util
import io
import json
import sys
import types
from pathlib import Path

import pytest

PATH = Path(__file__).resolve().parents[3] / "scripts" / "pve-push" / "aico-push"

NOTICE = {
    "v": 1, "source": "aico", "kind": "question", "severity": "warning",
    "title": "An agent is waiting on you", "body": "A session has a question for you. Open Aico to answer it.",
    "key": "ask:0123456789ab", "push": "phone", "open": "https://aico.example/?ask=0123456789ab",
}


@pytest.fixture
def push(monkeypatch, tmp_path):
    sent, log, carried, pushed = [], tmp_path / "log.json", [], []
    def read_json(path, default):
        return json.loads(path.read_text()) if path.exists() else default

    def send(creds, title, body, detail, severity, key, now, log_path, fcm):
        sent.append((title, body, severity, key))
        # What deadman.send does with a push: one Web Push payload and one app item.
        fake.push({"endpoint": "x"}, {"title": title, "url": "/"}, severity, b"", "sub", now)
        carried.append(json.loads(fake.fcm_item({"title": title}, "https://nightshift.example"))["actions"])
        log.write_text(json.dumps([*read_json(log, []), {"key": key}]))
        return "sent 1/1, app 1/1", False

    fake = types.SimpleNamespace(
        STATE_DIR=tmp_path, CREDS=tmp_path / "creds.json", _read_json=read_json,
        load_creds=lambda _: ("creds",), load_fcm=lambda _: None, send=send,
        push=lambda sub, payload, *rest: pushed.append(payload),
        fcm_item=lambda entry, base: json.dumps({"title": entry["title"], "actions": []}).encode(),
    )
    siteconf = types.SimpleNamespace(open_hosts=lambda: ["dev.example", "aico.example"])
    pkg = types.SimpleNamespace(deadman=fake, siteconf=siteconf)
    monkeypatch.setitem(sys.modules, "nightshift", pkg)
    monkeypatch.setitem(sys.modules, "nightshift.deadman", fake)
    monkeypatch.setitem(sys.modules, "nightshift.siteconf", siteconf)
    loader = importlib.machinery.SourceFileLoader("aico_push", str(PATH))
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader("aico_push", loader))
    loader.exec_module(module)

    def run(text):
        monkeypatch.setattr(sys, "stdin", io.StringIO(text))
        return module.main()

    return run, sent, types.SimpleNamespace(pushed=pushed, carried=carried)


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
