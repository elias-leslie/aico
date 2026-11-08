"""Outgoing-history verifier tests (vendored from SummitFlow's publication guard tests, scratch cases dropped)."""

from __future__ import annotations

import json
import os
import subprocess
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import Mock

import pytest
from git_outgoing.outgoing import (
    OutgoingVerificationError,
    PushUpdate,
    parse_updates,
    verify_outgoing,
)

ZERO = "0" * 40

def test_outgoing_admission_failure_is_typed_before_history_work(monkeypatch, tmp_path) -> None:
    from git_outgoing import outgoing
    from git_outgoing.heavy_work import HeavyWorkError

    @contextmanager
    def unavailable(_label):
        raise HeavyWorkError("fixture infrastructure detail")
        yield  # pragma: no cover

    monkeypatch.setattr(outgoing, "heavy_work", unavailable)
    monkeypatch.setattr(outgoing, "_git", lambda *_args, **_kwargs: pytest.fail("history traversal started"))
    with pytest.raises(outgoing.OutgoingAdmissionUnavailable, match="admission is unavailable") as captured:
        verify_outgoing(tmp_path, "/tmp/fixture-destination", [])
    assert "fixture infrastructure detail" not in str(captured.value)




@pytest.fixture
def history(tmp_path: Path):
    repo = tmp_path / "repo"
    repo.mkdir()
    hooks = tmp_path / "hooks"
    hooks.mkdir()
    env = dict(os.environ, GIT_AUTHOR_NAME="Fixture", GIT_AUTHOR_EMAIL="fixture@example.invalid",
               GIT_COMMITTER_NAME="Fixture", GIT_COMMITTER_EMAIL="fixture@example.invalid", BASH_ENV="")

    def git(*args: str, data: bytes | None = None) -> str:
        result = subprocess.run(["git", "-c", f"core.hooksPath={hooks}", "-C", str(repo), *args],
                                input=data, capture_output=True, check=True, env=env)
        return result.stdout.decode().strip()

    git("init", "-q")
    policy = tmp_path / "policy"
    policy.mkdir()
    policy.joinpath("denylist.txt").write_text("*.secret\n*.pass\n.env\n*.key\n")
    policy.joinpath("allowlist.txt").write_text("*.example\n")
    policy.joinpath("publication-fingerprints.txt").write_text("# No reviewed findings.\n")
    scanner = tmp_path / "scanner"
    scanner.write_text("#!/bin/sh\nexit 0\n")
    scanner.chmod(0o700)
    tree = git("mktree", data=b"")

    def commit(parent: str | None = None, path: str | None = None, body: bytes = b"ordinary\n", *, mode: str = "100644") -> str:
        commit_tree = tree
        if path:
            oid = git("hash-object", "-w", "--stdin", data=body)
            parts = path.split("/")
            commit_tree = git("mktree", data=f"{mode} blob {oid}\t{parts[-1]}\n".encode())
            for name in reversed(parts[:-1]):
                commit_tree = git("mktree", data=f"040000 tree {commit_tree}\t{name}\n".encode())
        return git("commit-tree", commit_tree, *(["-p", parent] if parent else []), data=b"fixture\n")

    return repo, policy, scanner, git, commit, hooks


def check(history, oid: str, old: str = ZERO, **kwargs):
    repo, policy, scanner, *_ = history
    return verify_outgoing(repo, "https://example.invalid/fixture/repo.git",
                           [PushUpdate("refs/heads/main", oid, "refs/heads/main", old)],
                           policy_dir=policy, scanner=str(scanner), **kwargs)



def test_new_branch_scans_more_than_200_commits(history) -> None:
    commit = history[4]
    oid = commit()
    for _ in range(205):
        oid = commit(oid)
    assert check(history, oid).commits_scanned == 206


def test_existing_branch_scans_more_than_200_commits(history) -> None:
    commit = history[4]
    old = commit()
    oid = old
    for _ in range(205):
        oid = commit(oid)
    assert check(history, oid, old).commits_scanned == 205


def test_live_base_excludes_only_published_ancestry(history) -> None:
    commit = history[4]
    secret = commit(path="password.pass")
    published = commit(secret)
    new = commit(published)
    assert check(history, new, published_bases=(published,)).commits_scanned == 1
    with pytest.raises(OutgoingVerificationError, match="unavailable"):
        check(history, new, published_bases=("f" * 40,))


def test_new_secret_tree_still_refused_with_live_base(history) -> None:
    commit = history[4]
    base = commit()
    new = commit(base, "password.pass")
    with pytest.raises(OutgoingVerificationError, match="secret-sensitive"):
        check(history, new, published_bases=(base,))



