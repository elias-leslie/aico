"""Aico on CT 190 relays finished phone items through the Proxmox sender (push caller `aico`)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "native/pve-sender"))
from pve_sender import push, sender
from pve_sender.state import write


@pytest.fixture
def cfg(tmp_path):
    data = json.loads((ROOT / "native/pve-sender/config.json").read_text())
    data["state_dir"] = str(tmp_path)
    data["credentials"] = str(tmp_path / "creds.json")
    data["token_cache"] = str(tmp_path / "token.json")
    write(Path(data["credentials"]), {"fcm": {"service_account": {"project_id": "fixture", "private_key_id": "fixture"},
          "devices": [{"fcm_token": "fixture", "enc_pub": "fixture", "auth": "fixture"}]}})
    write(Path(data["token_cache"]), {"access_token": "fixture", "key_id": "fixture", "expires_at": 9999})
    return data


def item(**over):
    url = "https://aico.summitflow.dev/status"
    return {"v": 1, "id": "a1b2c3d4e5f6", "title": "Backups failed", "body": "Nightly copy stopped.",
            "detail": "Source: aico\nIf you leave it: no copy tonight.", "severity": "critical",
            "channel": "critical", "tag": "status:backup", "group": "status", "kind": "manual", "ts": 100,
            "url": url, "actions": [{"id": "open", "label": "Open", "tier": "view", "url": url}],
            "public": "Aico: critical alert", **over}


def relay(**over):
    return json.dumps({"v": 1, "source": "aico", "kind": "relay", "item": item(**over)})


def test_relay_sends_the_item_once_per_phone_and_keeps_critical(cfg, monkeypatch):
    sent = []
    def fcm_push(_device, plain, severity, _project, _token):
        sent.append((json.loads(plain), severity))
        return 200
    monkeypatch.setattr(sender.fcm, "fcm_push", fcm_push)
    assert push.push(cfg, "aico", relay(), now=100)["ok"]
    assert push.push(cfg, "aico", relay(), now=200)["ok"]
    assert len(sent) == 1
    assert sent[0][1] == "critical" and sent[0][0]["title"] == "Backups failed"


def test_relay_without_a_phone_route_is_not_ok(cfg):
    write(Path(cfg["credentials"]), {"fcm": {"devices": []}})
    assert not push.push(cfg, "aico", relay(), now=100)["ok"]


@pytest.mark.parametrize("over", [
    {"url": "https://evil.example/status"},
    {"actions": [{"id": "open", "label": "Open", "tier": "view", "url": "https://aico.summitflow.dev.evil/x"}]},
    {"severity": "panic"},
    {"id": "../../etc"},
    {"title": ""},
    {"extra": 1},
])
def test_relay_refuses_items_outside_the_contract(cfg, over):
    with pytest.raises(ValueError):
        push.push(cfg, "aico", relay(**over), now=100, send=lambda _item: {"ok": True})


def test_relay_is_only_for_the_aico_caller(cfg):
    with pytest.raises((ValueError, KeyError)):
        push.push(cfg, "portfolio", relay(), now=100, send=lambda _item: {"ok": True})
