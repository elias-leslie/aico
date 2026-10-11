"""The owner's shared view-mutation vectors also bind the Python client."""

import json
from pathlib import Path

import pytest

from test_aico_admin import admin

VECTORS = json.loads((Path(__file__).resolve().parents[2] / "contracts/view-mutation-vectors.json").read_text())


def test_vector_version():
    assert VECTORS["version"] == 1


@pytest.mark.parametrize("vector", VECTORS["labels"], ids=lambda vector: json.dumps(vector["input"]))
def test_label_vectors(vector):
    assert admin.view_label(vector["input"]) == vector["label"]


@pytest.mark.parametrize("vector", VECTORS["bounds"], ids=lambda vector: json.dumps(vector["input"]))
def test_bounds_vectors(vector):
    assert (admin.view_bounds(vector["input"]) is not None) == vector["valid"]
