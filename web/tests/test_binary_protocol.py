"""Tests for binary WebSocket protocol (Phase 5)."""

from __future__ import annotations

import json

from a_term.services.binary_protocol import (
    MSG_CONTROL,
    MSG_OUTPUT,
    decode_client_message,
    encode_output,
)


class TestEncodeOutput:
    def test_basic_output(self):
        result = encode_output("hello")
        assert result[0] == MSG_OUTPUT
        assert result[1:] == b"hello"

    def test_unicode_output(self):
        result = encode_output("hello ")
        assert result[0] == MSG_OUTPUT
        assert result[1:].decode("utf-8") == "hello "

    def test_empty_output(self):
        result = encode_output("")
        assert result == bytes([MSG_OUTPUT])

    def test_ansi_sequences(self):
        data = "\x1b[31mred\x1b[0m"
        result = encode_output(data)
        assert result[0] == MSG_OUTPUT
        assert result[1:].decode("utf-8") == data


class TestDecodeClientMessage:
    def test_input_message(self):
        raw = bytes([0x01]) + b"ls -la\n"
        msg_type, payload = decode_client_message(raw)
        assert msg_type == 0x01
        assert payload == b"ls -la\n"

    def test_control_message(self):
        ctrl = json.dumps({"__ctrl": True, "ping": True}).encode("utf-8")
        raw = bytes([MSG_CONTROL]) + ctrl
        msg_type, payload = decode_client_message(raw)
        assert msg_type == MSG_CONTROL
        decoded = json.loads(payload.decode("utf-8"))
        assert decoded["ping"] is True

    def test_empty_message(self):
        msg_type, payload = decode_client_message(b"")
        assert msg_type == 0
        assert payload == b""

    def test_round_trip_output(self):
        """Encode then decode should preserve the payload."""
        original = "test data with \x1b[32mcolor\x1b[0m"
        encoded = encode_output(original)
        msg_type, payload = decode_client_message(encoded)
        assert msg_type == MSG_OUTPUT
        assert payload.decode("utf-8") == original
