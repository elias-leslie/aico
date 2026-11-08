"""The root conftest's guard: no test deletes outside a temp folder."""

import os
import shutil

import pytest


def test_a_delete_outside_temp_is_refused_before_it_happens(tmp_path):
    for call in (
        lambda: os.remove("/srv/scratch/not-a-real-entry"),
        lambda: shutil.rmtree("/srv/scratch/not-a-real-entry", ignore_errors=True),
    ):
        with pytest.raises(PermissionError, match="outside a temp folder"):
            call()
    (tmp_path / "mine").write_text("x")
    os.remove(tmp_path / "mine")
