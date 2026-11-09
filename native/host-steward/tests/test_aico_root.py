"""Exact retained-root owner controls, using isolated receipts only."""

import json
import subprocess
import threading
import time

import pytest
from aico_cli_fixtures import REAL_STARTED_AGENT_ID, admin

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
    monkeypatch.setattr(admin, "caller_widget_id", lambda: None)
    transport = ["--root-socket", "/fixture/gui.sock"]
    if args[0] in ("end", "send", "rewind"):
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
    code, _calls, output = invoke(monkeypatch, ["title", ROOT, "Focus"], [(200, {**PENDING, "launch": LAUNCH})])
    assert code == 1 and output[0]["reason"] == "workload_unavailable" and output[0]["launch"] == LAUNCH


@pytest.mark.parametrize("args,payload", [
    (["title", ROOT, "﻿ Private label "], {"generation": GENERATION, "label": "Private label"}),
])
def test_mutation_pins_generation_and_qualifies_one_receipt(monkeypatch, args, payload):
    code, calls, output = invoke(monkeypatch, args, [(200, DESCRIPTOR), (200, {**DESCRIPTOR, "label": "Private label"})])
    assert code == 0
    assert calls[1] == ("/fixture/gui.sock", f"/v1/roots/{ROOT}/{args[0]}", payload)
    assert output == [{**DESCRIPTOR, "operation": args[0], "applied": True}]
    assert "Private" not in json.dumps(output)


@pytest.mark.parametrize("args", [["title", ROOT, "line\nbreak"], ["title", ROOT, "\x85"],
                                  ["status", "-bad"], ["title", ROOT, "Focus", "--surface", "a-term"],
                                  ["status", ROOT, "--root-url", "http://127.0.0.1:8002"]])
def test_invalid_input_never_contacts_owner(monkeypatch, args, capsys):
    with pytest.raises(SystemExit) as error:
        invoke(monkeypatch, args, [])
    assert error.value.code == 2
    assert "\x85" not in capsys.readouterr().err


@pytest.mark.parametrize("state", ["pending", "uncertain"])
def test_non_running_root_is_not_mutated(monkeypatch, state):
    code, calls, output = invoke(monkeypatch, ["title", ROOT, "Focus"],
                                [(200, {**DESCRIPTOR, "status": state})])
    assert code == 1 and len(calls) == 1
    assert output[0]["reason"] == "workload_unavailable" and output[0]["applied"] is False


@pytest.mark.parametrize("reply,applied", [
    ((409, {"error": "stale_generation"}), False), ((410, {"error": "ended"}), False),
    ((503, {"error": "unavailable"}), False), ((500, {"error": "owner_failure"}), None),
    ((200, {**DESCRIPTOR, "generation": "b" * 64}), None), ((200, {**DESCRIPTOR, "status": "uncertain"}), None),
])
def test_refusal_is_not_applied_but_unqualified_reply_is_uncertain(monkeypatch, reply, applied):
    code, calls, output = invoke(monkeypatch, ["title", ROOT, "Focus"], [(200, DESCRIPTOR), reply])
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


@pytest.mark.parametrize("caller, version, host, ended_by, header", [
    ("0a1b2c3d", 21, None, "0a1b2c3d", None),  # a coordinator ending its lane: no "ended" line back to it
    ("0a1b2c3d", 20, None, None, None),        # an older Tether refuses the field
    ("0a1b2c3d", 21, "neri-vm", None, None),   # the hub forwards the body to that host's Tether verbatim
    ("0a1b2c3d", 23, "neri-vm", None, "0a1b2c3d"),  # this hub takes it in a header, never in that body
    ("aabbcc01", 21, None, None, None),        # the lane ending itself
    (None, 23, "neri-vm", None, None),         # not run from a session (the owner's shell)
])
def test_end_names_the_ending_session_only_to_a_tether_that_takes_it(monkeypatch, caller, version, host, ended_by,
                                                                     header):
    named = {"host": host} if host else {}
    replies = {f"/v1/roots/{ROOT}": (200, {**DESCRIPTOR, **named}), "/v1/version": (200, {"apiVersion": version}),
               "/v1/sessions/aabbcc01/end": (200, {"status": "ended"})}
    monkeypatch.setattr(admin, "caller_widget_id", lambda: caller)
    calls = []

    def receipt(_, endpoint, route, payload=None, **options):
        calls.append((route, payload, options.get("headers")))
        return replies[route]

    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    monkeypatch.setattr(admin, "emit_json", lambda *_: None)
    code = admin.main(["root", "end", ROOT, "--root-socket", "/fixture/gui.sock",
                       "--owner-socket", "/fixture/control.sock"])
    assert code == 0
    sent, headers = next((payload, headers) for route, payload, headers in calls if route.endswith("/end"))
    assert sent == {"generation": GENERATION, **({"endedBy": ended_by} if ended_by else {})}
    assert headers == ({"Tether-Ended-By": header} if header else None)


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