@pytest.mark.parametrize("live_base", [False, True])
def test_unchanged_destination_blob_does_not_block_new_commits(history, live_base) -> None:
    commit = history[4]
    published = commit(None, "deploy/password.pass", b"HOST=example\n")
    new = commit(published, "deploy/password.pass", b"HOST=example\n")
    if live_base:
        assert check(history, new, published_bases=(published,)).commits_scanned == 1
    else:
        assert check(history, new, published).commits_scanned == 1


@pytest.mark.parametrize("body, mode", [(b"HOST=changed\n", "100644"), (b"HOST=example\n", "100755")])
def test_changed_destination_blob_at_denied_path_still_refused(history, body, mode) -> None:
    commit = history[4]
    published = commit(None, "deploy/password.pass", b"HOST=example\n")
    new = commit(published, "deploy/password.pass", body, mode=mode)
    with pytest.raises(OutgoingVerificationError, match="secret-sensitive"):
        check(history, new, published)


REVIEWED_NPMRC = (
    b"minimum-release-age=1440\nblock-exotic-subdeps=true\nstrict-dep-builds=true\n"
    b"dangerously-allow-all-builds=false\nverify-store-integrity=true\n"
)


def test_reviewed_root_npmrc_does_not_disable_history_scanner(history) -> None:
    _, policy, scanner, _, commit, _ = history
    policy.joinpath("denylist.txt").write_text(".npmrc\n.env\n")
    oid = commit(path=".npmrc", body=REVIEWED_NPMRC)
    assert check(history, oid).commits_scanned == 1
    scanner.write_text("#!/bin/sh\nexit 2\n")
    with pytest.raises(OutgoingVerificationError, match="scan"):
        check(history, oid)


@pytest.mark.parametrize("path,body,mode", [
    ("nested/.npmrc", REVIEWED_NPMRC, "100644"),
    (".npmrc", REVIEWED_NPMRC, "100755"),
    (".npmrc", b"minimum-release-age=1440\n", "120000"),
    (".npmrc", b"//registry.example.invalid/:_authToken=fixture\n", "100644"),
    (".npmrc", b"registry=https://example.invalid\n", "100644"),
    (".npmrc", b"verify-store-integrity=${VALUE}\n", "100644"),
    (".npmrc", b"verify-store-integrity=true\nverify-store-integrity=true\n", "100644"),
    (".npmrc", b"verify-store-integrity=true\n# arbitrary fixture comment\n", "100644"),
    (".npmrc", b"verify-store-integrity=true\x00\n", "100644"),
    (".npmrc", b"verify-store-integrity=true\r\n", "100644"),
    (".npmrc", b"verify-store-integrity=true\\\n", "100644"),
    (".npmrc", b"verify-store-integrity=false\n", "100644"),
    (".npmrc", b"dangerously-allow-all-builds=true\n", "100644"),
    (".npmrc", b"minimum-release-age=0\n", "100644"),
    (".npmrc", b"", "100644"),
])
def test_unreviewed_npmrc_shape_remains_denied(history, path, body, mode) -> None:
    history[1].joinpath("denylist.txt").write_text(".npmrc\n.env\n")
    oid = history[4](path=path, body=body, mode=mode)
    with pytest.raises(OutgoingVerificationError, match="secret-sensitive"):
        check(history, oid)


def test_reviewed_npmrc_does_not_override_additional_owner_deny_rule(history) -> None:
    history[1].joinpath("denylist.txt").write_text(".npmrc\n.*\n")
    oid = history[4](path=".npmrc", body=REVIEWED_NPMRC)
    with pytest.raises(OutgoingVerificationError, match="secret-sensitive"):
        check(history, oid)


def test_historical_unsafe_npmrc_cannot_be_hidden_by_current_safe_file(history) -> None:
    history[1].joinpath("denylist.txt").write_text(".npmrc\n.env\n")
    old = history[4](path=".npmrc", body=b"registry=https://example.invalid\n")
    new = history[4](old, ".npmrc", REVIEWED_NPMRC)
    with pytest.raises(OutgoingVerificationError, match="secret-sensitive"):
        check(history, new)


def test_historical_npmrc_mode_change_with_same_blob_is_checked(history) -> None:
    history[1].joinpath("denylist.txt").write_text(".npmrc\n.env\n")
    old = history[4](path=".npmrc", body=REVIEWED_NPMRC)
    new = history[4](old, ".npmrc", REVIEWED_NPMRC, mode="100755")
    with pytest.raises(OutgoingVerificationError, match="secret-sensitive"):
        check(history, new)


