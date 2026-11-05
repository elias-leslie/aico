"""Guest links retain their existing origin/path contract and become an FCM Open action."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "pve-sender"))
from pve_sender import push, sender
from pve_sender.state import write

ROOT = Path(__file__).resolve().parents[3]
ORIGIN = "https://aico.example.test"


def caller(name="aico"):
    row = json.loads((ROOT / "native/pve-sender/config.json").read_text())["callers"][name]
    row["origin"] = ORIGIN if name == "aico" else "https://port.example.test"
    return row


def notice(**extra):
    return {"v": 1, "source": "aico", "kind": "question", "severity": "warning",
            "title": "Test: a question", "body": "Open Aico to answer it.", "key": "ask:abc123", **extra}


def test_ask_and_show_links_on_the_aico_origin_pass():
    for link in (f"{ORIGIN}/?ask=abc123", f"{ORIGIN}/?show=def456", f"{ORIGIN}/captures?id=7", f"{ORIGIN}/"):
        assert push.validate(json.dumps(notice(open=link)), caller())["open"] == link
    assert push.validate(json.dumps(notice()), caller())


@pytest.mark.parametrize("link", [
    "https://evil.example/?ask=1", "http://aico.example.test/?ask=1",
    "https://aico.example.test.evil.example/?ask=1", "https://user@aico.example.test/?ask=1",
    "https://aico.example.test:8443/?ask=1", f"{ORIGIN}/?ask=1#frag", f"{ORIGIN}/?ask=1 2",
    f"{ORIGIN}/?ask=" + "a" * 300, f"{ORIGIN}/é", "/?ask=1", "", None, 7,
])
def test_other_links_are_refused(link):
    with pytest.raises(ValueError):
        push.validate(json.dumps(notice(open=link)), caller())


def test_portfolio_link_may_carry_a_fragment():
    port = caller("portfolio")
    for link in ["https://port.example.test/vehicles", "https://port.example.test/money?tab=cards#card-strategy"]:
        item = notice(source="portfolio-ai", kind="todo", key="portfolio-ai:one", open=link)
        assert push.validate(json.dumps(item), port)["open"] == link
    with pytest.raises(ValueError):
        push.validate(json.dumps(notice(open=f"{ORIGIN}/?ask=1#frag")), caller())


def test_open_link_is_an_app_action_without_monkeypatching_sender(tmp_path, monkeypatch):
    cfg = {"credentials": str(tmp_path / "credentials"), "token_cache": str(tmp_path / "token"), "state_dir": str(tmp_path)}
    write(Path(cfg["credentials"]), {"fcm": {"service_account": {"project_id": "fixture", "private_key_id": "fixture"},
          "devices": [{"fcm_token": "fixture"}]}})
    write(Path(cfg["token_cache"]), {"access_token": "fixture", "key_id": "fixture", "expires_at": 9999})
    seen = []
    def transport(_dev, plain, *_args):
        seen.append(json.loads(plain))
        return 200
    monkeypatch.setattr(sender.fcm, "fcm_push", transport)
    link = f"{ORIGIN}/?ask=abc123"
    assert sender.send(cfg, notice(open=link), now=100)["ok"]
    assert seen[0]["actions"] == [{"id": "open", "label": "Open", "tier": "view", "url": link}]
