"""Grant requests, FIDO assertions, expiration, use logging and safe test access."""

import hashlib
import json
import os
import pwd
import struct

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

from host_steward import grants, webauthn


@pytest.fixture
def resolved():
    return []


@pytest.fixture
def service(tmp_path, resolved):
    cfg = grants.config()
    cfg.update(state_dir=str(tmp_path), credentials_file=str(tmp_path / "credential.json"),
               site_file=str(tmp_path / "site.json"), owner=pwd.getpwuid(os.getuid()).pw_name)
    (tmp_path / "site.json").write_text(json.dumps({"approve_host": "approve.example.test"}))
    key = ec.generate_private_key(ec.SECP256R1())
    point = key.public_key().public_numbers()
    cred = {"credential_id": "fixture", "public_key": {
        "x": webauthn.b64url(point.x.to_bytes(32, "big")), "y": webauthn.b64url(point.y.to_bytes(32, "big"))}, "sign_count": 0}
    (tmp_path / "credential.json").write_text(json.dumps({"credentials": [cred]}))
    clock = [1800000000.0]
    notices, rows = [], []
    svc = grants.Grants(cfg, now=lambda: clock[0], notify=lambda _, r: notices.append(r.copy()) or True,
                        report=lambda batch: rows.extend(batch),
                        resolve=lambda _, r: resolved.append((r["id"], r["state"])) or True)
    return svc, key, clock, notices, rows


def request(svc, kind="owner-chrome"):
    return svc.handle({"op": "request", "kind": kind, "reason": "Test the grants path", "minutes": 1}, svc.owner)["id"]


def signed(svc, key, rid, decision="approve", count=1):
    ask = svc.handle({"op": "ask", "id": rid}, svc.owner)
    cd = json.dumps({"type": "webauthn.get", "challenge": webauthn.b64url(bytes.fromhex(ask["challenges"][decision])),
                     "origin": ask["origin"], "crossOrigin": False}).encode()
    ad = hashlib.sha256(ask["rp"].encode()).digest() + b"\x05" + struct.pack(">I", count)
    sig = key.sign(ad + hashlib.sha256(cd).digest(), ec.ECDSA(hashes.SHA256()))
    return {"op": "answer", "id": rid, "decision": decision, "assertion": {
        "credentialId": "fixture", "clientDataJSON": webauthn.b64url(cd),
        "authenticatorData": webauthn.b64url(ad), "signature": webauthn.b64url(sig)}}


def test_request_tap_signed_approval_use_log_and_revoke(service):
    svc, key, _, notices, rows = service
    rid = request(svc)
    assert notices[0]["id"] == rid
    answer = svc.handle(signed(svc, key, rid), svc.owner)
    assert answer["code"] == 200  # native/tray/window.rs accepts only this protocol code
    out = svc.handle({"op": "use", "id": rid}, svc.owner)
    assert out["open"] and out["token"] is None
    assert any(r["kind"] == "grant" and r["id"].endswith(rid) for r in rows)
    assert svc.public()["uses"][0]["event"] == "use"
    svc.handle({"op": "revoke", "id": rid}, svc.owner)
    with pytest.raises(ValueError, match="no open grant"):
        svc.handle({"op": "use", "id": rid}, svc.owner)


def test_assertions_bind_request_decision_and_replay_counter(service):
    svc, key, _, _, _ = service
    a, b = request(svc), request(svc)
    answer = signed(svc, key, a)
    with pytest.raises(ValueError):
        svc.handle({**answer, "id": b}, svc.owner)
    with pytest.raises(ValueError):
        svc.handle({**answer, "decision": "deny"}, svc.owner)
    svc.handle(answer, svc.owner)
    with pytest.raises(ValueError):
        svc.handle(answer, svc.owner)
    with pytest.raises(ValueError, match="signCount"):
        svc.handle(signed(svc, key, b, count=1), svc.owner)


def test_expiry_survives_restart_and_public_has_no_challenge(service):
    svc, key, clock, _, _ = service
    rid = request(svc)
    svc.handle(signed(svc, key, rid), svc.owner)
    assert "challenge" not in json.dumps(svc.public())
    clock[0] += 61
    restarted = grants.Grants(svc.cfg, now=lambda: clock[0], notify=svc.notify, report=svc.report)
    assert restarted.handle({"op": "list"}, svc.owner)["grants"] == []


def test_test_approval_cannot_open_real_access_or_be_used_by_nonroot(service):
    svc, _, _, _, _ = service
    real = request(svc, "github-admin")
    with pytest.raises(ValueError):
        svc.handle({"op": "test-approve", "id": real}, 0)
    test = request(svc, "test")
    with pytest.raises(ValueError):
        svc.handle({"op": "test-approve", "id": test}, 12345)
    svc.handle({"op": "test-approve", "id": test}, 0)
    assert svc.handle({"op": "use", "id": test}, svc.owner)["token"] is None


def test_bad_state_fails_closed_and_failed_notice_is_retried(service):
    svc, _, _, _, _ = service
    svc.notify = lambda *_: False
    rid = request(svc)
    assert svc.state["requests"][-1]["pushed"] is False
    svc.notify = lambda *_: True
    svc.refresh()
    assert svc.state["requests"][-1]["pushed"] is True
    (svc.folder / "state.json").write_text("broken")
    with pytest.raises(ValueError):
        grants.Grants(svc.cfg)
    assert rid


def test_request_limits_unknown_kinds_and_check_runs_do_not_elevate(service):
    svc = service[0]
    for fields in ({"kind": "arbitrary"}, {"minutes": -1}, {"minutes": True}, {"kind": "github-admin", "reason": "check-runs 403"}):
        with pytest.raises(ValueError):
            svc.handle({"op": "request", "kind": "test", "reason": "test", **fields}, svc.owner)


def test_finished_requests_leave_status_after_a_day(service):
    svc, _key, clock, _notices, rows = service
    removed = []
    svc.remove = removed.append
    rid = request(svc)
    clock[0] += svc.cfg["request_seconds"] + 1
    svc.refresh()
    assert [r["state"] for r in svc.state["requests"]] == ["expired"]
    clock[0] += grants.FINISHED_KEEP_S - 10
    svc.refresh()
    assert svc.state["requests"] and not removed
    clock[0] += 20
    rows.clear()
    svc.refresh()
    assert svc.state["requests"] == [] and not rows
    assert removed and removed[0].endswith(f"/grant-{rid}")


def test_a_request_that_is_no_longer_pending_ends_its_notice_once(service, resolved):
    """The tray counts an unanswered request notice as unread until something ends it."""
    svc, key, clock, notices, _rows = service
    answered, lapsed = request(svc), request(svc)
    svc.refresh()
    assert [n["id"] for n in notices] == [answered, lapsed] and resolved == []
    svc.handle(signed(svc, key, answered, "deny"), svc.owner)
    svc.refresh()
    assert resolved == [(answered, "denied")]
    clock[0] += 3600  # the other lapses unanswered
    svc.refresh()
    svc.refresh()
    assert sorted(resolved) == sorted([(answered, "denied"), (lapsed, "expired")])
