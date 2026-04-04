"""Tests for terminal.api.validators module."""

from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

from terminal.api.validators import (
    require_pane_exists,
    validate_active_mode,
    validate_create_pane_request,
    validate_pane_limit,
    validate_uuid,
)


class TestValidateUuid:
    def test_valid_uuid(self) -> None:
        validate_uuid(str(uuid.uuid4()))  # should not raise

    def test_invalid_uuid(self) -> None:
        with pytest.raises(HTTPException) as exc_info:
            validate_uuid("not-a-uuid")
        assert exc_info.value.status_code == 400
        assert "Invalid UUID" in str(exc_info.value.detail)

    def test_empty_string(self) -> None:
        with pytest.raises(HTTPException) as exc_info:
            validate_uuid("")
        assert exc_info.value.status_code == 400


class TestValidatePaneLimit:
    def test_under_limit(self) -> None:
        validate_pane_limit(3, 6)  # should not raise

    def test_at_limit(self) -> None:
        with pytest.raises(HTTPException) as exc_info:
            validate_pane_limit(6, 6)
        assert exc_info.value.status_code == 400
        assert "Maximum 6 panes" in str(exc_info.value.detail)

    def test_over_limit(self) -> None:
        with pytest.raises(HTTPException) as exc_info:
            validate_pane_limit(7, 6)
        assert exc_info.value.status_code == 400


class TestValidateCreatePaneRequest:
    def test_project_with_project_id(self) -> None:
        validate_create_pane_request("project", "proj-1")  # should not raise

    def test_project_without_project_id(self) -> None:
        with pytest.raises(HTTPException) as exc_info:
            validate_create_pane_request("project", None)
        assert exc_info.value.status_code == 400
        assert "project_id required" in str(exc_info.value.detail)

    def test_adhoc_without_project_id(self) -> None:
        validate_create_pane_request("adhoc", None)  # should not raise

    def test_adhoc_with_project_id(self) -> None:
        with pytest.raises(HTTPException) as exc_info:
            validate_create_pane_request("adhoc", "proj-1")
        assert exc_info.value.status_code == 400
        assert "must be empty" in str(exc_info.value.detail)


class TestValidateActiveMode:
    def test_adhoc_shell_mode(self) -> None:
        validate_active_mode("adhoc", "shell")  # should not raise

    def test_adhoc_non_shell_mode(self) -> None:
        with pytest.raises(HTTPException) as exc_info:
            validate_active_mode("adhoc", "claude")
        assert exc_info.value.status_code == 400
        assert "Ad-hoc panes only support shell" in str(exc_info.value.detail)

    def test_project_available_mode(self) -> None:
        validate_active_mode("project", "claude", {"shell", "claude"})

    def test_project_unavailable_mode(self) -> None:
        with pytest.raises(HTTPException) as exc_info:
            validate_active_mode("project", "codex", {"shell", "claude"})
        assert exc_info.value.status_code == 400
        assert "not available" in str(exc_info.value.detail)

    def test_project_no_available_modes(self) -> None:
        # When available_modes is None, any mode is allowed
        validate_active_mode("project", "anything", None)


class TestRequirePaneExists:
    def test_pane_exists(self) -> None:
        pane = {"id": "abc", "pane_type": "adhoc"}
        result = require_pane_exists(pane, "abc")
        assert result == pane

    def test_pane_not_found(self) -> None:
        with pytest.raises(HTTPException) as exc_info:
            require_pane_exists(None, "missing-id")
        assert exc_info.value.status_code == 404
        assert "missing-id" in str(exc_info.value.detail)
