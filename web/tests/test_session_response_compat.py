"""Session responses only ever grow: guards against wire and builder drift.

- The OpenAPI schema of every session, pane, reset and start-agent path keeps
  every property and base type it had in ``fixtures/openapi_session_baseline.json``.
- Each builder still writes every key and value it wrote in
  ``fixtures/session_builders_baseline.json``, in process and on the wire.
- The in-process ``Session`` keys and the response model's fields are one set.

Both fixtures were captured before the capability flags landed.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from a_term.api.models.pane_responses import PaneResponse, SessionInPaneResponse
from a_term.api.models.session_responses import ATermSessionResponse
from a_term.services import session_catalog
from a_term.services.session_catalog import Session

FIXTURES = Path(__file__).parent / "fixtures"
OPENAPI_BASELINE = json.loads((FIXTURES / "openapi_session_baseline.json").read_text())
BUILDERS_BASELINE = json.loads((FIXTURES / "session_builders_baseline.json").read_text())["cases"]

FLAGS = {"can_rename", "can_respawn", "can_end"}
# Keys the in-process session dict dropped: no reader, or now computed by the response.
DROPPED_IN_PROCESS = {"available", "root_request_id", "claude_state"}


# ---------------------------------------------------------------------------
# OpenAPI: additive only
# ---------------------------------------------------------------------------
def _current_openapi() -> dict[str, Any]:
    from a_term.main import app  # building the schema starts no workers

    return app.openapi()


def _resolve(schema: dict[str, Any], components: dict[str, Any]) -> dict[str, Any]:
    while "$ref" in schema:
        schema = components[schema["$ref"].rsplit("/", 1)[-1]]
    return schema


def _variants(schema: dict[str, Any], components: dict[str, Any]) -> list[dict[str, Any]]:
    schema = _resolve(schema, components)
    members = schema.get("anyOf") or schema.get("oneOf")
    if members:
        return [variant for member in members for variant in _variants(member, components)]
    return [schema]


def _base_types(schema: dict[str, Any], components: dict[str, Any]) -> set[str]:
    return {str(variant.get("type", "any")) for variant in _variants(schema, components)}


def _assert_compatible(
    where: str, old: dict[str, Any], new: dict[str, Any], old_c: dict[str, Any], new_c: dict[str, Any]
) -> None:
    """``new`` keeps every property and base type of ``old``; only nullable -> non-null narrowing is allowed."""
    old_types, new_types = _base_types(old, old_c), _base_types(new, new_c)
    assert new_types - {"null"} == old_types - {"null"}, f"{where}: type {sorted(old_types)} -> {sorted(new_types)}"
    assert new_types <= old_types, f"{where}: became nullable"
    old_variants = [v for v in _variants(old, old_c) if v.get("type") != "null"]
    new_variants = [v for v in _variants(new, new_c) if v.get("type") != "null"]
    for old_v in old_variants:
        new_v = next((v for v in new_variants if v.get("type", "any") == old_v.get("type", "any")), None)
        assert new_v is not None, f"{where}: variant {old_v.get('type')} removed"
        for name, old_prop in (old_v.get("properties") or {}).items():
            new_props = new_v.get("properties") or {}
            assert name in new_props, f"{where}.{name}: property removed"
            _assert_compatible(f"{where}.{name}", old_prop, new_props[name], old_c, new_c)
        if "items" in old_v:
            _assert_compatible(f"{where}[]", old_v["items"], new_v.get("items", {}), old_c, new_c)
        if isinstance(old_v.get("additionalProperties"), dict):
            _assert_compatible(
                f"{where}{{}}", old_v["additionalProperties"], new_v.get("additionalProperties", {}), old_c, new_c
            )


def test_session_openapi_is_additive_only() -> None:
    current = _current_openapi()
    old_c = OPENAPI_BASELINE["components"]["schemas"]
    new_c = current["components"]["schemas"]
    checked = 0
    for path, item in OPENAPI_BASELINE["paths"].items():
        assert path in current["paths"], f"{path}: path removed"
        for method, operation in item.items():
            assert method in current["paths"][path], f"{method.upper()} {path}: operation removed"
            new_operation = current["paths"][path][method]
            for status, response in operation.get("responses", {}).items():
                assert status in new_operation["responses"], f"{method.upper()} {path} {status}: response removed"
                old_schema = response.get("content", {}).get("application/json", {}).get("schema")
                if old_schema is None:
                    continue
                new_schema = new_operation["responses"][status]["content"]["application/json"]["schema"]
                _assert_compatible(f"{method.upper()} {path} {status}", old_schema, new_schema, old_c, new_c)
                checked += 1
    assert checked >= 20  # the guard really walked the session, pane, reset and start-agent responses


def test_additive_check_catches_a_removed_or_retyped_property() -> None:
    old = {"type": "object", "properties": {"a": {"type": "string"}, "b": {"anyOf": [{"type": "string"}, {"type": "null"}]}}}
    with pytest.raises(AssertionError, match="property removed"):
        _assert_compatible("x", old, {"type": "object", "properties": {"b": {"type": "string"}}}, {}, {})
    with pytest.raises(AssertionError, match="type"):
        _assert_compatible("x", old, {"type": "object", "properties": {"a": {"type": "integer"}, "b": {"type": "string"}}}, {}, {})
    with pytest.raises(AssertionError, match="nullable"):
        widened = {"type": "object", "properties": {"a": {"anyOf": [{"type": "string"}, {"type": "null"}]}, "b": {"type": "string"}}}
        _assert_compatible("x", old, widened, {}, {})
    # Narrowing nullable -> non-null and adding properties are fine.
    _assert_compatible("x", old, {"type": "object", "properties": {"a": {"type": "string"}, "b": {"type": "string"}, "c": {"type": "boolean"}}}, {}, {})


# ---------------------------------------------------------------------------
# Builders: per-kind key sets and values
# ---------------------------------------------------------------------------
def _rebuild(name: str, inputs: dict[str, Any]) -> Session:
    if name.startswith("tether"):
        return session_catalog.from_tether(inputs["descriptor"], inputs["link"])
    if name.startswith("legacy"):
        with patch("a_term.services.session_catalog.pane_store.get_pane", return_value=inputs["pane"]):
            return session_catalog.from_legacy(inputs["uuid"], inputs["row"], inputs["link"])
    with (
        patch("a_term.utils.tmux.run_tmux_command", return_value=(True, inputs["list_panes"])),
        patch("a_term.utils.tmux.external._infer_project_id", return_value=inputs["project_id"]),
    ):
        session = session_catalog.get_session(inputs["list_panes"].split("\t", 1)[0])
    assert session is not None
    return session


@pytest.mark.parametrize("name", sorted(BUILDERS_BASELINE))
def test_builders_keep_every_key_and_value(name: str) -> None:
    case = BUILDERS_BASELINE[name]
    session = dict(_rebuild(name, case["inputs"]))
    old = {key: value for key, value in case["session"].items() if key not in DROPPED_IN_PROCESS}
    assert {key: session.get(key, "<missing>") for key in old} == old
    assert set(session) == set(Session.__annotations__)
    assert DROPPED_IN_PROCESS.isdisjoint(session)


@pytest.mark.parametrize("name", sorted(BUILDERS_BASELINE))
def test_wire_only_gains_capability_flags(name: str) -> None:
    case = BUILDERS_BASELINE[name]
    session = _rebuild(name, case["inputs"])
    wire = ATermSessionResponse.model_validate(session).model_dump(mode="json")
    assert set(wire) - set(case["wire"]) == FLAGS
    assert {key: wire[key] for key in case["wire"]} == case["wire"]
    assert wire["claude_state"] == wire["agent_state"]


@pytest.mark.parametrize("name", sorted(BUILDERS_BASELINE))
def test_pane_sessions_only_gain_fields(name: str) -> None:
    case = BUILDERS_BASELINE[name]
    session = _rebuild(name, case["inputs"])
    wire = SessionInPaneResponse.model_validate(session).model_dump(mode="json")
    assert {key: wire[key] for key in case["pane_wire"]} == case["pane_wire"]
    assert set(wire) == set(ATermSessionResponse.model_fields) | {"claude_state"}
    assert wire["claude_state"] == wire["agent_state"]


def test_own_tmux_and_legacy_pins() -> None:
    own = _rebuild("own_tmux", BUILDERS_BASELINE["own_tmux"]["inputs"])
    assert (own["session_number"], own["display_order"], own["tmux_source"], own["tmux_source_label"]) == (
        0, 0, "default", "tmux")
    legacy = _rebuild("legacy_unlinked", BUILDERS_BASELINE["legacy_unlinked"]["inputs"])
    assert (legacy["tmux_source"], legacy["tmux_source_label"], legacy["origin"]) == ("legacy", "A-Term (legacy)", "a-term")


# ---------------------------------------------------------------------------
# One Session shape
# ---------------------------------------------------------------------------
def test_session_keys_are_the_response_fields() -> None:
    assert set(Session.__annotations__) == set(ATermSessionResponse.model_fields)
    assert set(ATermSessionResponse.model_computed_fields) == {"claude_state"}
    assert Session.__required_keys__ == frozenset(Session.__annotations__)  # total: no optional key
    assert all(field.is_required() for field in ATermSessionResponse.model_fields.values())


def test_pane_sessions_use_the_one_session_model() -> None:
    assert SessionInPaneResponse is ATermSessionResponse
    assert PaneResponse.model_fields["sessions"].annotation == list[ATermSessionResponse]


def test_a_partial_session_is_refused_by_the_response() -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        ATermSessionResponse.model_validate({"id": "x", "name": "x", "mode": "shell"})
