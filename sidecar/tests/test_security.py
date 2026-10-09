"""Trust-boundary tests: non-loopback bind refusal and the Origin guard on
state-changing POSTs (the bus is unauthenticated, so these are the controls
that stop a visited website from injecting into the active terminal)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from aico_sidecar.app import MAX_BODY_BYTES, create_app
from aico_sidecar.config import DEFAULT_EXTENSION_ID, Settings

# The sidecar only answers loopback Host headers (DNS-rebinding guard).
LOOPBACK_URL = "http://127.0.0.1:8005"


@pytest.fixture
def client(tmp_path) -> TestClient:
    return TestClient(create_app(Settings(state_dir=tmp_path)), base_url=LOOPBACK_URL)


class TestBindGuard:
    def test_loopback_ip_allowed(self, monkeypatch) -> None:
        monkeypatch.setenv("AICO_SIDECAR_HOST", "127.0.0.1")
        assert Settings.from_env().host == "127.0.0.1"

    def test_localhost_name_allowed(self, monkeypatch) -> None:
        monkeypatch.setenv("AICO_SIDECAR_HOST", "localhost")
        assert Settings.from_env().host == "localhost"

    def test_non_loopback_refused(self, monkeypatch) -> None:
        monkeypatch.setenv("AICO_SIDECAR_HOST", "0.0.0.0")
        monkeypatch.delenv("AICO_SIDECAR_ALLOW_REMOTE", raising=False)
        with pytest.raises(ValueError, match="non-loopback"):
            Settings.from_env()

    def test_non_loopback_allowed_with_optin(self, monkeypatch) -> None:
        monkeypatch.setenv("AICO_SIDECAR_HOST", "0.0.0.0")
        monkeypatch.setenv("AICO_SIDECAR_ALLOW_REMOTE", "1")
        assert Settings.from_env().host == "0.0.0.0"


class TestPortGuard:
    def test_valid_port_parsed(self, monkeypatch) -> None:
        monkeypatch.setenv("AICO_SIDECAR_PORT", "9001")
        assert Settings.from_env().port == 9001

    def test_non_integer_port_refused(self, monkeypatch) -> None:
        monkeypatch.setenv("AICO_SIDECAR_PORT", "notaport")
        with pytest.raises(ValueError, match="must be an integer"):
            Settings.from_env()

    def test_out_of_range_port_refused(self, monkeypatch) -> None:
        monkeypatch.setenv("AICO_SIDECAR_PORT", "70000")
        with pytest.raises(ValueError, match="out of range"):
            Settings.from_env()


class TestOriginGuard:
    DOM = {"kind": "dom", "snippet": "x"}

    def test_no_origin_allowed(self, client: TestClient) -> None:
        # Native clients (Electron main, `st` CLI, curl) send no Origin header.
        assert client.post("/selection", json=self.DOM).status_code == 200

    def test_loopback_origin_allowed(self, client: TestClient) -> None:
        r = client.post("/selection", json=self.DOM, headers={"origin": "http://localhost:3005"})
        assert r.status_code == 200

    def test_extension_origin_allowed(self, client: TestClient) -> None:
        r = client.post(
            "/selection",
            json=self.DOM,
            headers={"origin": f"chrome-extension://{DEFAULT_EXTENSION_ID}"},
        )
        assert r.status_code == 200

    def test_unknown_extension_origin_rejected(self, client: TestClient) -> None:
        # Any other installed extension must not be able to inject.
        r = client.post(
            "/selection", json=self.DOM, headers={"origin": f"chrome-extension://{'a' * 32}"}
        )
        assert r.status_code == 403

    def test_cors_only_echoes_pinned_extension(self, client: TestClient) -> None:
        ok = client.get(
            "/selection/current", headers={"origin": f"chrome-extension://{DEFAULT_EXTENSION_ID}"}
        )
        assert ok.headers.get("access-control-allow-origin") == (
            f"chrome-extension://{DEFAULT_EXTENSION_ID}"
        )
        other = client.get("/selection/current", headers={"origin": f"chrome-extension://{'b' * 32}"})
        assert "access-control-allow-origin" not in other.headers

    def test_configured_extension_ids_replace_default(self, tmp_path) -> None:
        custom = "c" * 32
        app = create_app(Settings(state_dir=tmp_path, extension_ids=frozenset({custom})))
        c = TestClient(app, base_url=LOOPBACK_URL)
        r = c.post("/selection", json=self.DOM, headers={"origin": f"chrome-extension://{custom}"})
        assert r.status_code == 200
        r = c.post(
            "/selection",
            json=self.DOM,
            headers={"origin": f"chrome-extension://{DEFAULT_EXTENSION_ID}"},
        )
        assert r.status_code == 403

    def test_public_origin_rejected_on_push(self, client: TestClient) -> None:
        r = client.post("/selection", json=self.DOM, headers={"origin": "https://evil.com"})
        assert r.status_code == 403

    def test_public_origin_rejected_on_send(self, client: TestClient) -> None:
        r = client.post(
            "/selection/send", json={"items": [self.DOM]}, headers={"origin": "https://evil.com"}
        )
        assert r.status_code == 403

    def test_public_origin_rejected_on_widget_event(self, client: TestClient) -> None:
        r = client.post(
            "/widgets/a1b2c3d4/events", json={"event": "open"}, headers={"origin": "https://evil.com"}
        )
        assert r.status_code == 403

    def test_reads_are_not_origin_blocked(self, client: TestClient) -> None:
        # GETs rely on CORS for cross-origin read protection, not a server-side 403.
        r = client.get("/selection/current", headers={"origin": "https://evil.com"})
        assert r.status_code == 200


class TestExtensionIdConfig:
    def test_default_is_bundled_extension(self, monkeypatch) -> None:
        monkeypatch.delenv("AICO_EXTENSION_IDS", raising=False)
        assert Settings.from_env().extension_ids == frozenset({DEFAULT_EXTENSION_ID})

    def test_env_override_parsed(self, monkeypatch) -> None:
        monkeypatch.setenv("AICO_EXTENSION_IDS", f" {'a' * 32} , {'p' * 32} ")
        assert Settings.from_env().extension_ids == frozenset({"a" * 32, "p" * 32})

    def test_malformed_env_id_refused(self, monkeypatch) -> None:
        monkeypatch.setenv("AICO_EXTENSION_IDS", "not-an-extension-id")
        with pytest.raises(ValueError, match="invalid extension id"):
            Settings.from_env()

    def test_default_id_matches_manifest_key(self) -> None:
        # The pinned ID must be the one Chrome derives from the manifest's public key.
        import base64
        import hashlib
        import json
        from pathlib import Path

        manifest = Path(__file__).resolve().parents[2] / "extension" / "manifest.json"
        der = base64.b64decode(json.loads(manifest.read_text(encoding="utf-8"))["key"])
        digest = hashlib.sha256(der).hexdigest()[:32]
        derived = "".join(chr(ord("a") + int(ch, 16)) for ch in digest)
        assert derived == DEFAULT_EXTENSION_ID


class TestHostGuard:
    @pytest.mark.parametrize(
        "host",
        [
            "127.0.0.1:8005",
            "127.0.0.1",
            "127.0.0.2:8005",
            "localhost:8005",
            "localhost",
            "[::1]:8005",
            "[::1]",
        ],
    )
    def test_loopback_hosts_allowed(self, client: TestClient, host: str) -> None:
        assert client.get("/health", headers={"host": host}).status_code == 200

    @pytest.mark.parametrize(
        "host",
        [
            "evil.example",
            "evil.example:8005",
            "127.0.0.1:9999",
            "localhost.evil.example",
            "[::1",
            "10.0.0.1:8005",
            "127.0.0.1.evil.example",
        ],
    )
    def test_other_hosts_rejected(self, client: TestClient, host: str) -> None:
        # DNS rebinding: an attacker's name resolved to 127.0.0.1 still sends its own Host.
        assert client.get("/selection/history", headers={"host": host}).status_code == 403
        assert client.get("/selection/current", headers={"host": host}).status_code == 403

    def test_rejected_before_writes(self, client: TestClient) -> None:
        r = client.post(
            "/selection", json={"kind": "dom", "snippet": "x"}, headers={"host": "evil.example"}
        )
        assert r.status_code == 403
        assert client.get("/selection/current").json() == {"kind": "empty"}

    def test_websocket_rejected_by_close(self, client: TestClient) -> None:
        # A websocket scope gets a close (refused handshake), not an HTTP response.
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect("/ws", headers={"host": "evil.example"}):
                pass
        assert exc.value.code == 1008

    def test_allow_remote_lifts_host_check(self, tmp_path) -> None:
        app = create_app(Settings(state_dir=tmp_path, allow_remote=True))
        c = TestClient(app, base_url="http://aico-box.lan:8005")
        assert c.get("/health").status_code == 200


class TestBodyLimit:
    def test_oversized_body_rejected(self, client: TestClient) -> None:
        body = b'{"kind":"dom","snippet":"' + b"x" * MAX_BODY_BYTES + b'"}'
        r = client.post("/selection", content=body, headers={"content-type": "application/json"})
        assert r.status_code == 413
        assert client.get("/selection/current").json() == {"kind": "empty"}

    def test_oversized_chunked_body_rejected(self, client: TestClient) -> None:
        def chunks():
            yield b'{"kind":"dom","snippet":"'
            for _ in range(MAX_BODY_BYTES // 65536 + 2):
                yield b"x" * 65536
            yield b'"}'

        r = client.post("/selection", content=chunks(), headers={"content-type": "application/json"})
        assert r.status_code == 413

    def test_413_carries_cors_headers(self, client: TestClient) -> None:
        origin = f"chrome-extension://{DEFAULT_EXTENSION_ID}"
        body = b'{"kind":"dom","snippet":"' + b"x" * MAX_BODY_BYTES + b'"}'
        r = client.post(
            "/selection",
            content=body,
            headers={"content-type": "application/json", "origin": origin},
        )
        assert r.status_code == 413
        assert r.headers.get("access-control-allow-origin") == origin
