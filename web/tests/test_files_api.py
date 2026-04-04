"""Tests for terminal file upload API endpoint."""

from __future__ import annotations

import io

from fastapi.testclient import TestClient


def _upload(client: TestClient, content: bytes, filename: str, content_type: str):
    """Helper to POST a file upload."""
    return client.post(
        "/api/terminal/files",
        files={"file": (filename, io.BytesIO(content), content_type)},
    )


# ---------------------------------------------------------------------------
# MIME detection helper
# ---------------------------------------------------------------------------


def test_detect_mime_png() -> None:
    from terminal.api.files import _detect_mime_type

    png_header = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
    assert _detect_mime_type(png_header, "image/png") == "image/png"


def test_detect_mime_jpeg() -> None:
    from terminal.api.files import _detect_mime_type

    jpeg_header = b"\xff\xd8\xff\xe0" + b"\x00" * 32
    assert _detect_mime_type(jpeg_header, "image/jpeg") == "image/jpeg"


def test_detect_mime_text_trusted() -> None:
    from terminal.api.files import _detect_mime_type

    assert _detect_mime_type(b"hello world", "text/plain") == "text/plain"
    assert _detect_mime_type(b"# Heading", "text/markdown") == "text/markdown"
    assert _detect_mime_type(b'{"a":1}', "application/json") == "application/json"


def test_detect_mime_unknown_binary() -> None:
    from terminal.api.files import _detect_mime_type

    assert _detect_mime_type(b"\x00\x01\x02\x03", "image/png") is None


# ---------------------------------------------------------------------------
# Upload endpoint
# ---------------------------------------------------------------------------


def test_upload_text_file(test_app: TestClient) -> None:
    response = _upload(test_app, b"hello world", "note.txt", "text/plain")
    assert response.status_code == 200
    data = response.json()
    assert data["filename"].endswith(".txt")
    assert data["size"] == 11
    assert data["mime_type"] == "text/plain"
    assert "~/" in data["path"]


def test_upload_json_file(test_app: TestClient) -> None:
    response = _upload(test_app, b'{"key": "value"}', "data.json", "application/json")
    assert response.status_code == 200
    assert response.json()["mime_type"] == "application/json"


def test_upload_png_file(test_app: TestClient) -> None:
    # Minimal valid PNG header bytes
    png_content = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
    response = _upload(test_app, png_content, "image.png", "image/png")
    assert response.status_code == 200
    assert response.json()["mime_type"] == "image/png"


def test_upload_disallowed_mime_type(test_app: TestClient) -> None:
    response = _upload(test_app, b"binary data", "file.exe", "application/octet-stream")
    assert response.status_code == 400
    assert "not allowed" in response.json()["detail"]


def test_upload_empty_file(test_app: TestClient) -> None:
    response = _upload(test_app, b"", "empty.txt", "text/plain")
    assert response.status_code == 400
    assert "Empty file" in response.json()["detail"]


def test_upload_mismatched_mime(test_app: TestClient) -> None:
    # Claim image/png but send non-PNG content
    response = _upload(test_app, b"not a png file at all", "fake.png", "image/png")
    assert response.status_code == 400
    assert "does not match" in response.json()["detail"]
