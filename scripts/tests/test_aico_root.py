"""Exact retained-root owner controls, using isolated receipts only."""

import json

import pytest

from test_aico_admin import admin

ROOT = "root-fixture"
GENERATION = "a" * 64
DESCRIPTOR = {"owner": "aico", "requestId": ROOT, "hostIdentity": "aabbcc01",
              "logicalSessionId": "aico-root-fixture", "surfaceLocator": "aico://widget/aabbcc01",
              "generation": GENERATION, "status": "running"}
ATERM = {**DESCRIPTOR, "owner": "a-term", "hostIdentity": "00000000-0000-4000-8000-000000000001",
         "surfaceLocator": "a-term://pane/00000000-0000-4000-8000-000000000002"}


def invoke(monkeypatch, args, responses):
    calls, output = [], []

    def receipt(_, endpoint, route, payload=None, **_options):
        calls.append((endpoint, route, payload))
        return responses[len(calls) - 1]

    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    transport = (["--root-url", "http://127.0.0.1:8002"] if "a-term" in args
                 else ["--root-socket", "/fixture/gui.sock"])
    if args[0] == "end" and "a-term" not in args:
        transport += ["--owner-socket", "/fixture/control.sock"]
    return admin.main(["root", *args, *transport]), calls, output


def test_status_projects_identity_only(monkeypatch):
    code, calls, output = invoke(monkeypatch, ["status", ROOT],
                                [(200, {**DESCRIPTOR, "bounds": {"x": 1}, "role": "private"})])
    assert code == 0 and calls == [("/fixture/gui.sock", f"/v1/roots/{ROOT}", None)]
    assert output == [DESCRIPTOR]


@pytest.mark.parametrize("args,payload", [
    (["show", ROOT], {"generation": GENERATION}),
    (["title", ROOT, "﻿ Private label "], {"generation": GENERATION, "label": "Private label"}),
    (["position", ROOT, "-10", "20", "900", "560"],
     {"generation": GENERATION, "bounds": {"x": -10, "y": 20, "width": 900, "height": 560}}),
])
def test_mutation_pins_generation_and_qualifies_one_receipt(monkeypatch, args, payload):
    code, calls, output = invoke(monkeypatch, args, [(200, DESCRIPTOR), (200, {**DESCRIPTOR, "label": "Private label"})])
    assert code == 0
    assert calls[1] == ("/fixture/gui.sock", f"/v1/roots/{ROOT}/{args[0]}", payload)
    assert output == [{**DESCRIPTOR, "operation": args[0], "applied": True}]
    assert "Private" not in json.dumps(output)


@pytest.mark.parametrize("args", [["title", ROOT, "line\nbreak"], ["title", ROOT, "\x85"],
                                  ["position", ROOT, "0", "0", "359", "240"],
                                  ["position", ROOT, "0", "0", "900", "560", "--surface", "a-term"],
                                  ["status", "-bad"], ["show", ROOT, "--surface", "a-term", "--root-socket", "/x"]])
def test_invalid_input_never_contacts_owner(monkeypatch, args, capsys):
    with pytest.raises(SystemExit) as error:
        invoke(monkeypatch, args, [])
    assert error.value.code == 2
    assert "\x85" not in capsys.readouterr().err


@pytest.mark.parametrize("state", ["pending", "uncertain"])
def test_non_running_root_is_not_mutated(monkeypatch, state):
    code, calls, output = invoke(monkeypatch, ["position", ROOT, "0", "0", "900", "560"],
                                [(200, {**DESCRIPTOR, "status": state})])
    assert code == 1 and len(calls) == 1
    assert output[0]["reason"] == "workload_unavailable" and output[0]["applied"] is False


@pytest.mark.parametrize("reply,applied", [
    ((409, {"error": "stale_generation"}), False), ((410, {"error": "ended"}), False),
    ((503, {"error": "gui_unavailable"}), False), ((500, {"error": "owner_failure"}), None),
    ((200, {**DESCRIPTOR, "generation": "b" * 64}), None), ((200, {**DESCRIPTOR, "status": "uncertain"}), None),
])
def test_refusal_is_not_applied_but_unqualified_reply_is_uncertain(monkeypatch, reply, applied):
    code, calls, output = invoke(monkeypatch, ["show", ROOT], [(200, DESCRIPTOR), reply])
    assert code == 1 and len(calls) == 2
    assert output[0]["applied"] is applied


def test_aico_end_uses_exact_headless_containment_contract(monkeypatch):
    code, calls, output = invoke(monkeypatch, ["end", ROOT], [(200, DESCRIPTOR), (200, {"status": "ended"})])
    assert code == 0
    assert calls[1] == ("/fixture/control.sock", "/v1/sessions/aabbcc01/end", {"generation": GENERATION})
    assert output == [{**DESCRIPTOR, "generation": None, "status": "ended", "operation": "end", "applied": True}]


@pytest.mark.parametrize("reply,applied", [
    ((409, {"error": "stale_generation"}), False), ((409, {"error": "busy"}), False),
    ((409, {"error": "blocked", "reason": "tmux state after stop is unknown"}), None),
    ((200, {"status": "ended", "extra": True}), None),
])
def test_aico_end_blocked_cleanup_is_uncertain(monkeypatch, reply, applied):
    code, _, output = invoke(monkeypatch, ["end", ROOT], [(200, DESCRIPTOR), reply])
    assert code == 1 and output[0]["applied"] is applied
    assert "tmux" not in json.dumps(output)


def test_end_of_tombstone_is_idempotent_without_owner_mutation(monkeypatch):
    ended = {**DESCRIPTOR, "generation": None, "status": "ended"}
    code, calls, output = invoke(monkeypatch, ["end", ROOT], [(200, ended)])
    assert code == 0 and len(calls) == 1
    assert output == [{**ended, "operation": "end", "applied": False}]


def test_aterm_title_and_end_use_owner_root_routes(monkeypatch):
    code, calls, output = invoke(monkeypatch, ["title", ROOT, "Focus", "--surface", "a-term"],
                                [(200, ATERM), (200, ATERM)])
    assert code == 0 and calls[1][1] == f"/v1/roots/{ROOT}/title"
    assert output[0]["applied"] is True
    ended = {**ATERM, "generation": None, "status": "ended"}
    code, calls, output = invoke(monkeypatch, ["end", ROOT, "--surface", "a-term"], [(200, ATERM), (200, ended)])
    assert code == 0 and calls[1] == ("http://127.0.0.1:8002", f"/v1/roots/{ROOT}/end", {"generation": GENERATION})
    assert output[0]["status"] == "ended" and output[0]["applied"] is True
    code, _, output = invoke(monkeypatch, ["end", ROOT, "--surface", "a-term"],
                             [(200, ATERM), (503, {"error": "close_uncertain"})])
    assert code == 1 and output[0]["applied"] is None and output[0]["reason"] == "close_uncertain"