@pytest.mark.parametrize("version, host, sent_from", [(13, None, "0a1b2c3d"), (12, None, None),
                                                     (13, "neri-vm", None)])
def test_send_names_the_sending_session_only_to_a_tether_that_takes_it(monkeypatch, version, host, sent_from):
    """Never to a session on another host: the hub forwards the body to that host's Tether."""
    replies = {f"/v1/roots/{ROOT}": (200, PI_BLANK_SLATE), "/v1/sessions/aabbcc01": (200, {**SESSION, "host": host}),
               "/v1/version": (200, {"apiVersion": version}),
               "/v1/sessions/aabbcc01/inject": (200, {"generation": GENERATION, "delivered": True})}
    monkeypatch.setattr(admin, "caller_widget_id", lambda: "0a1b2c3d")
    calls = []

    def receipt(_, endpoint, route, payload=None, **_options):
        calls.append((route, payload))
        return replies[route]

    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    monkeypatch.setattr(admin, "emit_json", lambda *_: None)
    code = admin.main(["root", "send", ROOT, FOLLOWUP, "--generation", GENERATION,
                       "--root-socket", "/fixture/gui.sock", "--owner-socket", "/fixture/control.sock"])
    assert code == 0
    sent = next(payload for route, payload in calls if route.endswith("/inject"))
    assert sent.get("from") == sent_from


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


def test_status_says_starting_while_idle_with_nothing_said_or_any_model(monkeypatch):
    monkeypatch.setattr(admin, "session_view", lambda *_: {"id": "aabbcc01", "state": "idle"})
    monkeypatch.setattr(admin, "agent_id_of", lambda *_: None)
    monkeypatch.setattr(admin, "session_report", lambda *_: {"text": None, "model": None, "id": "aabbcc01"})
    assert admin.lane_view(None, "sock", "aabbcc01")["state"] == "starting"
    monkeypatch.setattr(admin, "session_report", lambda *_: {"text": "391", "model": "m"})
    assert admin.lane_view(None, "sock", "aabbcc01")["state"] == "idle"
    monkeypatch.setattr(admin, "session_report", lambda *_: {})  # no report is not a start
    assert admin.lane_view(None, "sock", "aabbcc01")["state"] == "idle"


def test_send_without_a_generation_uses_the_root_s_current_one(monkeypatch):
    code, calls, _ = invoke(monkeypatch, ["send", ROOT, FOLLOWUP], [
        (200, PI_BLANK_SLATE), (200, SESSION), (200, {"generation": GENERATION, "delivered": True})])
    assert code == 0 and calls[2][2]["generation"] == GENERATION