@pytest.mark.parametrize("source", ["HEAD", "oid"])
def test_captured_oid_and_head_source_labels_allowed(history, source) -> None:
    repo, policy, scanner, _, commit, _ = history
    oid = commit()
    result = verify_outgoing(repo, "https://example.invalid/a/b", [
        PushUpdate(oid if source == "oid" else source, oid, "refs/heads/main", ZERO),
    ], scanner=str(scanner), policy_dir=policy)
    assert result.commits_scanned == 1


def test_git_runtime_redirect_variables_scrubbed(history, monkeypatch, tmp_path) -> None:
    oid = history[4]()
    for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_SHALLOW_FILE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"):
        monkeypatch.setenv(name, str(tmp_path / "not-the-repo"))
    history[2].write_text("#!/bin/sh\nenv | grep '^GIT_' | grep -v '^GIT_NO_REPLACE_OBJECTS=' && exit 9\nexit 0\n")
    assert check(history, oid).commits_scanned == 1


def test_non_fast_forward_refused(history) -> None:
    old = history[4](path="old.txt")
    unrelated = history[4](path="new.txt")
    with pytest.raises(OutgoingVerificationError):
        check(history, unrelated, old)


def test_real_scanner_clean_fixture(history) -> None:
    import shutil
    scanner = shutil.which("gitleaks")
    if scanner is None:
        pytest.skip("gitleaks is not installed")
    repo, policy, _, _, commit, _ = history
    result = verify_outgoing(repo, "https://example.invalid/a/b", [
        PushUpdate("refs/heads/main", commit(), "refs/heads/main", ZERO),
    ], policy_dir=policy, scanner=scanner)
    assert result.commits_scanned == 1


@pytest.mark.parametrize("old_branch", [False, True])
@pytest.mark.parametrize("path, body", [
    ("password.pass", b"ordinary\n"),
    ("config.txt", b"-----BEGIN " + b"PRIVATE KEY-----\nfixture\n"),
    ("password.txt", b"aBcDeFgHiJkL123456789\n"),
])
def test_historical_secret_add_then_delete_is_refused(history, old_branch, path, body) -> None:
    commit = history[4]
    old = commit()
    secret = commit(old, path, body)
    clean = commit(secret)
    with pytest.raises(OutgoingVerificationError, match=r"secret-sensitive|sensitive content"):
        check(history, clean, old if old_branch else ZERO)


def test_old_branch_only_scans_outgoing(history) -> None:
    old = history[4]()
    new = history[4](old)
    assert check(history, new, old).commits_scanned == 1


def test_missing_scanner_and_old_history_refused(history) -> None:
    oid = history[4]()
    history[2].unlink()
    with pytest.raises(OutgoingVerificationError, match="scanner"):
        check(history, oid)
    history[2].write_text("#!/bin/sh\nexit 0\n")
    history[2].chmod(0o700)
    with pytest.raises(OutgoingVerificationError, match="unavailable"):
        check(history, oid, "a" * 40)


def test_scanner_failure_is_redacted(history) -> None:
    history[2].write_text("#!/bin/sh\necho 'sensitive-fixture-output' >&2\nexit 2\n")
    with pytest.raises(OutgoingVerificationError) as exc:
        check(history, history[4]())
    assert "sensitive-fixture-output" not in str(exc.value)


def test_multiple_refs_all_checked(history) -> None:
    repo, policy, scanner, _, commit, _ = history
    a, b = commit(), commit(path="secret.secret")
    with pytest.raises(OutgoingVerificationError, match="secret-sensitive"):
        verify_outgoing(repo, "https://example.invalid/a/b", [
            PushUpdate("refs/heads/a", a, "refs/heads/a", ZERO),
            PushUpdate("refs/heads/b", b, "refs/heads/b", ZERO),
        ], scanner=str(scanner), policy_dir=policy)


def test_shallow_history_refused(history) -> None:
    oid = history[4]()
    history[0].joinpath(".git/shallow").write_text(oid + "\n")
    with pytest.raises(OutgoingVerificationError, match="shallow"):
        check(history, oid)


def test_destination_and_tuple_validation(history) -> None:
    repo, policy, scanner, *_ = history
    with pytest.raises(OutgoingVerificationError, match="destination"):
        verify_outgoing(repo, "https://user:password@example.invalid/repo", [], policy_dir=policy, scanner=str(scanner))
    with pytest.raises(OutgoingVerificationError, match="Malformed"):
        parse_updates("one two three")


