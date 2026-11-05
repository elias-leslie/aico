"""Standalone-owner identities from process values or the approved local identity source."""

from __future__ import annotations

import json
import os
from pathlib import Path

import typer

from .output import output_error


def _identity() -> dict[str, str]:
    policy = json.loads(Path(__file__).with_name('credentials-policy.json').read_text())
    try:
        lines = (Path.home() / policy['legacyIdentityFile']).read_text().splitlines()
    except OSError:
        return {}
    values = {}
    for raw in lines:
        line = raw.strip().removeprefix('export ')
        key, separator, value = line.partition('=')
        if separator and key.strip() in policy['identityKeys']:
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def load_credentials(default_source: str = "st-cli") -> tuple[str, str]:
    """Preserve standalone owners' existing local identity source without exposing values."""
    client_id = os.getenv('AICO_CLIENT_ID') or os.getenv('SUMMITFLOW_CLIENT_ID') or os.getenv('CONSULT_CLIENT_ID')
    source = os.getenv('AICO_REQUEST_SOURCE') or os.getenv('SUMMITFLOW_REQUEST_SOURCE')
    values = _identity() if not client_id else {}
    client_id = client_id or values.get('AICO_CLIENT_ID') or values.get('SUMMITFLOW_CLIENT_ID') or values.get('CONSULT_CLIENT_ID')
    if not client_id:
        output_error('No standalone client identity is configured')
        raise typer.Exit(1)
    return client_id, source or values.get('AICO_REQUEST_SOURCE') or values.get('SUMMITFLOW_REQUEST_SOURCE') or default_source


def load_internal_service_secret() -> str:
    """Use the same approved standalone service identity, never a retired SF owner token."""
    secret = os.getenv('INTERNAL_SERVICE_SECRET', '').strip() or _identity().get('INTERNAL_SERVICE_SECRET', '').strip()
    if not secret:
        output_error('No standalone service identity is configured')
        raise typer.Exit(1)
    return secret
