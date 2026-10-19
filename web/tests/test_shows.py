"""Agent handoffs cross an untrusted socket payload and filesystem boundary."""

from __future__ import annotations

import os
import subprocess
from collections.abc import Iterator
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from a_term.api import shows as routes
from a_term.services import shows
from a_term.services.tether_events import TetherEventWatcher
from a_term.tether.client import agent_socket_path, owner_socket_path

SHOW_ID = "ab12cd34ef56"
NAME = f"ab12cd34/out/{SHOW_ID}-report.pdf"


def payload(**overrides: object) -> dict[str, object]:
    return {"id": SHOW_ID, "session": "ab12cd34", "kind": "file", "title": "Report", "name": NAME, **overrides}


@pytest.fixture(autouse=True)
def isolated_shows(monkeypatch: pytest.MonkeyPatch) -> Iterator[MagicMock]:
    monkeypatch.setattr(shows, "store", shows.ShowStore())
    with patch.object(shows.subprocess, "run") as run:
        yield run


def remember(**overrides: object) -> shows.Show:
    show = shows.validate_show(payload(**overrides))
    assert show is not None
    assert shows.store.add(show)
    return show


@pytest.mark.parametrize("title", [None, "", "Résumé", "x" * 120])
def test_valid_file_metadata(title: str | None) -> None:
    show = shows.validate_show(payload(title=title))
    assert show is not None
    assert show.metadata() == payload(title=title)


def test_no_session_file_and_url() -> None:
    assert shows.validate_show(payload(session=None, name=f"none/out/{SHOW_ID}-file")) is not None
    url = "https://example.com/report?a=1&b=2"
    show = shows.validate_show(payload(kind="url", name=url, url=url, session=None, title=None))
    assert show is not None and show.url == url


@pytest.mark.parametrize(
    "overrides",
    [
        {"id": "not-hex"}, {"id": ""}, {"id": "a" * 65}, {"id": 12},
        {"kind": "image"}, {"session": "../owner"}, {"session": 123},
        {"title": "x" * 121}, {"title": 123}, {"title": "line\nbreak"},
        {"title": "null\x00"}, {"title": "bidi\u202e"}, {"title": "line\u2028"},
        {"title": "surrogate\ud800"}, {"name": "../owner/secrets"},
        {"name": "/ab12cd34/out/report.pdf"}, {"name": "ab12cd34/out/../../secrets"},
        {"name": "ab12cd34/out/report\n"}, {"name": "ab12cd34/out/hello world"},
        {"name": "ab12cd34/out/" + "x" * 121}, {"name": "ab12cd34/out/.."},
        {"name": "ab12cd34/out/."}, {"name": "none/out/report"},
        {"url": "https://example.com"}, {"name": None},
    ],
)
def test_invalid_metadata_is_rejected(overrides: dict[str, object]) -> None:
    assert shows.validate_show(payload(**overrides)) is None


@pytest.mark.parametrize(
    "url",
    ["javascript:alert(1)", "file:///etc/passwd", "ftp://example.com/a", "https:///", "https://[",
     "https://example.com:bad/", "https://example.com/\n", " https://example.com", "https://example.com/\u202e",
     "https://example.com/" + "x" * 2000],
)
def test_invalid_urls_are_rejected(url: str) -> None:
    assert shows.validate_show(payload(kind="url", name=url, url=url)) is None


def test_only_the_agent_instance_can_deliver_a_show(monkeypatch: pytest.MonkeyPatch, isolated_shows: MagicMock) -> None:
    monkeypatch.setenv("TETHER_AGENT_SOCKET", "/run/tether/test-agent/control.sock")
    monkeypatch.setenv("TETHER_SOCKET", "/tmp/third.sock")
    event = {"type": "show.requested", "data": payload()}
    for socket in (None, str(owner_socket_path()), "/tmp/third.sock", "/tmp/agent/control.sock"):
        TetherEventWatcher(socket).handle(event)
    assert shows.store.recent() == []
    isolated_shows.assert_not_called()

    watcher = TetherEventWatcher(str(agent_socket_path()))
    watcher.handle({"type": "show.requested", "data": payload(name="../escape")})
    watcher.handle({"type": "show.requested", "data": "malformed"})
    assert shows.store.recent() == []
    watcher.handle(event)
    watcher.handle(event)  # reconnect replay is idempotent
    assert len(shows.store.recent()) == 1
    isolated_shows.assert_called_once()


