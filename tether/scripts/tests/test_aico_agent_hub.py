"""Agent Hub chat roots through the Aico CLI: create, send and roots status, fixtures only."""

import hashlib
import json
import threading
import time

import pytest
from aico_cli_fixtures import admin, descriptor

HUB = ["create", "hub-1", "Say hello.", "--tool", "agent-hub", "--agent", "chat", "--project", "sample-app",
       "--project-root", "/fixture/project", "--work-role", "implementation"]
GENERATION = "a" * 64


@pytest.fixture(autouse=True)
def outside_aico(monkeypatch):
    monkeypatch.delenv("AICO_WIDGET_ID", raising=False)


def hub_descriptor(payload):
    """Tether's receipt: the create digest, now covering the agent slug."""
    fields = [payload[k] for k in ("tool", "projectId", "projectRoot", "initialPrompt", "role",
                                   "leadRootReference", "facetCapsuleRef")]
    if payload.get("model"):
        fields.append({"model": payload["model"], "reasoningEffort": None})
    fields.append({"workRole": payload["workRole"], "workRoleDisplayName": payload.get("workRoleDisplayName")})
    fields.append({"agentSlug": payload["agentSlug"]})
    return {**descriptor({**payload, "resumeSessionId": None}),
            "digest": hashlib.sha256(json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()}


HUB_SESSION = {"id": "12345678", "backend": "agent-hub", "agentHub": {
    "turnState": "running", "turnPhase": "waiting_for_model", "queued": 0, "reachable": True,
    "created": True, "promptSent": True, "error": None}}


def run_create(monkeypatch, args, agent_hub=None):
    calls, output = [], []

    def receipt(_, path, route, payload=None, **kwargs):
        if route.startswith("/v1/sessions/"):
            return 200, {**HUB_SESSION, "agentHub": {**HUB_SESSION["agentHub"], **(agent_hub or {})}}
        calls.append(payload)
        return 200, hub_descriptor(payload)

    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    return admin.main(args), calls, output


def test_create_sends_the_agent_slug_and_binds_it_into_the_digest(monkeypatch):
    code, calls, output = run_create(monkeypatch, [*HUB, "--root-socket", "/fixture/gui.sock"])
    assert code == 0
    assert calls[0]["tool"] == "agent-hub" and calls[0]["agentSlug"] == "chat"
    assert output[0]["status"] == "running" and output[0]["requestId"] == "hub-1"


def test_create_reports_the_turn_it_started(monkeypatch):
    code, _, output = run_create(monkeypatch, [*HUB, "--root-socket", "/fixture/gui.sock"],
                                 {"turnState": "running", "queued": 0})
    assert code == 0 and output[0]["turnState"] == "running" and output[0]["queued"] == 0


def test_create_fails_with_the_reason_when_the_first_turn_did_not_start(monkeypatch):
    refusal = "working_dir '/x' is outside the known project roots and scratch"
    code, _, output = run_create(
        monkeypatch, [*HUB, "--root-socket", "/fixture/gui.sock"],
        {"promptSent": False, "turnState": "idle",
         "error": {"code": "agent_hub_refused", "message": refusal}})
    assert code == 1
    assert output[0]["status"] == "uncertain" and output[0]["reason"] == "turn_not_started"
    assert output[0]["detail"] == refusal and output[0]["promptSent"] is False


def test_create_fails_when_agent_hub_could_not_be_reached_for_the_first_turn(monkeypatch):
    code, _, output = run_create(
        monkeypatch, [*HUB, "--root-socket", "/fixture/gui.sock"],
        {"created": False, "promptSent": False, "turnState": None, "reachable": None,
         "error": {"code": "agent_hub_unavailable", "message": "Agent Hub is not reachable"}})
    assert code == 1 and output[0]["reason"] == "turn_not_started"


def test_blank_slate_chat_gets_an_empty_workspace_in_a_project_agent_hub_knows(monkeypatch):
    args = [a for a in HUB if a not in ("--project", "sample-app", "--project-root", "/fixture/project")]
    code, calls, _ = run_create(monkeypatch, [*args, "--blank-slate", "--root-socket", "/fixture/gui.sock"])
    assert code == 0
    assert calls[0]["projectRoot"] == "/tmp/aico-blank-slate/hub-1" and calls[0]["projectId"] == "agent-hub"
    assert calls[0]["tool"] == "agent-hub"


def test_create_passes_a_model_override(monkeypatch):
    code, calls, _ = run_create(monkeypatch, [*HUB, "--model", "gemini-3.5-flash-lite", "--root-socket", "/fixture/gui.sock"])
    assert code == 0 and calls[0]["model"] == "gemini-3.5-flash-lite"


def test_a_different_agent_changes_the_digest(monkeypatch):
    _, _, first = run_create(monkeypatch, [*HUB, "--root-socket", "/fixture/gui.sock"])
    swapped = [*HUB]
    swapped[swapped.index("chat")] = "explorer"
    _, _, second = run_create(monkeypatch, [*swapped, "--root-socket", "/fixture/gui.sock"])
    assert first[0]["digest"] != second[0]["digest"]


def test_other_tools_never_send_an_agent_slug(monkeypatch):
    calls = []
    monkeypatch.setattr(admin.Collector, "receipt", lambda _, path, route, payload, **kw: (
        calls.append(payload) or (200, descriptor({**payload, "resumeSessionId": None}))))
    monkeypatch.setattr(admin, "emit_json", lambda *_: None)
    assert admin.main(["create", "cx-1", "Go.", "--tool", "codex", "--project", "sample-app",
                       "--project-root", "/fixture/project", "--work-role", "implementation"]) == 0
    assert "agentSlug" not in calls[0]


@pytest.mark.parametrize("args", [
    [a for a in HUB if a not in ("--agent", "chat")],              # no agent
    [*HUB, "--reasoning-effort", "high"], [*HUB, "--daybreak", "on"],
    [*HUB, "--resume-session", "00000000-0000-4000-8000-000000000001"],
    ["create", "cx-2", "Go.", "--tool", "codex", "--agent", "chat", "--project", "sample-app",
     "--project-root", "/fixture/project", "--work-role", "implementation"],
    ["create", "hub-2", "Go.", "--tool", "agent-hub", "--agent", "bad slug", "--project", "sample-app",
     "--project-root", "/fixture/project", "--work-role", "implementation"],
])
def test_invalid_agent_options_never_contact_tether(monkeypatch, args):
    monkeypatch.setattr(admin.Collector, "receipt", lambda *_a, **_k: pytest.fail("contacted owner"))
    with pytest.raises(SystemExit) as result:
        admin.main(args)
    assert result.value.code == 2


@pytest.mark.parametrize(("status", "reason"), [
    (422, "unknown_agent"), (422, "unknown_model"), (503, "agent_hub_unavailable")])
def test_agent_hub_refusals_name_their_cause(monkeypatch, status, reason):
    output = []
    monkeypatch.setattr(admin.Collector, "receipt", lambda *_a, **_k: (status, {"error": reason}))
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    assert admin.main([*HUB, "--root-socket", "/fixture/gui.sock"]) == 1
    assert output[0]["reason"] == reason


# send: the follow-up posts a turn; queued says one was running.
ROOT = {"owner": "aico", "requestId": "hub-1", "hostIdentity": "aabbcc01", "logicalSessionId": "aico-root-hub",
        "surfaceLocator": "aico://widget/aabbcc01", "generation": GENERATION, "status": "running",
        "tool": "agent-hub"}
SESSION = {"id": "aabbcc01", "ownershipId": "aico-widget-aabbcc01", "generation": GENERATION, "status": "running",
           "tool": "agent-hub", "backend": "agent-hub", "state": "working"}


@pytest.mark.parametrize("queued", [True, False])
def test_send_reports_whether_the_follow_up_was_queued(monkeypatch, queued):
    responses = [(200, ROOT), (200, SESSION), (200, {"generation": GENERATION, "delivered": True, "queued": queued})]
    calls, output = [], []

    def receipt(_, endpoint, route, payload=None, **_o):
        calls.append(route)
        return responses[len(calls) - 1]

    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    assert admin.main(["root", "send", "hub-1", "More.", "--generation", GENERATION,
                       "--root-socket", "/fixture/gui.sock", "--owner-socket", "/fixture/control.sock"]) == 0
    assert calls[-1] == "/v1/sessions/aabbcc01/inject"
    assert output[0]["delivered"] is True
    assert output[0].get("queued", False) is queued


# roots status: no pane; the turn state stands in for the screen.
def hub_collector():
    return admin.Collector("/fixture/root", "/fixture/owner", "/fixture/tmux", time.monotonic() + 2, threading.Event())


def serve(monkeypatch, state="working", **override):
    session = {**SESSION, "state": state, **override}

    def receipt(self, path, route, **_):
        if route == "/v1/roots?ended=0":
            return 200, {"owner": "aico", "roots": [ROOT]}
        return (200, ROOT) if "/roots/" in route else (200, session)

    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    return session


@pytest.mark.parametrize(("state", "terminal"), [("working", "busy"), ("idle", "turn_finished"),
                                                  ("unknown", "ambiguous")])
def test_roots_reports_the_turn_state_of_an_agent_hub_root(monkeypatch, state, terminal):
    serve(monkeypatch, state)
    resolved, unavailable = hub_collector().discover(None)
    assert unavailable == [] and len(resolved) == 1
    pin, child = resolved[0]
    assert isinstance(pin, admin.HubPin) and pin.widgetId == "aabbcc01"
    sample = child.sample(pin)
    assert sample["observation"] == "available" and sample["identity"] == "pinned"
    assert sample["terminal"] == terminal and sample["backend"] == "agent-hub"
    assert "Say hello" not in json.dumps(sample)


def test_roots_snapshot_emits_the_agent_hub_record(monkeypatch):
    serve(monkeypatch, "idle")
    output = []
    monkeypatch.setattr(admin, "emit_json", lambda _, row: output.append(row))
    assert admin.roots_main(["--root-socket", "/fixture/root", "--owner-socket", "/fixture/owner"]) == 0
    [record] = output[0]["roots"]
    assert record["requestId"] == "hub-1" and record["terminal"] == "turn_finished"


def test_a_changed_generation_is_a_changed_identity(monkeypatch):
    session = serve(monkeypatch, "idle")
    resolved, _ = hub_collector().discover(None)
    pin, child = resolved[0]
    session["generation"] = "b" * 64
    assert child.sample(pin) == {"observation": "unavailable", "identity": "changed"}


def test_a_session_that_is_not_an_agent_hub_one_is_not_pinned(monkeypatch):
    serve(monkeypatch, "idle", backend="tmux")
    resolved, unavailable = hub_collector().discover(None)
    assert resolved == [] and unavailable[0]["reason"] == "session_unavailable"


# send errors and status: nothing is "delivered" unless Tether started or queued the turn.
def serve_send(monkeypatch, inject):
    calls = []

    def receipt(_, endpoint, route, payload=None, **_o):
        calls.append(route)
        if route.endswith("/inject"):
            return inject
        return (200, ROOT) if "/roots/" in route else (200, SESSION)

    output = []
    monkeypatch.setattr(admin.Collector, "receipt", receipt)
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    return calls, output


def test_send_fails_with_agent_hubs_reason_when_the_turn_cannot_run(monkeypatch):
    refusal = "ProviderError: route unavailable"
    _, output = serve_send(monkeypatch, (409, {"error": "workload_unavailable", "reason": refusal}))
    assert admin.main(["root", "send", "hub-1", "More.", "--generation", GENERATION,
                       "--root-socket", "/fixture/gui.sock", "--owner-socket", "/fixture/control.sock"]) == 1
    assert output[0]["reason"] == "workload_unavailable" and output[0]["detail"] == refusal
    assert output[0]["applied"] is False and "delivered" not in output[0]


def test_send_fails_when_agent_hub_is_unreachable(monkeypatch):
    _, output = serve_send(monkeypatch, (503, {"error": "agent_hub_unavailable"}))
    assert admin.main(["root", "send", "hub-1", "More.", "--generation", GENERATION,
                       "--root-socket", "/fixture/gui.sock", "--owner-socket", "/fixture/control.sock"]) == 1
    assert output[0]["applied"] is None and "delivered" not in output[0]


@pytest.mark.parametrize(("hub", "expected"), [
    ({"turnState": "running", "queued": 2, "reachable": True, "promptSent": True}, ("running", 2)),
    ({"turnState": "idle", "queued": 0, "reachable": True, "promptSent": True}, ("idle", 0)),
    ({"turnState": "running", "queued": 0, "reachable": False, "promptSent": True}, ("unknown", 0)),
    ({"turnState": None, "queued": 0, "reachable": None, "promptSent": True}, ("unknown", 0)),
])
def test_status_reports_the_turn_state_of_a_chat_root(monkeypatch, hub, expected):
    output = []
    monkeypatch.setattr(admin.Collector, "receipt", lambda _, endpoint, route, payload=None, **_o: (
        (200, ROOT) if "/roots/" in route else (200, {**SESSION, "agentHub": hub})))
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    assert admin.main(["root", "status", "hub-1", "--root-socket", "/fixture/gui.sock"]) == 0
    assert (output[0]["turnState"], output[0]["queued"]) == expected and output[0]["backend"] == "agent-hub"


def test_status_shows_why_a_turn_did_not_start(monkeypatch):
    output = []
    hub = {"turnState": "idle", "queued": 0, "reachable": True, "promptSent": False,
           "error": {"code": "agent_hub_refused", "message": "no route"}}
    monkeypatch.setattr(admin.Collector, "receipt", lambda _, endpoint, route, payload=None, **_o: (
        (200, ROOT) if "/roots/" in route else (200, {**SESSION, "agentHub": hub})))
    monkeypatch.setattr(admin, "emit_json", lambda _, record: output.append(record))
    assert admin.main(["root", "status", "hub-1", "--root-socket", "/fixture/gui.sock"]) == 0
    assert output[0]["error"] == {"code": "agent_hub_refused", "message": "no route"}
    assert output[0]["promptSent"] is False
