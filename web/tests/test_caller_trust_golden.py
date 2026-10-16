"""Who gets in, pinned: every route shape x Host x Origin x auth x peer x internal token answers as recorded.

The recorded answers (status, exact refusal body, Access-Control-Allow-Origin, security headers, WebSocket close code
and reason) are literal. They are never recomputed from the trust rules; see ``caller_trust_cells``.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from .caller_trust_cells import MODES, cells, load_golden, run_all


def test_every_cell_has_a_recorded_answer() -> None:
    ids = [cell.id for cell in cells()]
    assert len(ids) == len(set(ids))
    assert sorted(ids) == sorted(load_golden())


@pytest.mark.parametrize("mode", MODES)
def test_answers_match_the_recorded_table(test_app: TestClient, mode: str) -> None:
    app = test_app.app
    assert isinstance(app, FastAPI)
    golden = load_golden()
    got = run_all(app, mode)
    changed: dict[str, dict[str, Any]] = {
        cell_id: {"recorded": golden[cell_id], "now": result}
        for cell_id, result in got.items()
        if golden.get(cell_id) != result
    }
    assert not changed, f"{len(changed)} cells changed: " + "\n".join(
        f"{cell_id}: {diff}" for cell_id, diff in sorted(changed.items())
    )