def test_ring_keeps_the_last_50_in_arrival_order_and_resumes_after_id() -> None:
    for index in range(55):
        remember(id=f"{100 - index:012x}")  # IDs are not chronological.
    items = shows.store.recent()
    assert len(items) == 50
    assert items[0].id == f"{95:012x}"
    assert shows.store.recent(items[-2].id) == [items[-1]]
    assert shows.store.recent(items[-1].id) == []
    assert shows.store.recent("expired") == items


def test_push_uses_owner_public_host_and_fixed_argv(monkeypatch: pytest.MonkeyPatch, isolated_shows: MagicMock) -> None:
    monkeypatch.setattr(shows, "PUBLIC_HOST", "terminal.example.test")
    shows.receive_show(payload(title="$(never execute); <title>"))
    isolated_shows.assert_called_once_with(
        ["nightshift", "push", "--title", "Agent shared something", "--severity", "info", "--key", f"show:{SHOW_ID}",
         "--open", f"https://terminal.example.test/?show={SHOW_ID}"],
        timeout=10, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def test_push_without_public_host_omits_open(monkeypatch: pytest.MonkeyPatch, isolated_shows: MagicMock) -> None:
    monkeypatch.setattr(shows, "PUBLIC_HOST", None)
    url = "https://untrusted.example/a?b=1"
    shows.receive_show(payload(kind="url", name=url, url=url))
    argv = isolated_shows.call_args.args[0]
    assert argv == ["nightshift", "push", "--title", "Agent shared something", "--severity", "info", "--key", f"show:{SHOW_ID}"]
    assert url not in argv


@pytest.mark.parametrize("error", [FileNotFoundError("nightshift"), subprocess.TimeoutExpired("nightshift", 10), subprocess.CalledProcessError(1, "nightshift")])
def test_push_failure_is_logged_and_retains_show(error: Exception, isolated_shows: MagicMock) -> None:
    isolated_shows.side_effect = error
    with patch.object(shows.logger, "warning") as log:
        shows.receive_show(payload())
    assert shows.store.get(SHOW_ID) is not None
    log.assert_called_once()


def test_metadata_route_returns_no_contents_and_accepts_cursor(test_app: TestClient) -> None:
    first = remember()
    second = remember(id="bbbbbbbbbbbb", title=None)
    response = test_app.get("/api/a-term/shows")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"shows": [first.metadata(), second.metadata()]}
    assert test_app.get(f"/api/a-term/shows?since={first.id}").json() == {"shows": [second.metadata()]}
    assert test_app.get(f"/api/a-term/shows?since={second.id}").json() == {"shows": []}


@pytest.fixture
def shared_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("TETHER_EXCHANGE_ROOT", str(tmp_path))
    path = tmp_path / "agent" / NAME
    path.parent.mkdir(parents=True)
    path.write_bytes(b"private report contents")
    remember()
    return path


def test_file_route_download_headers(test_app: TestClient, shared_file: Path) -> None:
    response = test_app.get(f"/api/a-term/shows/{SHOW_ID}/file")
    assert response.status_code == 200
    assert response.content == shared_file.read_bytes()
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-disposition"] == f'attachment; filename="{shared_file.name}"'


