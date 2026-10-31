"""`st aico layout` is retired: Aico has no desktop windows to lay out."""

import pytest
from aico_cli_fixtures import admin


@pytest.mark.parametrize("args", [[], ["--help"], ["extra"]])
def test_layout_is_retired_and_contacts_nothing(monkeypatch, capsys, args):
    monkeypatch.setenv("AICO_LAYOUT_FILE", "/nonexistent/layout.json")
    monkeypatch.setattr(admin.Collector, "receipt", lambda *_a, **_k: pytest.fail("Tether contacted"))
    assert admin.main(["layout", *args]) == 2
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.strip() == (
        "Aico has no desktop windows any more; sessions show in Aico web. Nothing to arrange or show."
    )
