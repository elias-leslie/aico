"""Shared fixtures: no test reads the host's Tether or A-Term checkout."""

import pytest

from test_aico_admin import admin

REAL_A_TERM_IDENTITY_URL = admin.a_term_identity_url


@pytest.fixture(autouse=True)
def a_term_identity(monkeypatch):
    """A-Term's identity says port 8002 unless a test exercises the real lookup."""
    monkeypatch.setattr(admin, "a_term_identity_url", lambda: "http://127.0.0.1:8002")
