"""Binary WebSocket protocol framing.

All messages use a single-byte type prefix followed by payload.
Inspired by ttyd's binary protocol — less overhead, enables compression.

Server -> Client:
    0x01  OUTPUT   Raw terminal output bytes (UTF-8)
    0x02  CONTROL  JSON control message

Client -> Server:
    0x01  INPUT    Raw terminal input bytes (UTF-8)
    0x02  CONTROL  JSON control message
"""

from __future__ import annotations

import json
from typing import Any

MSG_OUTPUT = 0x01
MSG_CONTROL = 0x02
MSG_INPUT = 0x01  # client→server input (same value, different direction)


def encode_output(data: str) -> bytes:
    """Encode terminal output as a binary frame."""
    return bytes([MSG_OUTPUT]) + data.encode("utf-8")


def encode_control(payload: dict[str, Any]) -> bytes:
    """Encode a control message as a binary frame."""
    return bytes([MSG_CONTROL]) + json.dumps(payload).encode("utf-8")


def decode_client_message(data: bytes) -> tuple[int, bytes]:
    """Decode a binary client message into (type, payload)."""
    if len(data) < 1:
        return 0, b""
    return data[0], data[1:]
