"""Checked-main delivery to GitHub: one exact committed source, one plain fast-forward push.

`aico publish` chooses the project and source and records the local check; this is the transport it runs
(`st vcs deliver`, the github-delivery extension). It accepts only a commit that is the tip of the repo's
default branch (`main`, or `master` when that is the only one) with a passing local-check receipt, verifies the
complete outgoing history and the workflow-effects authority, and then pushes `<sha>:refs/heads/<branch>`. It creates no commit, never touches the worktree, index, branch or git
config, never forces, and never handles tokens (git's credential helper and gh own them). Diagnostics from git
or GitHub never reach the result: it carries fixed reason codes only.

    python3 -m git_outgoing.delivery --root DIR --sha OID [--authorize-workflow PATH]...

prints one JSON object and exits 1 unless `publication_complete` is true.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Sequence
from datetime import UTC, datetime
from ipaddress import ip_address
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from . import safe_subprocess
from .github_api import GitHub, GitHubError
from .outgoing import (
    OutgoingAdmissionUnavailable,
    OutgoingVerificationError,
    PushUpdate,
    verify_outgoing,
)
from .publication_effects import delivery_workflow_authority

_OID = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
# Git's own wording when the credential helper has no (valid) GitHub login.
_AUTH_FAILURE = re.compile(r"could not read Username|Authentication failed|Invalid username or token", re.IGNORECASE)


class _InspectionFailed(RuntimeError):
    """Local inspection failed; no raw Git diagnostic escapes to records."""


class _TransportUnavailable(_InspectionFailed):
    """Remote transport cannot establish evidence; not a source repair finding."""


class _AuthenticationUnavailable(_TransportUnavailable):
    """The remote refused or never got credentials: the host's GitHub login needs repair."""


# A refused history can hold thousands; the result is one bounded JSON line. The reader keeps
# 64 KB and a long non-ASCII path escapes to about 6 bytes a character, so the bytes need a cap too.
_FINDINGS_REPORTED = 50
_FINDINGS_BYTES = 32_000


def _reported_findings(findings: Sequence[Any]) -> list[Any]:
    reported: list[Any] = []
    size = 0
    for finding in findings[:_FINDINGS_REPORTED]:
        size += len(json.dumps(finding))
        if size > _FINDINGS_BYTES:
            break
        reported.append(finding)
    return reported


class _OutgoingFailed(RuntimeError):
    """Publication security evidence was unavailable or rejected."""


class _AdmissionUnavailable(RuntimeError):
    """Shared validation admission is unavailable, not a source finding."""


def network_repository_identity(url: str) -> tuple[str, int | None, str] | None:
    """(host, port, path) of an SSH/HTTPS remote for comparing routes, without retaining secrets; None if unsafe."""
    if not url or any(character.isspace() for character in url) or "\0" in url:
        return None
    try:
        parsed = urlsplit(url)
        if parsed.scheme in {"https", "ssh"} and parsed.hostname:
            if parsed.query or parsed.fragment:
                return None
            host, path, port = parsed.hostname, parsed.path, parsed.port
            if port in {443 if parsed.scheme == "https" else 22}:
                port = None
        else:
            scp = re.fullmatch(r"(?:[A-Za-z0-9_.-]+@)?([^/:]+):(.+)", url)
            if not scp or "://" in url or "::" in url or parsed.scheme in {"file", "http", "ext"}:
                return None
            host, path, port = scp[1], scp[2], None
        host = host.lower().rstrip(".")
        if not host or host.startswith("-"):
            return None
        if host in {"localhost", "localhost.localdomain"} or host.endswith(".localhost"):
            return None
        try:
            address = ip_address(host)
        except ValueError:
            address = None
        if address is not None and (address.is_loopback or address.is_unspecified):
            return None
        path = path.strip("/")
        if not path:
            return None
        return host, port, path.removesuffix(".git")
    except ValueError:
        return None


