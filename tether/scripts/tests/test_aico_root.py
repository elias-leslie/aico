"""Exact retained-root owner controls, using isolated receipts only."""

import json

import pytest
from test_aico_admin import admin

ROOT = "root-fixture"
GENERATION = "a" * 64
DESCRIPTOR = {"owner": "aico", "requestId": ROOT, "hostIdentity": "aabbcc01",
              "logicalSessionId": "aico-root-fixture", "surfaceLocator": "aico://widget/aabbcc01",
              "generation": GENERATION, "status": "running"}
PRE_TETHER_WEB_ROOT = {**DESCRIPTOR, "owner": "a-term", "hostIdentity": "00000000-0000-4000-8000-000000000001",
                       "surfaceLocator": "a-term://pane/00000000-0000-4000-8000-000000000002"}


def invoke(monkeypatch, args, responses):
    calls, output = [], []

    def receipt(_, endpoint, route, payload=None, **_options):
        calls.append((endpoint, route, payload))
        return responses[len(calls) - 1]

    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    transport = ["--root-socket", "/fixture/gui.sock"]
    if args[0] in ("end", "send"):
        transport += ["--owner-socket", "/fixture/control.sock"]
    return admin.main(["root", *args, *transport]), calls, output


def test_surface_aico_is_still_accepted(monkeypatch):
    code, calls, _output = invoke(monkeypatch, ["status", ROOT, "--surface", "aico"], [(200, DESCRIPTOR)])
    assert code == 0 and calls == [("/fixture/gui.sock", f"/v1/roots/{ROOT}", None)]


def test_status_projects_identity_only(monkeypatch):
    code, calls, output = invoke(monkeypatch, ["status", ROOT],
                                [(200, {**DESCRIPTOR, "bounds": {"x": 1}, "role": "private"})])
    assert code == 0 and calls == [("/fixture/gui.sock", f"/v1/roots/{ROOT}", None)]
    assert output == [DESCRIPTOR]


LAUNCH = {"state": "deferred", "reason": "Nightshift has closed agent admission (Memory is tight).",
          "checkedAt": "2026-10-29T13:46:13.000Z", "nextRetryAt": "2026-10-29T13:46:43.000Z", "attempts": 1}
PENDING = {**DESCRIPTOR, "generation": None, "status": "pending"}


def test_status_shows_why_a_pending_root_has_not_started(monkeypatch):
    code, _calls, output = invoke(monkeypatch, ["status", ROOT],
                                  [(200, {**PENDING, "launch": {**LAUNCH, "extra": "dropped"}})])
    assert code == 0 and output == [{**PENDING, "launch": LAUNCH}]


@pytest.mark.parametrize("launch", [
    None, {**LAUNCH, "state": "failed"}, {**LAUNCH, "reason": "line\nbreak"}, {**LAUNCH, "reason": ""},
    {**LAUNCH, "nextRetryAt": "soon"}, {**LAUNCH, "attempts": True}, {**LAUNCH, "attempts": 0}, "deferred",
])
def test_status_drops_an_unqualified_launch(monkeypatch, launch):
    code, _calls, output = invoke(monkeypatch, ["status", ROOT], [(200, {**PENDING, "launch": launch})])
    assert code == 0 and output == [PENDING]


def test_refusing_a_pending_root_says_why_it_has_not_started(monkeypatch):
    code, _calls, output = invoke(monkeypatch, ["show", ROOT], [(200, {**PENDING, "launch": LAUNCH})])
    assert code == 1 and output[0]["reason"] == "workload_unavailable" and output[0]["launch"] == LAUNCH


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
                                  ["status", "-bad"], ["show", ROOT, "--surface", "a-term"],
                                  ["status", ROOT, "--root-url", "http://127.0.0.1:8002"]])
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
    ((409, {"error": "owner_on_web"}), False), ((503, {"error": "gui_unavailable"}), False), ((500, {"error": "owner_failure"}), None),
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


def test_aico_end_accepts_tether_accounting_fields(monkeypatch):
    ended = {"status": "ended", "contextFinalization": "completed"}
    code, _, output = invoke(monkeypatch, ["end", ROOT], [(200, DESCRIPTOR), (200, ended)])
    assert code == 0 and output[0]["status"] == "ended" and output[0]["applied"] is True


