"""Retained ES256 assertion verifier. Enrollment stays intact; no web enrollment page."""
from __future__ import annotations

import base64
import hashlib
import json
import struct

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

FLAG_UP, FLAG_UV, FLAG_AT = 0x01, 0x04, 0x40
MAX_CBOR_DEPTH = 8


class WebAuthnError(ValueError):
    pass


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64url(text: str) -> bytes:
    if not isinstance(text, str) or len(text) > 8192:
        raise WebAuthnError("bad base64url field")
    try:
        return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except ValueError as e:
        raise WebAuthnError("bad base64url field") from e


def _client_data(raw: bytes, kind: str, challenge: bytes, origin: str) -> None:
    try:
        cd = json.loads(raw)
    except ValueError as e:
        raise WebAuthnError("clientDataJSON is not JSON") from e
    if not isinstance(cd, dict) or cd.get("type") != kind:
        raise WebAuthnError(f"clientData type is not {kind}")
    if cd.get("challenge") != b64url(challenge):
        raise WebAuthnError("challenge mismatch")
    if cd.get("origin") != origin:
        raise WebAuthnError("origin mismatch")
    if cd.get("crossOrigin") not in (None, False):
        raise WebAuthnError("cross-origin")


def _auth_data(ad: bytes, rp_id: str) -> tuple[int, int]:
    if len(ad) < 37:
        raise WebAuthnError("authenticatorData too short")
    if ad[:32] != hashlib.sha256(rp_id.encode()).digest():
        raise WebAuthnError("rpIdHash mismatch")
    flags = ad[32]
    if not flags & FLAG_UP or not flags & FLAG_UV:
        raise WebAuthnError("user presence and verification are required")
    return flags, struct.unpack(">I", ad[33:37])[0]


def verify(cred: dict, auth_data: bytes, client_data: bytes, signature: bytes, challenge: bytes, origin: str,
           rp_id: str) -> int:
    """One assertion against the enrolled credential; returns the new sign count. Raises WebAuthnError."""
    _client_data(client_data, "webauthn.get", challenge, origin)
    _, count = _auth_data(auth_data, rp_id)
    stored = int(cred.get("sign_count") or 0)
    if not (count == 0 and stored == 0) and count <= stored:
        raise WebAuthnError("signCount did not increase (cloned authenticator?)")
    pk = cred["public_key"]
    key = ec.EllipticCurvePublicNumbers(int.from_bytes(unb64url(pk["x"]), "big"), int.from_bytes(unb64url(pk["y"]), "big"),
                                        ec.SECP256R1()).public_key()
    try:
        key.verify(signature, auth_data + hashlib.sha256(client_data).digest(), ec.ECDSA(hashes.SHA256()))
    except InvalidSignature as e:
        raise WebAuthnError("bad signature") from e
    return count