@pytest.mark.parametrize("adapter", ["tracked", "global"])
def test_pre_push_chains_same_arguments_and_stdin(history, tmp_path, adapter) -> None:
    repo, policy, _, git, commit, _ = history
    oid = commit()
    data = f"refs/heads/main {oid} refs/heads/main {ZERO}\n"
    capture = tmp_path / "capture"
    repo_hook = repo / ".git/hooks/pre-push"
    repo_hook.write_text(f"#!/bin/sh\nprintf '%s\\n' \"$@\" > '{capture}'\ncat >> '{capture}'\n")
    repo_hook.chmod(0o700)
    # The adapter uses the same verifier; supply fixture policy via fixture HOME.
    fixture_home = tmp_path / "home"
    policy_target = fixture_home / ".config/git/secretguard"
    policy_target.mkdir(parents=True)
    for name in ("denylist.txt", "allowlist.txt"):
        policy_target.joinpath(name).write_text(policy.joinpath(name).read_text())
    source = Path(__file__).resolve().parents[1]
    scanner_path = tmp_path / "bin"
    scanner_path.mkdir()
    scanner_path.joinpath("gitleaks").symlink_to(history[2])
    env = dict(os.environ, HOME=str(fixture_home), PATH=f"{scanner_path}:{os.environ['PATH']}:/usr/bin:/bin", BASH_ENV="")
    hook_path = source / "publication-pre-push" if adapter == "tracked" else Path.home() / ".config/git/hooks/pre-push"
    if adapter == "global" and (not hook_path.exists() or "git-outgoing/publication-pre-push" not in hook_path.read_text()):
        pytest.skip("reviewed global adapter is not installed")
    result = subprocess.run(["bash", str(hook_path),
                             "fixture", str(repo)], check=False, cwd=repo, input=data,
                            text=True, capture_output=True, env=env)
    assert result.returncode == 0, result.stderr
    assert capture.read_text() == "fixture\n" + str(repo) + "\n" + data
    repo_hook.write_text("#!/bin/sh\nexit 7\n")
    result = subprocess.run(["bash", str(hook_path), "fixture", str(repo)], check=False, cwd=repo,
                            input=data, text=True, capture_output=True, env=env, timeout=60)
    assert result.returncode == 7
    repo_hook.unlink()
    repo_hook.symlink_to(hook_path)
    git("config", "core.hooksPath", str(hook_path.parent))
    result = subprocess.run(["bash", str(hook_path), "fixture", str(repo)], check=False, cwd=repo,
                            input=data, text=True, capture_output=True, env=env, timeout=60)
    assert result.returncode == 0, result.stderr



def _manifest_scan(history, monkeypatch, key: str, *, line: int = 3, path: str = "extension/manifest.json",
                   report: bool = True, body: bytes | None = None, rule: str = "generic-api-key"):
    import json

    from git_outgoing import outgoing

    body = body or json.dumps({"manifest_version": 3, "key": key}, indent=2).encode()
    oid = history[4](None, path, body)

    def scanner(command, **kwargs):
        if report:
            Path(command[command.index("--report-path") + 1]).write_text(json.dumps([
                {"RuleID": rule, "Commit": oid, "File": path, "StartLine": line},
            ]))
        return subprocess.CompletedProcess(command, 1, "", "")

    monkeypatch.setattr(outgoing.safe_subprocess, "run_inherited", scanner)
    return check(history, oid)


def _der_key(private: bool) -> str:
    import base64

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    key = ec.generate_private_key(ec.SECP256R1())
    der = (key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption()) if private else
           key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo))
    return base64.b64encode(der).decode()


@pytest.mark.parametrize("path", ["extension/manifest.json", "extension/manifest-agents.json"])
def test_extension_manifest_public_key_finding_is_tolerated(history, monkeypatch, path) -> None:
    scan = _manifest_scan(history, monkeypatch, _der_key(private=False), path=path)
    assert scan.commits_scanned == 1


@pytest.mark.parametrize("private, options", [
    (True, {}),
    (False, {"report": False}),
    (False, {"path": "extension/config.json"}),
    (False, {"path": "extension/manifest-agents.json.bak"}),
    (False, {"line": 2}),
])
def test_other_scanner_findings_still_refused(history, monkeypatch, private, options) -> None:
    with pytest.raises(OutgoingVerificationError, match="details redacted"):
        _manifest_scan(history, monkeypatch, _der_key(private), **options)


