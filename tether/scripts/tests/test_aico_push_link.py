"""scripts/pve-push/aico-push (runs on the Proxmox host): the notice's open link and how it reaches deadman.send."""

import importlib.machinery
import importlib.util
import json
import types
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "pve-push" / "aico-push"
ORIGIN = "https://aico.example.test"


def load():
    loader = importlib.machinery.SourceFileLoader("aico_push", str(SCRIPT))
    spec = importlib.util.spec_from_loader("aico_push", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def notice(**extra):
    base = {
        "v": 1,
        "source": "aico",
        "kind": "question",
        "severity": "warning",
        "title": "Test: a question",
        "body": "Open Aico to answer it.",
        "key": "ask:abc123",
    }
    return json.dumps({**base, **extra})


def test_ask_and_show_links_on_the_aico_origin_pass():
    push = load()
    for link in (f"{ORIGIN}/?ask=abc123", f"{ORIGIN}/?show=def456", f"{ORIGIN}/captures?id=7", f"{ORIGIN}/"):
        assert isinstance(push.check(notice(open=link), ORIGIN), dict), link


def test_no_link_is_still_a_valid_notice():
    assert isinstance(load().check(notice(), ORIGIN), dict)


def test_other_links_are_refused():
    push = load()
    bad = [
        "https://evil.example/?ask=1",
        "http://aico.example.test/?ask=1",
        "https://aico.example.test.evil.example/?ask=1",
        "https://user@aico.example.test/?ask=1",
        "https://aico.example.test:8443/?ask=1",
        f"{ORIGIN}/?ask=1#frag",
        f"{ORIGIN}/?ask=1 2",
        f"{ORIGIN}/?ask=" + "a" * 300,
        f"{ORIGIN}/é",
        "/?ask=1",
        "",
        None,
        7,
    ]
    for link in bad:
        assert load().check(notice(open=link), ORIGIN) == "open must be a plain link on the Aico origin", link
    # No Aico host known to Nightshift: no link is trusted.
    assert push.check(notice(open=f"{ORIGIN}/?ask=1"), None) == "open must be a plain link on the Aico origin"


def test_send_with_link_adds_the_link_to_both_messages_and_restores_deadman():
    push = load()
    seen = {}

    def real_push(sub, payload, *rest, **kw):
        seen["web"] = payload

    def real_item(entry, base):
        return json.dumps({"title": entry["title"], "actions": []}).encode()

    def send(*args):
        deadman.push({"endpoint": "x"}, {"title": "t", "url": "/"}, "info", b"", "sub", 1.0)
        seen["app"] = json.loads(deadman.fcm_item({"title": "t"}, "https://nightshift.example.test"))
        return "sent 1/1", False

    deadman = types.SimpleNamespace(push=real_push, fcm_item=real_item, send=send)
    link = f"{ORIGIN}/?ask=abc123"
    result, carried = push.send_with_link(deadman, link)
    assert result == ("sent 1/1", False)
    assert carried == {"web", "app"}
    assert seen["web"] == {"title": "t", "url": "/", "open": link}
    assert seen["app"]["actions"] == [{"id": "open", "label": "Open", "tier": "view", "url": link}]
    assert deadman.push is real_push and deadman.fcm_item is real_item
