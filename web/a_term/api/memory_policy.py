"""Memory policy API: A-Term's settings view of Tether's agent-pane memory policy.

Tether owns the policy (the pane memory cap and when and which runaway agent
tool job is killed when the workstation runs out of memory); this only passes
the owner's edits through. Field names are Tether's (camelCase).
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

from ..services.tether_errors import to_http_error
from ..tether import TetherError, TetherUnavailable, get_client

router = APIRouter(tags=["Memory Policy"])


class MemoryPolicyUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    paneMemoryMaxGib: int | None = None  # Tether's field names
    paneSwapMaxGib: int | None = None
    killEnabled: bool | None = None
    killAfterSeconds: int | None = None
    killGapSeconds: int | None = None
    killMinGib: float | None = None
    killOrder: Literal["largest", "background-first"] | None = None


@router.get("/api/a-term/memory-policy")
def get_memory_policy() -> dict[str, Any]:
    try:
        return get_client().get_memory_policy()
    except (TetherError, TetherUnavailable) as error:
        raise to_http_error(error, not_found="This Tether does not have memory settings yet") from None


@router.put("/api/a-term/memory-policy")
def update_memory_policy(body: MemoryPolicyUpdate) -> dict[str, Any]:
    fields = body.model_dump(exclude_none=True)
    try:
        return get_client().update_memory_policy(fields)
    except TetherError as error:
        if error.code == "invalid_body" and isinstance(error.body, dict) and error.body.get("detail"):
            raise HTTPException(status_code=400, detail=f"{error.body.get('field')} {error.body['detail']}") from None
        raise to_http_error(error, not_found="This Tether does not have memory settings yet") from None
    except TetherUnavailable as error:
        raise to_http_error(error) from None
