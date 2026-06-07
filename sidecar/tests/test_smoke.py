"""Smoke test proving the Python toolchain (pytest) runs under `st check`."""


def test_toolchain_runs() -> None:
    assert 1 + 1 == 2