@pytest.mark.parametrize("reply,applied", [
    ((409, {"error": "stale_generation"}), False), ((409, {"error": "busy"}), False),
    ((409, {"error": "blocked", "reason": "tmux state after stop is unknown"}), None),
    ((200, {"status": "uncertain"}), None),
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


# Stored roots keep the origin they were created with. Web-app roots made through
# Tether are 8-hex session ids at aico://widget/<id> with owner "a-term"; the
# pre-Tether ones are pane UUIDs at a-term://pane/<uuid>. Both are still readable.
TETHER_WEB_ROOT = {**DESCRIPTOR, "owner": "a-term"}


def test_stored_web_app_roots_are_still_read(monkeypatch):
    code, calls, output = invoke(monkeypatch, ["status", ROOT], [(200, TETHER_WEB_ROOT)])
    assert code == 0 and calls == [("/fixture/gui.sock", f"/v1/roots/{ROOT}", None)]
    assert output[0]["owner"] == "a-term" and output[0]["surfaceLocator"] == "aico://widget/aabbcc01"
    code, _, output = invoke(monkeypatch, ["status", ROOT], [(200, PRE_TETHER_WEB_ROOT)])
    assert code == 0 and output[0]["surfaceLocator"] == PRE_TETHER_WEB_ROOT["surfaceLocator"]


def test_stored_web_app_tether_root_ends_through_the_owner_socket(monkeypatch):
    code, calls, output = invoke(monkeypatch, ["end", ROOT], [(200, TETHER_WEB_ROOT), (200, {"status": "ended"})])
    assert code == 0 and calls[1] == ("/fixture/control.sock", "/v1/sessions/aabbcc01/end", {"generation": GENERATION})
    assert output[0]["owner"] == "a-term" and output[0]["applied"] is True


@pytest.mark.parametrize("descriptor", [
    # Shapes may not mix: a Tether id with a pre-Tether web app locator, or the reverse.
    {**TETHER_WEB_ROOT, "surfaceLocator": "a-term://pane/00000000-0000-4000-8000-000000000002"},
    {**PRE_TETHER_WEB_ROOT, "surfaceLocator": "aico://widget/aabbcc01"},
    {**TETHER_WEB_ROOT, "surfaceLocator": "aico://widget/ffffffff"},
    # An aico owner never takes a pane UUID; unknown owners are refused.
    {**PRE_TETHER_WEB_ROOT, "owner": "aico"},
    {**DESCRIPTOR, "owner": "other"},
])
def test_surface_identity_refuses_mixed_shapes(monkeypatch, descriptor):
    code, _, output = invoke(monkeypatch, ["status", ROOT], [(200, descriptor)])
    assert code == 1 and output[0]["reason"] == "root_receipt_unqualified"


# root send: one follow-up into the exact running root the coordinator pinned.
FOLLOWUP = "Private follow-up: also run the focused tests."
SESSION = {"id": "aabbcc01", "generation": GENERATION, "status": "running", "tool": "pi"}
PI_BLANK_SLATE = {**DESCRIPTOR, "tool": "pi"}


def test_send_queues_one_fenced_followup_into_the_pinned_root(monkeypatch):
    code, calls, output = invoke(monkeypatch, ["send", ROOT, FOLLOWUP, "--generation", GENERATION], [
        (200, PI_BLANK_SLATE), (200, SESSION), (200, {"generation": GENERATION, "delivered": True})])
    assert code == 0
    assert calls == [
        ("/fixture/gui.sock", f"/v1/roots/{ROOT}", None),
        ("/fixture/control.sock", "/v1/sessions/aabbcc01", None),
        ("/fixture/control.sock", "/v1/sessions/aabbcc01/inject",
         {"generation": GENERATION, "text": FOLLOWUP, "mode": "paste", "submit": True}),
    ]
    assert output == [{**DESCRIPTOR, "operation": "send", "applied": True, "delivered": True,
                       "bytes": len(FOLLOWUP)}]
    assert "Private" not in json.dumps(output)


def test_send_reads_the_followup_from_stdin(monkeypatch):
    monkeypatch.setattr(admin, "admin_stdin", lambda _: FOLLOWUP)
    code, calls, _ = invoke(monkeypatch, ["send", ROOT, "--stdin", "--generation", GENERATION], [
        (200, DESCRIPTOR), (200, SESSION), (200, {"generation": GENERATION, "delivered": True})])
    assert code == 0 and calls[2][2]["text"] == FOLLOWUP


@pytest.mark.parametrize("descriptor,reason", [
    # A restarted or replaced root has a new generation: the coordinator's pin is stale.
    ({**DESCRIPTOR, "generation": "b" * 64}, "stale_generation"),
    ({**DESCRIPTOR, "generation": None, "status": "ended"}, "workload_unavailable"),
    ({**DESCRIPTOR, "status": "pending"}, "workload_unavailable"),
    # Pre-Tether web roots have no Tether session to deliver into.
    (PRE_TETHER_WEB_ROOT, "workload_unavailable"),
])
def test_send_to_a_stale_or_unavailable_root_sends_nothing(monkeypatch, descriptor, reason):
    code, calls, output = invoke(monkeypatch, ["send", ROOT, FOLLOWUP, "--generation", GENERATION],
                                 [(200, descriptor)])
    assert code == 1 and len(calls) == 1
    assert output[0]["reason"] == reason and output[0]["applied"] is False
    assert output[0]["requestId"] == ROOT and output[0]["operation"] == "send"


@pytest.mark.parametrize("reply,reason", [
    ((404, {"error": "not_found"}), "not_found"),
    ((200, {**SESSION, "generation": "b" * 64}), "stale_generation"),
    ((200, {**SESSION, "id": "aabbcc02"}), "stale_generation"),
])
def test_send_refuses_when_the_host_session_is_not_the_pinned_workload(monkeypatch, reply, reason):
    code, calls, output = invoke(monkeypatch, ["send", ROOT, FOLLOWUP, "--generation", GENERATION],
                                 [(200, DESCRIPTOR), reply])
    assert code == 1 and len(calls) == 2
    assert output[0]["reason"] == reason and output[0]["applied"] is False


def test_send_to_an_unknown_root_sends_nothing(monkeypatch):
    code, calls, output = invoke(monkeypatch, ["send", "root-other", FOLLOWUP, "--generation", GENERATION],
                                 [(404, {"error": "not_found"})])
    assert code == 1 and len(calls) == 1
    assert output[0] == {"owner": "aico", "requestId": "root-other", "operation": "send",
                         "reason": "not_found", "applied": False}


@pytest.mark.parametrize("reply,applied", [
    ((409, {"error": "stale_generation"}), False), ((409, {"error": "workload_unavailable"}), False),
    ((400, {"error": "invalid_text"}), False),
    ((500, {"error": "owner_failure"}), None), ((200, {"generation": GENERATION}), None),
    ((200, {"generation": "b" * 64, "delivered": True}), None),
])
def test_send_inject_refusal_is_not_applied_but_unqualified_reply_is_uncertain(monkeypatch, reply, applied):
    code, calls, output = invoke(monkeypatch, ["send", ROOT, FOLLOWUP, "--generation", GENERATION],
                                 [(200, DESCRIPTOR), (200, SESSION), reply])
    assert code == 1 and len(calls) == 3
    assert output[0]["applied"] is applied and "delivered" not in output[0]
    assert "Private" not in json.dumps(output)


@pytest.mark.parametrize("args", [
    ["send", ROOT, FOLLOWUP],
    ["send", ROOT, FOLLOWUP, "--generation", "a" * 63],
    ["send", ROOT, "--generation", GENERATION],
    ["send", ROOT, "   ", "--generation", GENERATION],
    ["send", ROOT, "x" * 2001, "--generation", GENERATION],
    ["send", ROOT, "bad\x1b[201~escape", "--generation", GENERATION],
    ["send", ROOT, "use password=hunter2-secret", "--generation", GENERATION],
    ["send", ROOT, FOLLOWUP, "--stdin", "--generation", GENERATION],
])
def test_send_invalid_input_never_contacts_owner(monkeypatch, args, capsys):
    with pytest.raises(SystemExit) as error:
        invoke(monkeypatch, args, [])
    assert error.value.code == 2
    assert "hunter2" not in capsys.readouterr().err
