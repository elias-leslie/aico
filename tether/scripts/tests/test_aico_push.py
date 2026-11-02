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
    sent, log = [], tmp_path / "log.json"
    def read_json(path, default):
        return json.loads(path.read_text()) if path.exists() else default

    def send(creds, title, body, detail, severity, key, now, log_path, fcm):
        sent.append((title, body, severity, key))
        log.write_text(json.dumps([*read_json(log, []), {"key": key}]))
        return "sent 1/1, app 1/1", False

    fake = types.SimpleNamespace(
        STATE_DIR=tmp_path, CREDS=tmp_path / "creds.json", _read_json=read_json,
        load_creds=lambda _: ("creds",), load_fcm=lambda _: None, send=send,
    )
    pkg = types.SimpleNamespace(deadman=fake)
    monkeypatch.setitem(sys.modules, "nightshift", pkg)
    monkeypatch.setitem(sys.modules, "nightshift.deadman", fake)
    loader = importlib.machinery.SourceFileLoader("aico_push", str(PATH))
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader("aico_push", loader))
    loader.exec_module(module)

    def run(text):
        monkeypatch.setattr(sys, "stdin", io.StringIO(text))
        return module.main()

    return run, sent


def test_sends_the_notice_once_per_key(push, capsys):
    run, sent = push
    assert run(json.dumps(NOTICE)) == 0
    assert sent == [(NOTICE["title"], NOTICE["body"], "warning", "aico:ask:0123456789ab")]
    assert run(json.dumps(NOTICE)) == 0
    assert len(sent) == 1
    assert "already sent" in capsys.readouterr().out


@pytest.mark.parametrize("patch", [
    {"source": "nightshift"}, {"v": 2}, {"kind": "critical"}, {"severity": "critical"}, {"title": ""},
    {"title": "x" * 121}, {"body": "bell\u0007"}, {"key": "ask:../x"}, {"key": "nokey"}, {"key": 7},
])
def test_refuses_anything_that_is_not_a_plain_aico_notice(push, patch):
    run, sent = push
    assert run(json.dumps({**NOTICE, **patch})) == 2
    assert sent == []


@pytest.mark.parametrize("text", ["", "not json", "[]", "x" * 9000])
def test_refuses_bad_input(push, text):
    run, sent = push
    assert run(text) == 2
    assert sent == []
