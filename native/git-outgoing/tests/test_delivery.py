"""Checked-main delivery pushes one exact, locally checked commit by plain fast-forward and preserves the checkout."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from unittest.mock import Mock

import pytest
from git_outgoing import delivery

_URL = "https://github.com/fixture/project.git"


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True).stdout.strip()


def _check(project: Path, sha: str, *, passed: bool = True, failed: list[str] | None = None) -> None:
    """The receipt `aico check` writes for a commit it checked."""
    path = Path(_git(project, "rev-parse", "--path-format=absolute", "--git-common-dir")) / "aico-checks/receipts" / f"publish-{sha}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"kind": "aico.local-check.v1", "sha": sha, "tree": _git(project, "rev-parse", f"{sha}^{{tree}}"),
                                "passed": passed, "lane": "quick", "failed": failed or [], "at": "2026-11-06T00:00:00+00:00"}))


@pytest.fixture
def source(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict:
    """A GitHub project one commit ahead of its (local bare) remote, with a passing local check on HEAD."""
    remote = tmp_path / "remote.git"
    project = tmp_path / "project"
    project.mkdir()
    _git(project, "init", "-b", "main")
    _git(project, "config", "user.name", "Fixture")
    _git(project, "config", "user.email", "fixture@example.invalid")
    (project / "note").write_text("published")
    _git(project, "add", "note")
    _git(project, "commit", "-m", "published")
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(remote)], check=True)
    _git(project, "push", "-q", str(remote), "main")
    _git(project, "remote", "add", "origin", _URL)
    _git(project, "update-ref", "refs/remotes/origin/main", "HEAD")
    _git(project, "branch", "--set-upstream-to", "origin/main")
    (project / "note").write_text("committed unpublished")
    _git(project, "add", "note")
    _git(project, "commit", "-m", "unpublished")
    original = delivery._git

    def routed(repo, *args):
        # Network commands reach the bare fixture remote, without global hooks.
        if args[0] in {"push", "fetch", "ls-remote"}:
            return subprocess.run(["git", "-c", f"url.{remote}.insteadOf={_URL}", "-c", "core.hooksPath=/dev/null",
                                   "-C", str(repo), *args], capture_output=True, text=True, check=False)
        return original(repo, *args)

    monkeypatch.setattr(delivery, "_git", routed)
    monkeypatch.setattr(delivery.GitHub, "api", lambda *_: {"private": True, "default_branch": "main"})
    monkeypatch.setattr(delivery, "verify_outgoing", Mock(return_value=Mock(commits_scanned=1, refs_checked=1)))
    _check(project, _git(project, "rev-parse", "HEAD"))
    return {"path": project, "remote": remote}


def _head(source: dict) -> str:
    return _git(source["path"], "rev-parse", "HEAD")


def _remote_main(source: dict) -> str:
    return _git(source["remote"], "rev-parse", "main")


def test_checked_main_is_fast_forwarded_after_outgoing_verification(source):
    project, sha = source["path"], _head(source)
    (project / "note").write_text("staged")
    _git(project, "add", "note")
    (project / "note").write_text("unstaged")
    (project / "unfinished").write_text("untracked")
    index = (project / ".git/index").read_bytes()
    result = delivery.deliver(project, sha)
    assert result["status"] == "published" and result["reason"] == "source_published"
    assert result["publication_complete"] and result["pushed"] and result["visibility"] == "private"
    assert result["security"]["state"] == "success" and result["security"]["sha"] == sha
    assert _remote_main(source) == sha
    assert _git(project, "rev-parse", "refs/remotes/origin/main") == sha  # the push records itself
    assert (project / ".git/index").read_bytes() == index
    assert _git(project, "show", ":note") == "staged" and (project / "unfinished").read_text() == "untracked"
    assert delivery.verify_outgoing.call_args.kwargs["published_bases"] != ()


def test_a_master_only_repo_publishes_its_checked_master(source, monkeypatch):
    project, remote, sha = source["path"], source["remote"], _head(source)
    _git(project, "branch", "-m", "main", "master")
    _git(remote, "branch", "-m", "main", "master")
    _git(project, "update-ref", "-d", "refs/remotes/origin/main")
    _git(project, "update-ref", "refs/remotes/origin/master", "HEAD~1")
    monkeypatch.setattr(delivery.GitHub, "api", lambda *_: {"private": True, "default_branch": "master"})
    result = delivery.deliver(project, sha)
    assert result["publication_complete"] and result["pushed"] and result["branch"] == "master"
    assert _git(remote, "rev-parse", "master") == sha
    # With both branches there is no single default: nothing is guessed.
    _git(project, "branch", "main", "HEAD")
    assert delivery.default_branch(project) is None
    assert delivery.deliver(project, sha)["reason"] == "manual_default_branch_required"


def test_no_passing_check_on_main_never_reaches_the_remote(source):
    project, sha = source["path"], _head(source)
    before = _remote_main(source)
    _check(project, sha, passed=False, failed=["pytest"])
    assert delivery.deliver(project, sha) == {"publication_complete": False, "pushed": False, "reason": "local_check_required"}
    (project / ".git/aico-checks/receipts" / f"publish-{sha}.json").unlink()
    assert delivery.deliver(project, sha)["reason"] == "local_check_required"
    _git(project, "branch", "other", "HEAD~1")
    _git(project, "checkout", "-q", "other")
    _git(project, "update-ref", "refs/heads/main", "HEAD")  # main moved off the checked commit
    _check(project, sha)
    assert delivery.deliver(project, sha)["reason"] == "local_check_required"
    assert _remote_main(source) == before
    assert delivery.deliver(project, "not-an-oid")["reason"] == "local_check_required"


def test_github_route_is_chosen_without_changing_the_lan_upstream(source):
    project, sha = source["path"], _head(source)
    _git(project, "remote", "add", "lan", str(source["remote"]))
    _git(project, "update-ref", "refs/remotes/lan/main", sha)
    _git(project, "branch", "--set-upstream-to", "lan/main")
    result = delivery.deliver(project, sha)
    assert result["publication_complete"] and _remote_main(source) == sha
    assert _git(project, "config", "branch.main.remote") == "lan"


def test_remote_without_a_github_route_is_skipped(source):
    project, sha = source["path"], _head(source)
    _git(project, "remote", "set-url", "origin", "https://gitlab.com/fixture/project.git")
    assert delivery.deliver(project, sha)["reason"] == "no_github_remote"
    _git(project, "remote", "set-url", "origin", _URL)
    _git(project, "remote", "add", "second", "https://github.com/fixture/other.git")
    _git(project, "branch", "--unset-upstream")
    assert delivery.deliver(project, sha)["reason"] == "ambiguous_remote_route"


def test_source_already_on_remote_needs_no_push(source):
    project, sha = source["path"], _head(source)
    assert delivery.deliver(project, sha)["pushed"] is True
    again = delivery.deliver(project, sha)
    assert again["publication_complete"] and again["pushed"] is False and again["reason"] == "already_on_remote"


def test_remote_work_this_checkout_lacks_blocks_without_push(source, tmp_path):
    other = tmp_path / "other"
    subprocess.run(["git", "clone", "-q", str(source["remote"]), str(other)], check=True)
    _git(other, "-c", "user.name=Other", "-c", "user.email=o@example.invalid", "commit", "--allow-empty", "-m", "remote only")
    _git(other, "push", "-q", "origin", "main")
    remote_head = _remote_main(source)
    result = delivery.deliver(source["path"], _head(source))
    assert result["status"] == "failed" and result["reason"] == "remote_base_diverged"
    assert not result["publication_complete"] and _remote_main(source) == remote_head


def test_ref_rejection_is_a_finding_and_diagnostics_stay_out_of_the_result(source, monkeypatch):
    routed = delivery._git

    def rejecting(repo, *args):
        if args[0] == "push":
            assert "--porcelain" in args and "--force" not in args
            return subprocess.CompletedProcess(args, 1, "!\tHEAD:refs/heads/main\t[remote rejected]\n", "secret-diagnostic")
        return routed(repo, *args)

    monkeypatch.setattr(delivery, "_git", rejecting)
    result = delivery.deliver(source["path"], _head(source))
    assert result["status"] == "failed" and result["reason"] == "remote_push_rejected"
    assert "secret-diagnostic" not in json.dumps(result)


def test_pre_push_hook_refusal_is_not_a_remote_rejection(source, monkeypatch):
    routed = delivery._git

    def refusing(repo, *args):
        if args[0] == "push":
            return subprocess.CompletedProcess(args, 1, "", "hook said no")
        return routed(repo, *args)

    monkeypatch.setattr(delivery, "_git", refusing)
    assert delivery.deliver(source["path"], _head(source))["reason"] == "pre_push_hook_rejected"


@pytest.mark.parametrize(("stderr", "reason"), [("fatal: could not read Username for 'https://github.com'", "remote_authentication_unavailable"),
                                                ("fatal: unable to access: timed out", "remote_transport_unavailable")])
def test_transport_failures_are_pending_not_findings(source, monkeypatch, stderr, reason):
    routed = delivery._git

    def failing(repo, *args):
        if args[0] == "ls-remote":
            return subprocess.CompletedProcess(args, 128, "", stderr)
        return routed(repo, *args)

    monkeypatch.setattr(delivery, "_git", failing)
    result = delivery.deliver(source["path"], _head(source))
    assert result["status"] == "pending" and result["reason"] == reason and not result.get("pushed")
    assert stderr not in json.dumps(result)


def test_deployment_workflow_requires_separate_explicit_authority(source):
    project = source["path"]
    workflow = project / ".github/workflows/deploy.yml"
    workflow.parent.mkdir(parents=True)
    workflow.write_text("on: push\njobs:\n  deploy:\n    environment: production\n    steps:\n      - run: scripts/deploy.sh\n")
    _git(project, "add", ".github")
    _git(project, "commit", "-m", "Declare deployment effects")
    sha = _head(source)
    _check(project, sha)
    before = _remote_main(source)
    workflow.write_text("on: workflow_dispatch\njobs: {}\n")  # later WIP cannot erase effects in the selected source
    pending = delivery.deliver(project, sha)
    assert pending["status"] == "pending" and pending["reason"] == "workflow_effects_authorization_required"
    assert pending["unauthorized_workflows"] == [".github/workflows/deploy.yml"]
    assert _remote_main(source) == before
    authorized = delivery.deliver(project, sha, authorized_workflows=(".github/workflows/deploy.yml",))
    assert authorized["status"] == "published" and _remote_main(source) == sha


@pytest.mark.parametrize(("repository", "reason"), [({"private": True, "archived": True}, "remote_repository_archived"),
                                                    ({"private": True, "default_branch": "trunk"}, "remote_default_branch_mismatch")])
def test_remote_metadata_mismatch_never_pushes(source, monkeypatch, repository, reason):
    monkeypatch.setattr(delivery.GitHub, "api", lambda *_: repository)
    result = delivery.deliver(source["path"], _head(source))
    assert result["status"] == "skipped" and result["reason"] == reason and not result["attempted"]


@pytest.mark.parametrize(("unavailable", "status", "expected"), [(True, "pending", "remote_api_unavailable"),
                                                                 (False, "failed", "remote_publication_failed")])
def test_github_metadata_error_is_pending_only_for_outages(source, monkeypatch, unavailable, status, expected):
    def failing(*_):
        raise delivery.GitHubError("x", unavailable=unavailable, reason=expected)

    monkeypatch.setattr(delivery.GitHub, "api", failing)
    result = delivery.deliver(source["path"], _head(source))
    assert result["status"] == status and result["reason"] == expected and not result["attempted"]


def test_security_failure_never_pushes_and_reports_only_the_redacted_reason(source, monkeypatch):
    before = _remote_main(source)
    failure = delivery.OutgoingVerificationError("Outgoing history contains a secret path.")
    monkeypatch.setattr(delivery, "verify_outgoing", Mock(side_effect=failure))
    result = delivery.deliver(source["path"], _head(source))
    assert result["status"] == "failed" and result["reason"] == "outgoing_verification_failed"
    assert result["security"] == {"state": "blocked", "sha": _head(source), "reason": "Outgoing history contains a secret path."}
    assert _remote_main(source) == before


def test_admission_outage_defers_publication_without_push(source, monkeypatch):
    before = _remote_main(source)
    monkeypatch.setattr(delivery, "verify_outgoing", Mock(side_effect=delivery.OutgoingAdmissionUnavailable("down")))
    result = delivery.deliver(source["path"], _head(source))
    assert result["status"] == "pending" and result["reason"] == "heavy_work_admission_unavailable"
    assert _remote_main(source) == before


def test_verifier_sees_the_exact_fast_forward_update(source):
    delivery.deliver(source["path"], _head(source))
    _, remote_url, updates = delivery.verify_outgoing.call_args.args[:3]
    assert remote_url == _URL
    [update] = updates
    assert (update.local_ref, update.remote_ref, update.local_oid) == ("refs/heads/main", "refs/heads/main", _head(source))
    assert update.remote_oid == _git(source["path"], "rev-parse", "HEAD~1")


def test_network_git_is_bounded_noninteractive_and_fails_closed(tmp_path, monkeypatch):
    captured = []

    def run(command, **kwargs):
        captured.append((command, kwargs))
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(delivery.safe_subprocess, "run", run)
    monkeypatch.setattr(delivery.shutil, "which", lambda _: "/usr/bin/timeout")
    monkeypatch.setenv("GIT_SSH_COMMAND", "ssh -i /keys/existing")
    delivery._git(tmp_path, "push", "--porcelain", "origin", "a" * 40 + ":refs/heads/main")
    command, kwargs = captured[-1]
    assert command[:4] == ["/usr/bin/timeout", "--signal=TERM", "--kill-after=5s", "300s"]
    assert kwargs["timeout"] == 310 and kwargs["env"]["GIT_TERMINAL_PROMPT"] == "0" and kwargs["env"]["GCM_INTERACTIVE"] == "Never"
    assert kwargs["env"]["GIT_SSH_COMMAND"] == "ssh -i /keys/existing -o BatchMode=yes -o ConnectTimeout=15"
    monkeypatch.setattr(delivery.shutil, "which", lambda _: None)
    with pytest.raises(delivery._TransportUnavailable):
        delivery._git(tmp_path, "ls-remote", "origin")


@pytest.mark.parametrize("url", ["file:///tmp/project.git", "/tmp/project.git", "https://localhost/project.git",
                                 "ssh://git@127.0.0.1/project.git", "ext::private-helper", "git://example.invalid/project.git",
                                 "https://example.invalid/project.git?repository=private"])
def test_unsafe_routes_have_no_repository_identity(url):
    assert delivery.network_repository_identity(url) is None


def test_https_and_scp_routes_to_one_repository_compare_equal():
    assert delivery.network_repository_identity("https://github.com/o/r.git") == ("github.com", None, "o/r")
    assert delivery.network_repository_identity("git@github.com:o/r.git") == ("github.com", None, "o/r")
    assert delivery.network_repository_identity("ssh://git@github.com:22/o/r") == ("github.com", None, "o/r")


def test_cli_prints_one_json_object_and_exits_by_completion(source, capsys):
    project, sha = source["path"], _head(source)
    assert delivery.main(["--root", str(project), "--sha", sha]) == 0
    assert json.loads(capsys.readouterr().out)["reason"] == "source_published"
    assert delivery.main(["--root", str(project), "--sha", "0" * 40]) == 1
    assert json.loads(capsys.readouterr().out)["reason"] == "local_check_required"
