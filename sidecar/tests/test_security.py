"""Trust-boundary tests: non-loopback bind refusal and the Origin guard on
state-changing POSTs (the bus is unauthenticated, so these are the controls
that stop a visited website from injecting into the active terminal)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from aico_sidecar.app import create_app
from aico_sidecar.config import Settings


@pytest.fixture
def client(tmp_path) -> TestClient:
    return TestClient(create_app(Settings(state_dir=tmp_path)))


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
            "/selection", json=self.DOM, headers={"origin": "chrome-extension://abcdef123456"}
        )
        assert r.status_code == 200

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
