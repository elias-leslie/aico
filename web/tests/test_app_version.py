from importlib.metadata import version

from a_term.main import app


def test_fastapi_version_uses_package_metadata() -> None:
    assert app.version == version("a-term")