def _git(project: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    environment.update(GIT_OPTIONAL_LOCKS="0", GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0", GIT_NO_REPLACE_OBJECTS="1")
    command = ["git", "-C", str(project), *arguments]
    network = arguments[0] in {"push", "fetch", "ls-remote"}
    if network:
        watchdog = shutil.which("timeout")
        if watchdog is None:
            raise _TransportUnavailable
        ssh = _git(project, "config", "--get", "core.sshCommand")
        if ssh.returncode not in {0, 1}:
            raise _InspectionFailed
        ssh_command = os.environ.get("GIT_SSH_COMMAND") or (ssh.stdout.strip() if ssh.returncode == 0 else "ssh")
        environment.update(GCM_INTERACTIVE="Never", GIT_SSH_COMMAND=ssh_command + " -o BatchMode=yes -o ConnectTimeout=15")
        command = [watchdog, "--signal=TERM", "--kill-after=5s", "300s", *command]
    try:
        return safe_subprocess.run(
            command, capture_output=True, text=True, stdin=subprocess.DEVNULL, env=environment,
            timeout=310 if network else 30, check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        if network:
            raise _TransportUnavailable from exc
        raise _InspectionFailed from exc


def _value(project: Path, *arguments: str) -> str:
    result = _git(project, *arguments)
    if result.returncode != 0:
        raise _InspectionFailed
    return result.stdout.strip()


def _receipt(root: Path, sha: str) -> Path:
    common = _git_plain(root, "rev-parse", "--path-format=absolute", "--git-common-dir")
    return Path(common) / "aico-checks" / "receipts" / f"publish-{sha}.json"


def _git_plain(root: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=False)
    if result.returncode:
        raise ValueError("Local publication source is unavailable")
    return result.stdout.strip()


def default_branch(root: Path) -> str | None:
    """The repo's one default branch: `main`, or `master` when that is the only one of the two."""
    found = [name for name in ("main", "master")
             if subprocess.run(["git", "-C", str(root), "show-ref", "--verify", "--quiet", f"refs/heads/{name}"],
                               check=False).returncode == 0]
    return found[0] if len(found) == 1 else None


def checked_main(root: Path, sha: str, branch: str = "main") -> bool:
    """Recheck the caller's proof at the transport boundary; a private unchecked commit never passes."""
    if not _OID.fullmatch(sha):
        return False
    try:
        if _git_plain(root, "rev-parse", f"refs/heads/{branch}") != sha:
            return False
        value = json.loads(_receipt(root, sha).read_text())
        return (isinstance(value, dict) and value.get("kind") == "aico.local-check.v1"
                and value.get("sha") == sha and value.get("tree") == _git_plain(root, "rev-parse", f"{sha}^{{tree}}")
                and value.get("passed") is True and value.get("failed") == [])
    except (OSError, ValueError):
        return False


def _public_evidence(value: Any) -> Any:
    """Exclude raw command/API diagnostics from the result."""
    if isinstance(value, dict):
        return {key: _public_evidence(item) for key, item in value.items()
                if key not in {"detail", "stdout", "stderr", "error"}}
    if isinstance(value, list):
        return [_public_evidence(item) for item in value]
    return value


def _push(project: Path, head: str, branch: str, remote: str, remote_url: str,
          authorized_workflows: tuple[str, ...]) -> dict[str, Any]:
    """Verify and fast-forward the remote branch to ``head``; never force."""

    def network(*arguments: str) -> subprocess.CompletedProcess[str]:
        response = _git(project, *arguments)
        # A refused push exits 1: porcelain lists the remote's per-ref rejection, or a pre-push hook refused it
        # before any ref was sent. Transport failures exit 128 (or the watchdog's code) and prove no project defect.
        if response.returncode and not (arguments[0] == "push" and response.returncode == 1):
            if _AUTH_FAILURE.search(response.stderr or ""):
                raise _AuthenticationUnavailable
            raise _TransportUnavailable
        return response

    destination = f"refs/heads/{branch}"
    rows = network("ls-remote", "--refs", remote, destination).stdout.splitlines()
    if len(rows) > 1:
        raise _InspectionFailed
    fields = rows[0].split() if rows else []
    if rows and (len(fields) != 2 or not _OID.fullmatch(fields[0]) or len(fields[0]) != len(head) or fields[1] != destination):
        raise _InspectionFailed
    old = fields[0] if fields else None
    if old and _git(project, "cat-file", "-e", f"{old}^{{commit}}").returncode:
        network("fetch", "--no-tags", "--recurse-submodules=no", remote, destination)
    if old == head or (old and _git(project, "merge-base", "--is-ancestor", head, old).returncode == 0):
        return {"status": "SUCCESS", "reason": "already_on_remote", "pushed": False, "sha": head,
                "publication_complete": True, "security": {"state": "not_run", "sha": head},
                "delivery": {"uploaded_source": head}}
    if old and _git(project, "merge-base", "--is-ancestor", old, head).returncode != 0:
        # Remote work this checkout lacks needs a person; never publish around it.
        return {"status": "BLOCKED", "reason": "remote_base_diverged", "pushed": False, "sha": head,
                "publication_complete": False, "security": {"state": "not_run", "sha": head}}
    try:
        verified = verify_outgoing(project, remote_url, [PushUpdate(destination, head, destination, old or "0" * len(head))],
                                   published_bases=(old,) if old else ())
    except OutgoingAdmissionUnavailable as exc:
        raise _AdmissionUnavailable from exc
    except OutgoingVerificationError as exc:
        raise _OutgoingFailed from exc
    security = {"state": "success", "sha": head, "commits_scanned": verified.commits_scanned,
                "refs_checked": verified.refs_checked, "scope": "outgoing_history", "base_sha": old,
                "destination_ref": destination}
    try:
        authority = delivery_workflow_authority(project, head, old, branch, None, git=_git,
                                                authorized=authorized_workflows)
    except ValueError:
        return {"status": "PENDING", "reason": "workflow_effects_unknown", "pushed": False, "sha": head,
                "publication_complete": False, "security": security}
    if authority["unauthorized_workflows"]:
        return {"status": "PENDING", "reason": "workflow_effects_authorization_required", "pushed": False,
                "sha": head, "publication_complete": False, "security": security, "workflow_authority": authority,
                "unauthorized_workflows": authority["unauthorized_workflows"],
                "action": "Authorize the listed workflow effects explicitly for this source before publication"}
    pushed = network("push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no", remote, f"{head}:{destination}")
    if pushed.returncode:
        rejected = any(line.startswith("!\t") and len(line.split("\t")) == 3 for line in pushed.stdout.splitlines())
        return {"status": "BLOCKED", "reason": "remote_push_rejected" if rejected else "pre_push_hook_rejected",
                "pushed": False, "sha": head, "publication_complete": False, "security": security,
                "workflow_authority": authority}
    return {"status": "SUCCESS", "reason": "source_published", "pushed": True, "sha": head,
            "publication_complete": True, "security": security, "workflow_authority": authority,
            "delivery": {"uploaded_source": head}}


def publish_source(source: dict[str, Any], source_commit: str, *, authorized_workflows: tuple[str, ...] = ()) -> dict[str, Any]:
    """Publish one exact committed, locally checked `main` commit of a registered project to its GitHub remote."""
    result: dict[str, Any] = {
        "source_id": source.get("id"), "status": "skipped", "attempted": False,
        "publication_complete": False, "observed_at": datetime.now(UTC).isoformat(),
        "source_status": "unknown", "remote_status": "unobserved", "security": {"state": "not_run"},
        "requested_source_commit": None, "captured_source_commit": None,
    }

    def outcome(status: str, reason: str) -> dict[str, Any]:
        return {**result, "status": status, "reason": reason, "observed_at": datetime.now(UTC).isoformat()}

    if not isinstance(source_commit, str) or not _OID.fullmatch(source_commit):
        return outcome("failed", "invalid_manual_source")
    result["requested_source_commit"] = source_commit
    if source.get("source_type") != "project":
        return outcome("skipped", "non_project_source")
    if not source.get("id") or not source.get("path"):
        return outcome("skipped", "unregistered_source")
    if source.get("enabled") is not True:
        return outcome("skipped", "disabled_source")
    try:
        project = Path(source["path"]).expanduser().resolve(strict=True)
        if not project.is_dir():
            return outcome("skipped", "not_project_directory")
        top = _git(project, "rev-parse", "--show-toplevel")
        if top.returncode != 0:
            return outcome("skipped", "not_git_repository")
        if Path(top.stdout.strip()).resolve() != project:
            return outcome("skipped", "repository_root_mismatch")
        # The selected source is independent of the mutable branch or HEAD.
        branch = default_branch(project)
        if branch is None:
            return outcome("pending", "manual_default_branch_required")
        head_result = _git(project, "rev-parse", "--verify", f"{source_commit}^{{commit}}")
        if head_result.returncode != 0 or head_result.stdout.strip() != source_commit:
            return outcome("failed", "manual_source_unavailable")
        head = source_commit
        if not checked_main(project, head, branch):
            return outcome("failed", "local_check_required")
        result.update(head=head, branch=branch, source_status="captured", vcs="git", captured_source_commit=head,
                      source_tree=_value(project, "rev-parse", f"{head}^{{tree}}"))
        route = _value(project, "for-each-ref", "--format=%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)",
                       f"refs/heads/{branch}").split("\0")
        # LAN remotes own immediate sync. GitHub publication chooses its own existing route without changing
        # the branch upstream or any git config.
        github_remotes = []
        for name in _value(project, "remote").splitlines():
            urls = _value(project, "remote", "get-url", "--all", name).splitlines()
            identity = network_repository_identity(urls[0]) if len(urls) == 1 else None
            if identity is not None and identity[0] == "github.com" and identity[1] is None:
                github_remotes.append(name)
        preferred = route[1] if len(route) == 3 and route[1] in github_remotes else None
        if preferred is None and len(github_remotes) == 1:
            preferred = github_remotes[0]
        if preferred is None:
            return outcome("skipped", "no_github_remote" if not github_remotes else "ambiguous_remote_route")
        remote = preferred
        upstream_ref = f"refs/heads/{branch}"
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", remote):
            return outcome("skipped", "incorrect_upstream_route")
        fetch_urls = _value(project, "remote", "get-url", "--all", remote).splitlines()
        push_urls = _value(project, "remote", "get-url", "--push", "--all", remote).splitlines()
        if len(fetch_urls) != 1 or len(push_urls) != 1:
            return outcome("skipped", "ambiguous_remote_route")
        identity = network_repository_identity(fetch_urls[0])
        if identity is None or network_repository_identity(push_urls[0]) != identity:
            return outcome("skipped", "unsafe_remote_route")
        if identity[0] != "github.com" or identity[1] is not None:
            return outcome("skipped", "unsafe_remote_route")
        result["repository"] = list(identity)
        mirror = _git(project, "config", "--bool", "--get", f"remote.{remote}.mirror")
        if mirror.returncode not in {0, 1}:
            return outcome("skipped", "uncertain_mirror_configuration")
        if mirror.returncode == 0 and mirror.stdout.strip() == "true":
            return outcome("skipped", "mirror_remote")
        result.update(remote=remote, upstream_ref=upstream_ref)
        try:
            repository = GitHub(project, identity[2]).api("")
        except GitHubError as exc:
            result["remote_status"] = "unknown"
            return outcome("pending" if exc.unavailable else "failed", exc.reason)
        if repository is not None:
            if repository.get("archived") is True:
                return outcome("skipped", "remote_repository_archived")
            if repository.get("default_branch") not in {None, branch}:
                return outcome("skipped", "remote_default_branch_mismatch")
        result["visibility"] = "private" if repository is not None and repository.get("private") is True else "public"
        result["acceptance"] = {"state": "reused", "reason": "local_check", "source_commit": head}
        result["source_status"] = "accepted"
        result["attempted"] = True
        delivered = _push(project, head, branch, remote, push_urls[0], authorized_workflows)
        result.update(delivered)
        result["remote_status"] = ("uploaded" if delivered["publication_complete"] else
                                   "pending" if delivered["status"] == "PENDING" else "blocked")
        status = ("published" if delivered["publication_complete"] else
                  "pending" if delivered["status"] == "PENDING" else "failed")
        return outcome(status, delivered["reason"])
    except _AdmissionUnavailable:
        result["security"] = {"state": "unavailable", "sha": result.get("head")}
        result["remote_status"] = "unknown"
        result["action"] = "Restore shared heavy-work admission before retrying required outgoing verification"
        return outcome("pending", "heavy_work_admission_unavailable")
    except _OutgoingFailed as exc:
        result["security"] = {"state": "blocked", "sha": result.get("head")}
        if isinstance(exc.__cause__, OutgoingVerificationError):
            # Verifier messages are fixed, already-redacted reasons.
            result["security"]["reason"] = str(exc.__cause__)
            findings = exc.__cause__.findings
            if findings:
                result["security"].update(findings=_reported_findings(findings), findings_total=len(findings))
        result["action"] = "Repair the outgoing scanner, policy, history or secret findings before retry"
        return outcome("failed", "outgoing_verification_failed")
    except _AuthenticationUnavailable:
        result["remote_status"] = "unknown"
        return outcome("pending", "remote_authentication_unavailable")
    except _TransportUnavailable:
        result["remote_status"] = "unknown"
        return outcome("pending", "remote_transport_unavailable")
    except (ImportError, OSError, ValueError, TypeError, KeyError, RuntimeError, subprocess.SubprocessError):
        return outcome("failed", "publication_inspection_unavailable")


def deliver(root: Path, sha: str, *, authorized_workflows: tuple[str, ...] = ()) -> dict[str, Any]:
    if not checked_main(root, sha, default_branch(root) or "main"):
        return {"publication_complete": False, "pushed": False, "reason": "local_check_required"}
    # No registry lookup here: `aico publish` resolved the registered root and policy before this call.
    source = {"id": root.name, "project_id": root.name, "path": str(root), "source_type": "project", "enabled": True}
    return _public_evidence(publish_source(source, sha, authorized_workflows=authorized_workflows))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="github-delivery", description=__doc__.split("\n\n")[0])
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--authorize-workflow", action="append", default=[])
    args = parser.parse_args(argv)
    try:
        result = deliver(args.root, args.sha, authorized_workflows=tuple(args.authorize_workflow))
    except Exception:  # noqa: BLE001 - a transport fault is a reason code, never a traceback with diagnostics
        result = {"publication_complete": False, "reason": "transport_unavailable"}
    print(json.dumps(result))
    return 0 if result.get("publication_complete") else 1


if __name__ == "__main__":
    sys.exit(main())