def test_secret_sharing_the_public_key_line_is_refused(history, monkeypatch) -> None:
    key = _der_key(private=False)
    body = ('{"manifest_version": 3,\n"key": "' + key + '", "api_key": "' + "s3cr3t" * 6 + '"\n}').encode()
    with pytest.raises(OutgoingVerificationError, match="details redacted"):
        _manifest_scan(history, monkeypatch, key, line=2, body=body)


def test_other_rule_on_public_key_line_is_refused(history, monkeypatch) -> None:
    with pytest.raises(OutgoingVerificationError, match="details redacted"):
        _manifest_scan(history, monkeypatch, _der_key(private=False), rule="private-key")


def test_trusted_publication_fingerprint_allows_only_that_finding(history, monkeypatch) -> None:
    from git_outgoing import outgoing

    oid = history[4](path="fixture.py")
    finding = {"Commit": oid, "File": "fixture.py", "RuleID": "generic-api-key", "StartLine": 20}
    fingerprint = f"{oid}:fixture.py:generic-api-key:20"
    history[1].joinpath("publication-fingerprints.txt").write_text(
        f"# Reviewed public model identifier fixture, not a credential.\n{fingerprint}\n"
    )

    def scanner(command, **kwargs):
        Path(command[command.index("--report-path") + 1]).write_text(json.dumps([finding]))
        return subprocess.CompletedProcess(command, 1, "", "")

    monkeypatch.setattr(outgoing.safe_subprocess, "run_inherited", scanner)
    assert check(history, oid).commits_scanned == 1
    finding["StartLine"] = 21
    finding["Secret"] = finding["Match"] = "the-value-itself"
    with pytest.raises(OutgoingVerificationError, match="details redacted") as refused:
        check(history, oid)
    # Where it is, enough to review and clear it; never the value.
    assert refused.value.findings == ({"commit": oid, "file": "fixture.py", "rule": "generic-api-key", "line": 21},)


def test_only_unreviewed_findings_are_named_and_an_unprovable_key_keeps_its_finding(history, monkeypatch) -> None:
    from git_outgoing import outgoing

    oid = history[4](path="fixture.py")
    reviewed = {"Commit": oid, "File": "fixture.py", "RuleID": "generic-api-key", "StartLine": 20}
    other = {**reviewed, "StartLine": 21}
    report = history[1] / "report.json"
    report.write_text(json.dumps([reviewed, other]))
    history[1].joinpath("publication-fingerprints.txt").write_text(f"{oid}:fixture.py:generic-api-key:20\n")
    assert outgoing._unreviewed_findings(history[0], report, history[1] / "publication-fingerprints.txt") == [other]

    # A key type the library can't load raises its own exception, not a ValueError.
    class Unsupported(Exception):
        pass

    monkeypatch.setattr(outgoing, "_git", Mock(side_effect=Unsupported()))
    assert outgoing._public_manifest_key(history[0], {**reviewed, "File": "manifest.json"}) is False


def test_reviewed_list_is_the_checkouts_own_file_and_a_missing_one_is_refused(history, tmp_path) -> None:
    from git_outgoing import outgoing

    # Read by its real path, so a rebuilt host needs no link; policy_dir is only the tests' own copy.
    assert outgoing._FINGERPRINTS.is_file() and outgoing._FINGERPRINTS.parent.name == "git-outgoing"
    report = tmp_path / "report.json"
    report.write_text(json.dumps([{"Commit": "a" * 40, "File": "f.py", "RuleID": "generic-api-key", "StartLine": 1}]))
    dangling = tmp_path / "link.txt"
    dangling.symlink_to(tmp_path / "gone.txt")
    for missing in (tmp_path / "absent.txt", dangling):
        with pytest.raises(OutgoingVerificationError, match="list is missing"):
            outgoing._unreviewed_findings(history[0], report, missing)


def test_publication_fingerprint_policy_has_no_path_or_pattern_allows(history, monkeypatch) -> None:
    from git_outgoing import outgoing

    oid = history[4](path="fixture.py")
    history[1].joinpath("publication-fingerprints.txt").write_text("fixture.py\n*:fixture.py:*:*\n")

    def scanner(command, **kwargs):
        Path(command[command.index("--report-path") + 1]).write_text(json.dumps([
            {"Commit": oid, "File": "fixture.py", "RuleID": "generic-api-key", "StartLine": 20},
        ]))
        return subprocess.CompletedProcess(command, 1, "", "")

    monkeypatch.setattr(outgoing.safe_subprocess, "run_inherited", scanner)
    with pytest.raises(OutgoingVerificationError, match="details redacted"):
        check(history, oid)
