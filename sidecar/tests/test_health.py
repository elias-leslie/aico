"""/health liveness check."""

from fastapi.testclient import TestClient

from aico_sidecar import __version__
from aico_sidecar.app import create_app
from aico_sidecar.config import Settings


def test_health_returns_ok(tmp_path) -> None:
    client = TestClient(create_app(Settings(state_dir=tmp_path)))
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "service": "aico-sidecar", "version": __version__}
