"""Tests for pane file-browser path safety."""

from __future__ import annotations

import pytest

from a_term.services import file_browser


def test_resolve_safe_path_rejects_absolute_paths(tmp_path) -> None:
    with pytest.raises(PermissionError, match="absolute paths"):
        file_browser.resolve_safe_path(str(tmp_path), "/etc/passwd")


def test_resolve_safe_path_rejects_parent_traversal(tmp_path) -> None:
    with pytest.raises(PermissionError, match=r"\.\."):
        file_browser.resolve_safe_path(str(tmp_path), "../secret.txt")


def test_resolve_safe_path_rejects_forbidden_dirs(tmp_path) -> None:
    with pytest.raises(PermissionError, match=r"\.git"):
        file_browser.resolve_safe_path(str(tmp_path), ".git/config")


def test_resolve_safe_path_allows_child_paths(tmp_path) -> None:
    child = tmp_path / "src" / "README.md"
    child.parent.mkdir()
    child.write_text("hello")

    assert file_browser.resolve_safe_path(str(tmp_path), "src/README.md") == child


@pytest.mark.parametrize(
    "relative",
    [
        ".env",
        ".env.local",
        ".ENV.production",
        "app/.env.local",
        ".envrc",
        ".ssh/id_ed25519",
        ".ssh/config",
        "keys/id_rsa",
        "keys/id_ecdsa.pub",
        "certs/server.pem",
        "certs/SERVER.PEM",
        ".git/config",
    ],
)
def test_secret_paths_are_refused(tmp_path, relative: str) -> None:
    target = tmp_path / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("secret")
    with pytest.raises(PermissionError, match="Access denied"):
        file_browser.read_file(str(tmp_path), relative)


@pytest.mark.parametrize(("link", "secret"), [("notes.txt", ".env.local"), ("keys", ".ssh"), ("cert.txt", "tls/a.pem")])
def test_symlinks_to_secret_paths_are_refused(tmp_path, link: str, secret: str) -> None:
    target = tmp_path / secret
    if secret == ".ssh":
        target.mkdir()
        (target / "id_ed25519").write_text("secret")
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("secret")
    (tmp_path / link).symlink_to(target)
    with pytest.raises(PermissionError, match="Access denied"):
        file_browser.resolve_safe_path(str(tmp_path), link)
    if secret == ".ssh":
        with pytest.raises(PermissionError, match="Access denied"):
            file_browser.read_file(str(tmp_path), "keys/id_ed25519")


def test_symlinks_out_of_the_root_are_refused(tmp_path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    (tmp_path / "outside.txt").write_text("secret")
    (root / "link.txt").symlink_to(tmp_path / "outside.txt")
    with pytest.raises(PermissionError, match="escapes pane root"):
        file_browser.read_file(str(root), "link.txt")


def test_listing_hides_secret_entries_and_keeps_ordinary_files(tmp_path) -> None:
    for name in (".env.local", "server.pem", "id_rsa", "id_utils.py", "README.md", "environment.md"):
        (tmp_path / name).write_text("x")
    names = {entry["name"] for entry in file_browser.list_directory(str(tmp_path))["entries"]}  # type: ignore[union-attr]
    assert names == {"id_utils.py", "README.md", "environment.md"}
    assert file_browser.read_file(str(tmp_path), "id_utils.py")["content"] == "x"


@pytest.mark.parametrize(
    "relative",
    [
        ".config/gh/hosts.yml",
        ".claude/.credentials.json",
        ".codex/auth.json",
        ".aws/credentials",
        ".docker/config.json",
        ".kube/config",
        ".gnupg/private-keys-v1.d/key",
        ".local/share/keyrings/login.keyring",
        ".netrc",
        ".pgpass",
        ".npmrc",
        ".pypirc",
        ".git-credentials",
        ".bash_history",
        "certs/tls.KEY",
        "certs/client.p12",
        "certs/client.pfx",
        "gcloud/credentials.json",
        "svc.credentials.json",
        "app/auth.json",
    ],
)
def test_home_rooted_pane_refuses_credential_files(tmp_path, relative: str) -> None:
    home = tmp_path / "home"
    target = home / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("secret")
    with pytest.raises(PermissionError, match="Access denied"):
        file_browser.read_file(str(home), relative)


@pytest.mark.parametrize("relative", [".config", ".config/gh", ".aws", "src/.cache"])
def test_hidden_directories_cannot_be_listed(tmp_path, relative: str) -> None:
    (tmp_path / relative / "inner").mkdir(parents=True)
    with pytest.raises(PermissionError, match="Access denied"):
        file_browser.list_directory(str(tmp_path), relative)


def test_symlink_into_a_hidden_directory_is_refused(tmp_path) -> None:
    (tmp_path / ".config" / "gh").mkdir(parents=True)
    (tmp_path / ".config" / "gh" / "hosts.yml").write_text("oauth_token: secret")
    (tmp_path / "gh-hosts.yml").symlink_to(tmp_path / ".config" / "gh" / "hosts.yml")
    (tmp_path / "ghdir").symlink_to(tmp_path / ".config" / "gh")
    with pytest.raises(PermissionError, match="Access denied"):
        file_browser.read_file(str(tmp_path), "gh-hosts.yml")
    with pytest.raises(PermissionError, match="Access denied"):
        file_browser.list_directory(str(tmp_path), "ghdir")
    (tmp_path / "src").mkdir()
    (tmp_path / "src-link").symlink_to(tmp_path / "src")
    names = {entry["name"] for entry in file_browser.list_directory(str(tmp_path))["entries"]}  # type: ignore[union-attr]
    assert names == {"src", "src-link"}


def test_project_dotfiles_and_ordinary_sources_stay_readable(tmp_path) -> None:
    for name in (".gitignore", ".prettierrc", "credentials_test.py", "auth.py", "keyboard.ts"):
        (tmp_path / name).write_text("x")
    for name in (".gitignore", ".prettierrc", "credentials_test.py", "auth.py", "keyboard.ts"):
        assert file_browser.read_file(str(tmp_path), name)["content"] == "x"
    assert file_browser.list_directory(str(tmp_path), "")["total"] == 5