@pytest.mark.parametrize("args", [
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


@pytest.mark.parametrize("args", [["show", ROOT], ["position", ROOT, "0", "0", "900", "560"], ["position"]])
def test_root_show_and_position_are_retired_without_contacting_owner(monkeypatch, capsys, args):
    monkeypatch.setattr(admin.Collector, "receipt", lambda *_: pytest.fail("owner contacted"))
    assert admin.main(["root", *args, "--root-socket", "/fixture/gui.sock"]) == 2
    assert capsys.readouterr().err.strip() == admin.WINDOWS_RETIRED


# root rewind: back to before the prompt a model switch names, through Tether's rewind route.
CLAUDE_SESSION = {**SESSION, "tool": "claude-code"}


def test_rewind_pins_the_current_generation_and_asks_tether_once(monkeypatch):
    code, calls, output = invoke(monkeypatch, ["rewind", ROOT], [
        (200, DESCRIPTOR), (200, CLAUDE_SESSION), (200, {"generation": GENERATION, "rewound": True, "up": 2, "cleared": True})])
    assert code == 0
    assert calls == [
        ("/fixture/gui.sock", f"/v1/roots/{ROOT}", None),
        ("/fixture/control.sock", "/v1/sessions/aabbcc01", None),
        ("/fixture/control.sock", "/v1/sessions/aabbcc01/rewind", {"generation": GENERATION}),
    ]
    assert output == [{**DESCRIPTOR, "operation": "rewind", "applied": True, "rewound": True, "up": 2}]


@pytest.mark.parametrize("reply,reason,detail", [
    ((409, {"error": "rewind_refused", "step": "pick", "reason": "prompt not in the list"}), "rewind_refused",
     "pick: prompt not in the list"),
    ((409, {"error": "rewind_unsupported", "tool": "codex"}), "rewind_unsupported", None),
    ((409, {"error": "no_rewind_target"}), "no_rewind_target", None),
])
def test_rewind_refusals_say_why_and_applied_nothing(monkeypatch, reply, reason, detail):
    code, _calls, output = invoke(monkeypatch, ["rewind", ROOT], [(200, DESCRIPTOR), (200, CLAUDE_SESSION), reply])
    assert code == 1
    assert output[0]["reason"] == reason and output[0]["applied"] is False
    assert output[0].get("detail") == detail


def test_rewind_with_a_stale_generation_sends_nothing(monkeypatch):
    code, calls, output = invoke(monkeypatch, ["rewind", ROOT, "--generation", "b" * 64], [(200, DESCRIPTOR)])
    assert code == 1 and len(calls) == 1 and output[0]["reason"] == "stale_generation"


REPORT_SESSION = {"id": "aabbcc01", "displayTitle": "Aico — burn lane", "state": "idle", "stateDetail": None,
                  "waitingOn": None, "doing": None, "stateAt": 1_000, "stateAgentAt": 2_000,
                  "resumeId": "22222222-aaaa-4bbb-8ccc-000000000002"}
REPORT = {"id": "aabbcc01", "text": "Done. 3 commits. " + "x" * 2000, "at": 2_000, "contextTokens": 210_000,
          "contextWindow": 1_000_000, "contextPercent": 21, "model": "claude-opus-5-5"}
COORD = {"name": "_coord", "doc": {"identities": {
    "cc:000002": {"session": "22222222-aaaa-4bbb-8ccc-000000000002", "last": "2026-11-08T10:00:00Z"},
    "cc:999999": {"session": "99999999-aaaa-4bbb-8ccc-000000000009", "last": "2026-11-08T11:00:00Z"}}}}


def lane_receipts(monkeypatch, session=REPORT_SESSION, report=REPORT, tool="claude-code"):
    def receipt(_self, _path, route, *_a, **_k):
        if route == f"/v1/roots/{ROOT}":
            return 200, {**DESCRIPTOR, "tool": tool}
        if route == "/v1/sessions/aabbcc01":
            return (200, session) if session else (404, {"error": "not_found"})
        if route == "/v1/sessions/aabbcc01/report":
            return 200, report
        if route == admin.COORD_DOC_ROUTE:
            return 200, COORD
        return 404, {}
    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    monkeypatch.setattr(admin, "agent_view", lambda *_a: {"agent": "running"})
    monkeypatch.setattr(admin.time, "time", lambda: 5.0)


def test_status_says_how_the_lane_is_and_what_it_said_bounded(monkeypatch):
    lane_receipts(monkeypatch)
    output = []
    monkeypatch.setattr(admin, "emit_json", lambda _, value: output.append(value))
    assert admin.main(["root", "status", ROOT]) == 0
    view = output[0]
    assert view["state"] == "idle" and view["context"] == "21%" and view["agentId"] == "cc:000002"
    assert view["lastMessage"].startswith("Done.") and len(view["lastMessage"]) == admin.STATUS_MESSAGE_CHARS
    assert view["lastMessageCut"] is True and view["lastActivityAt"] == 2_000
    assert view["model"] == "claude-opus-5-5"


def test_agy_root_status_includes_agent_state_and_report(monkeypatch):
    lane_receipts(monkeypatch, tool="agy")
    output = []
    monkeypatch.setattr(admin, "emit_json", lambda _, value: output.append(value))
    assert admin.main(["root", "status", ROOT]) == 0
    assert output[0]["state"] == "idle"
    assert output[0]["lastMessage"].startswith("Done.")
    assert output[0]["lastActivityAt"] == 2_000


def test_age_label_rounds_as_the_shared_time_helper_does():
    minute = 60_000
    now = 10_000 * minute
    assert [admin.age_label(now - ago, now) for ago in (40_000, 90_500, 59 * minute + 29_000, 90 * minute, 2_879 * minute, 2_880 * minute)] == [
        "40s", "2m", "59m", "2h", "48h", "2d",
    ]
    assert admin.age_label(None, now) == "-"


def test_report_prints_the_whole_last_message_in_plain_text(monkeypatch, capsys):
    lane_receipts(monkeypatch)
    assert admin.main(["root", "report", ROOT]) == 0
    head, blank, text = capsys.readouterr().out.rstrip("\n").split("\n", 2)
    assert head == "Aico — burn lane · idle · context 21% · last activity 3s ago"
    assert blank == "" and text == REPORT["text"]


def test_report_with_nothing_to_show_says_so(monkeypatch, capsys):
    lane_receipts(monkeypatch, session=None, report={"text": None})
    assert admin.main(["root", "report", ROOT]) == 0
    out = capsys.readouterr().out
    assert out.startswith(f"{ROOT} · ") and "no message from its agent" in out


def test_create_reports_the_started_agent_id_and_null_when_it_has_not_started(monkeypatch):
    lane_receipts(monkeypatch)
    monkeypatch.setenv("TETHER_SOCKET", "/fixture/tether.sock")
    monkeypatch.setattr(admin.time, "sleep", lambda _: None)
    created = {"status": "running", "hostIdentity": "aabbcc01"}
    instance = admin.Collector("/fixture/tether.sock", "/fixture/tether.sock", "", 1e12, threading.Event())
    assert REAL_STARTED_AGENT_ID(instance, created) == "cc:000002"
    assert REAL_STARTED_AGENT_ID(instance, {**created, "host": "agent-work"}) is None
    assert REAL_STARTED_AGENT_ID(instance, {**created, "status": "pending"}) is None
    monkeypatch.setattr(admin, "CREATE_AGENT_SECONDS", 0.0)
    lane_receipts(monkeypatch, session={**REPORT_SESSION, "resumeId": None})
    assert REAL_STARTED_AGENT_ID(instance, created) is None


def test_create_stops_looking_for_the_agent_in_time_to_print_its_receipt(monkeypatch):
    lane_receipts(monkeypatch, session={**REPORT_SESSION, "resumeId": None})
    monkeypatch.setenv("TETHER_SOCKET", "/fixture/tether.sock")
    reads = []
    monkeypatch.setattr(admin, "session_view", lambda *_a: reads.append(1) or {})
    monkeypatch.setattr(admin.time, "sleep", lambda _: pytest.fail("no time left to poll"))
    deadline = admin.time.monotonic() + admin.CREATE_RECEIPT_RESERVE - .01
    instance = admin.Collector("/fixture/tether.sock", "/fixture/tether.sock", "", deadline, threading.Event())
    assert REAL_STARTED_AGENT_ID(instance, {"status": "running", "hostIdentity": "aabbcc01"}) is None
    assert reads == [1]


def test_an_agent_is_found_by_its_window_before_tether_knows_its_resume_id(monkeypatch):
    process = subprocess.Popen(["sleep", "30"], env={"AICO_WIDGET_ID": "aabbcc01"})
    try:
        deadline = time.monotonic() + 5
        while admin.anchor_window(f"{process.pid}:1") != "aabbcc01" and time.monotonic() < deadline:
            time.sleep(.01)
        rows = {"cc:000002": {"main": True, "anchor": f"{process.pid}:1", "last": "2026-11-08T10:00:00Z"},
                "cc:child1": {"main": False, "anchor": f"{process.pid}:1", "last": "2026-11-08T11:00:00Z"},
                "cc:999999": {"main": True, "anchor": "not-a-process:1", "last": "2026-11-08T12:00:00Z"}}
        lane_receipts(monkeypatch, session={**REPORT_SESSION, "resumeId": None})
        instance = admin.Collector("/fixture/tether.sock", "/fixture/tether.sock", "", 1e12, threading.Event())
        receipt = admin.Collector.receipt

        def identities(self, path, route, *args, **kwargs):
            if route == admin.COORD_DOC_ROUTE:
                return 200, {"doc": {"identities": rows}}
            return receipt(self, path, route, *args, **kwargs)
        monkeypatch.setattr(admin.Collector, "receipt", identities)
        session = {**REPORT_SESSION, "resumeId": None}
        assert admin.agent_id_of(instance, "/fixture/tether.sock", session) == "cc:000002"
        assert admin.agent_id_of(instance, "/fixture/tether.sock", {**session, "id": "ffffffff"}) is None
    finally:
        process.kill()
        process.wait()
