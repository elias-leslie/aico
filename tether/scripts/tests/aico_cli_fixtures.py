"""Shared by the st aico CLI tests: the one loaded aico-root-watch.py module and the
exact-create request fixtures. Not a test module, so reshaping a test file never
breaks another at import time. Every test file shares this one module: change its
attributes only through monkeypatch so nothing leaks between files."""

import hashlib
import importlib.util
import json
import sys
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "aico_root_watch", Path(__file__).resolve().parents[1] / "aico-root-watch.py"
)
assert SPEC is not None and SPEC.loader is not None
admin = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = admin
SPEC.loader.exec_module(admin)

THREAD = "00000000-0000-4000-8000-000000000001"
BASE = ["create", "recovery-1", "Reconcile after crash.", "--tool", "codex", "--project", "sample-app",
        "--project-root", "/fixture/project", "--work-role", "implementation", "--resume-session", THREAD]


def descriptor(payload, owner="aico"):
    fields = [payload[k] for k in ("tool", "projectId", "projectRoot", "initialPrompt", "role", "leadRootReference", "facetCapsuleRef")]
    if payload.get("resumeSessionId"):
        fields.append(payload["resumeSessionId"])
    if payload.get("model") or payload.get("reasoningEffort") or payload.get("daybreak") is not None or payload.get("agentHubContext") is not None:
        fields.append({"model": payload.get("model"), "reasoningEffort": payload.get("reasoningEffort"),
                       **({"daybreak": payload["daybreak"]} if payload.get("daybreak") is not None else {}),
                       **({"agentHubContext": payload["agentHubContext"]} if payload.get("agentHubContext") is not None else {})})
    if payload.get("workRole"):
        fields.append({"workRole": payload.get("workRole"), "workRoleDisplayName": payload.get("workRoleDisplayName")})
    if payload.get("instructions"):
        fields.append({"instructions": payload["instructions"]["revision"]})
    return {"owner": owner, "requestId": payload["requestId"],
            "digest": hashlib.sha256(json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest(),
            "hostIdentity": "12345678",
            "logicalSessionId": "aico-root-" + THREAD, "generation": "a" * 64,
            "surfaceLocator": "aico://widget/12345678",
            "status": "running", "role": payload["role"],
            "workRole": payload.get("workRole"), "workRoleDisplayName": payload.get("workRoleDisplayName"),
            "leadRootReference": payload["leadRootReference"], "facetCapsuleRef": payload["facetCapsuleRef"]}