@pytest.mark.parametrize(
    ("content", "mime"),
    [(b"\x89PNG\r\n\x1a\nrest", "image/png"), (b"\xff\xd8\xffrest", "image/jpeg"),
     (b"GIF87arest", "image/gif"), (b"GIF89arest", "image/gif"), (b"RIFFabcdWEBPrest", "image/webp")],
)
def test_images_are_inline_by_magic_even_with_pdf_extension(test_app: TestClient, shared_file: Path, content: bytes, mime: str) -> None:
    shared_file.write_bytes(content)
    response = test_app.get(f"/api/a-term/shows/{SHOW_ID}/file")
    assert response.content == content
    assert response.headers["content-type"] == mime
    assert response.headers["content-disposition"].startswith("inline;")
    assert response.headers["x-content-type-options"] == "nosniff"


@pytest.mark.parametrize("content", [b"<svg onload='alert(1)'>", b"<html>active</html>", b"RIFFabcdWAVE", b"not a PNG"])
def test_active_and_unknown_contents_are_attachments(test_app: TestClient, shared_file: Path, content: bytes) -> None:
    shared_file.write_bytes(content)
    response = test_app.get(f"/api/a-term/shows/{SHOW_ID}/file")
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["content-disposition"].startswith("attachment;")


def test_missing_and_url_shares_have_no_file(test_app: TestClient) -> None:
    assert test_app.get(f"/api/a-term/shows/{SHOW_ID}/file").status_code == 404
    remember(kind="url", name="https://example.com", url="https://example.com")
    assert test_app.get(f"/api/a-term/shows/{SHOW_ID}/file").status_code == 404


@pytest.mark.parametrize("replacement", ["missing", "symlink", "directory", "fifo", "large"])
def test_unsafe_or_missing_files_are_refused(test_app: TestClient, shared_file: Path, replacement: str) -> None:
    shared_file.unlink()
    if replacement == "symlink":
        shared_file.symlink_to("/etc/passwd")
    elif replacement == "directory":
        shared_file.mkdir()
    elif replacement == "fifo":
        os.mkfifo(shared_file)
    elif replacement == "large":
        with shared_file.open("wb") as stream:
            stream.truncate(routes.MAX_SHOW_BYTES + 1)
    response = test_app.get(f"/api/a-term/shows/{SHOW_ID}/file")
    assert response.status_code == (413 if replacement == "large" else 404)


@pytest.mark.parametrize("level", [0, 1, 2, 3])
def test_symlinked_parent_directories_are_refused(test_app: TestClient, shared_file: Path, level: int) -> None:
    parent = shared_file.parents[level]
    moved = parent.with_name(parent.name + "-moved")
    parent.rename(moved)
    parent.symlink_to(moved, target_is_directory=True)
    assert test_app.get(f"/api/a-term/shows/{SHOW_ID}/file").status_code == 404


def test_open_descriptor_cannot_be_redirected_by_path_swap(test_app: TestClient, shared_file: Path) -> None:
    original = shared_file.read_bytes()

    def replace_path(_header: bytes) -> None:
        shared_file.unlink()
        shared_file.symlink_to("/etc/passwd")

    with patch.object(routes, "_image_type", side_effect=replace_path):
        response = test_app.get(f"/api/a-term/shows/{SHOW_ID}/file")
    assert response.content == original


def test_stream_size_stays_bounded_if_agent_appends_after_check(test_app: TestClient, shared_file: Path) -> None:
    original = shared_file.read_bytes()

    def append_data(_header: bytes) -> None:
        with shared_file.open("ab") as stream:
            stream.write(b"extra bytes")

    with patch.object(routes, "_image_type", side_effect=append_data):
        response = test_app.get(f"/api/a-term/shows/{SHOW_ID}/file")
    assert response.content == original


def test_both_routes_require_existing_browser_auth(test_app: TestClient, auth_settings, shared_file: Path) -> None:
    auth_settings()
    urls = ["/api/a-term/shows", f"/api/a-term/shows/{SHOW_ID}/file"]
    for url in urls:
        assert test_app.get(url).status_code == 401
    assert test_app.post("/api/auth/login", json={"password": "correct horse battery staple"}).status_code == 200
    for url in urls:
        assert test_app.get(url).status_code == 200
