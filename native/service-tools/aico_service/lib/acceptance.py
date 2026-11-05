"""Adapt Aico's exact-commit acceptance to the retained service release contract.

Aico owns the check plan, clean worktree, tool execution and pass reuse. This
module binds that successful CLI operation to a durable service descriptor;
supplied receipts are source selectors and always go back through Aico.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import subprocess
import tempfile
import time
from collections.abc import Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from st_sdk.admission import heavy_work

from . import coord, registry

REPO_LOCK_WAIT_SECONDS = 300.0


class AcceptanceError(RuntimeError):
    """Aico could not accept the selected commit."""


def _git(repo: Path, args: Sequence[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "--no-replace-objects", "--no-optional-locks", *args], cwd=repo,
        text=True, capture_output=True, check=False,
        env={**{key: value for key, value in os.environ.items() if not key.startswith("GIT_")},
             "GIT_OPTIONAL_LOCKS": "0", "GIT_NO_LAZY_FETCH": "1"},
    )


def _git_value(repo: Path, args: Sequence[str], error: str) -> str:
    result = _git(repo, args)
    if result.returncode or not result.stdout.strip():
        raise AcceptanceError(error)
    return result.stdout.strip()


def _common(repo: Path) -> Path:
    return Path(_git_value(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "Repository metadata unavailable"))


@contextmanager
def repo_lock(repo: Path, *, purpose: str, wait_seconds: float = REPO_LOCK_WAIT_SECONDS):
    directory = _common(repo) / "st"
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "repo-mutation.lock").open("a+") as handle:
        deadline = time.monotonic() + wait_seconds
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError as exc:
                if time.monotonic() >= deadline:
                    raise AcceptanceError(f"Another repository operation prevented {purpose}") from exc
                time.sleep(0.2)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def _digest(value: Mapping[str, Any]) -> str:
    return hashlib.sha256(json.dumps(dict(value), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def accept_source(repo: Path, sha: str) -> dict[str, Any]:
    commit = _git_value(repo, ["rev-parse", "--verify", f"{sha}^{{commit}}"], "Requested commit unavailable")
    tree = _git_value(repo, ["rev-parse", "--verify", f"{commit}^{{tree}}"], "Requested source tree unavailable")
    command = [registry.aico_binary(), "check", "--acceptance", "--sha", commit]
    if ack := coord.current_ack():
        command.extend(["--with-ack", ack])
    with heavy_work("managed service acceptance") as work:
        result = work.run(command, cwd=repo, check=False)
    if result.returncode:
        raise AcceptanceError(f"Aico acceptance failed for {commit[:12]} (exit {result.returncode})")
    # The public CLI's successful exit accepts exactly the requested commit.
    # Its retained full-gate report is evidence; it may name an earlier commit
    # with the same accepted tree when Aico reused that pass.
    report_path = _common(repo) / "aico-checks" / "receipts" / f"accept-{tree}.json"
    try:
        report = json.loads(report_path.read_text())
    except (OSError, ValueError) as exc:
        raise AcceptanceError("Aico acceptance passed but its retained report is unavailable") from exc
    if (not isinstance(report, dict) or report.get("passed") is not True or report.get("tree") != tree
            or report.get("scope") is not None or not isinstance(report.get("results"), list)):
        raise AcceptanceError("Aico report does not prove full acceptance of the selected tree")
    descriptor = {
        "service_acceptance_version": 1,
        "coverage": "full", "source_commit": commit, "source_tree": tree,
        "checks": report.get("results", []), "check_count": len(report.get("results", [])),
        "duration_ms": report.get("ms"), "completed_at": report.get("at"),
        "input_fingerprint": tree, "acceptance_plan_fingerprint": _digest(report),
        "aico_acceptance_report": str(report_path),
    }
    descriptor["acceptance_id"] = _digest(descriptor)
    directory = _common(repo) / "aico-checks" / "service-acceptance"
    directory.mkdir(parents=True, exist_ok=True)
    artifact = directory / f"{descriptor['acceptance_id']}.json"
    descriptor["acceptance_artifact"] = str(artifact)
    with tempfile.NamedTemporaryFile("w", dir=directory, delete=False) as stream:
        json.dump(descriptor, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(stream.name, artifact)
    return descriptor


def validate_acceptance_receipt(repo: Path, receipt: Path | Mapping[str, Any], *, sha: str | None = None) -> dict[str, Any]:
    try:
        value = json.loads(receipt.read_text()) if isinstance(receipt, Path) else dict(receipt)
    except (OSError, ValueError, TypeError) as exc:
        raise AcceptanceError("Acceptance source reference is unavailable") from exc
    if not isinstance(value, dict):
        raise AcceptanceError("Acceptance source reference must be an object")
    source = value.get("source") if isinstance(value.get("source"), dict) else {}
    commit = value.get("source_commit") or source.get("commit")
    if not isinstance(commit, str) or not commit:
        raise AcceptanceError("Acceptance source reference has no commit")
    resolved = _git_value(repo, ["rev-parse", "--verify", f"{commit}^{{commit}}"], "Accepted commit unavailable")
    if sha is not None and resolved != _git_value(repo, ["rev-parse", "--verify", f"{sha}^{{commit}}"], "Pinned commit unavailable"):
        raise AcceptanceError("Acceptance receipt belongs to a different source commit")
    if value.get("service_acceptance_version") == 1:
        identity = {key: entry for key, entry in value.items()
                    if key not in {"acceptance_id", "acceptance_artifact", "reused", "reuse_lookup_ms"}}
        identifier = _digest(identity)
        artifact = _common(repo) / "aico-checks" / "service-acceptance" / f"{identifier}.json"
        if value.get("acceptance_id") != identifier or value.get("acceptance_artifact") != str(artifact):
            raise AcceptanceError("Service acceptance descriptor integrity check failed")
        try:
            retained = json.loads(artifact.read_text())
        except (OSError, ValueError) as exc:
            raise AcceptanceError("Retained service acceptance descriptor is unavailable") from exc
        if retained != {key: entry for key, entry in value.items() if key not in {"reused", "reuse_lookup_ms"}}:
            raise AcceptanceError("Service acceptance descriptor differs from its retained evidence")
        # Reconfirm with the owning checker, then keep the queued immutable
        # identity even if Aico has refreshed its mutable pass for this tree.
        accept_source(repo, resolved)
        return value
    return accept_source(repo, resolved)
