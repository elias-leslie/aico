"""FCM HTTP v1 and RFC 8291, ported from Nightshift. No Web Push delivery route."""
from __future__ import annotations

import base64
import json
import secrets
import struct
import urllib.error
import urllib.parse
import urllib.request

FCM_URL = "https://fcm.googleapis.com/v1/projects/{project}/messages:send"
OAUTH_URI = "https://oauth2.googleapis.com/token"
FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
TTL = {"critical": 86400, "warning": 43200, "info": 43200, "ok": 3600}

def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

def unb64u(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))

def encrypt(p256dh: str, auth: str, plaintext: bytes, salt: bytes | None = None) -> bytes:
    """RFC 8291 message encryption, one aes128gcm record (RFC 8188) with an ephemeral sender key."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    ua_raw = unb64u(p256dh)
    ua_pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_raw)
    as_key = ec.generate_private_key(ec.SECP256R1())
    as_raw = as_key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    secret = as_key.exchange(ec.ECDH(), ua_pub)

    def hkdf(salt_: bytes, ikm: bytes, info: bytes, n: int) -> bytes:
        return HKDF(algorithm=hashes.SHA256(), length=n, salt=salt_, info=info).derive(ikm)

    ikm = hkdf(unb64u(auth), secret, b"WebPush: info\x00" + ua_raw + as_raw, 32)
    salt = salt or secrets.token_bytes(16)
    cek = hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    body = AESGCM(cek).encrypt(nonce, plaintext + b"\x02", None)  # 0x02: last (only) record
    return salt + struct.pack("!IB", 4096, len(as_raw)) + as_raw + body

def mint(sa: dict, now: float) -> tuple[str, float]:
    """(access token, expires_at) for FCM HTTP v1 from a Firebase service-account key: an RS256 JWT bearer grant.
    ValueError('mint failed: <status>') on any failure, never echoing the key or the token."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa

    try:
        key = serialization.load_pem_private_key(str(sa["private_key"]).encode(), password=None)
        if not isinstance(key, rsa.RSAPrivateKey):
            raise TypeError("not RSA")
        head = b64u(json.dumps({"alg": "RS256", "typ": "JWT", "kid": sa.get("private_key_id", "")}).encode())
        claims = b64u(json.dumps({"iss": sa["client_email"], "scope": FCM_SCOPE, "aud": OAUTH_URI, "iat": int(now),
                                  "exp": int(now) + 3600}).encode())
        jwt = f"{head}.{claims}.{b64u(key.sign(f'{head}.{claims}'.encode(), padding.PKCS1v15(), hashes.SHA256()))}"
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"mint failed: bad key ({type(exc).__name__})") from None
    body = urllib.parse.urlencode({"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": jwt}).encode()
    req = urllib.request.Request(OAUTH_URI, data=body, method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            got = json.loads(resp.read(65536))
        return str(got["access_token"]), now + float(got.get("expires_in") or 3600)
    except Exception as exc:  # noqa: BLE001 -- no provider response or secret can escape this boundary
        status = exc.code if isinstance(exc, urllib.error.HTTPError) else type(exc).__name__
        raise ValueError(f"mint failed: {status}") from None

def fcm_push(dev: dict, plaintext: bytes, severity: str, project: str, token: str) -> int:
    """POST one FCM data message; returns the HTTP status (0 = network failure, 404 = the app's token is gone)."""
    ct = encrypt(dev["enc_pub"], dev["auth"], plaintext)
    msg = {"message": {"token": dev["fcm_token"], "data": {"t": "m", "ct": b64u(ct)},
                       "android": {"priority": "HIGH", "ttl": f"{TTL.get(severity, 43200)}s"}}}
    req = urllib.request.Request(FCM_URL.format(project=project), data=json.dumps(msg).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return int(resp.status)
    except urllib.error.HTTPError as exc:
        return int(exc.code)
    except Exception:  # noqa: BLE001 -- transport errors become a safe numeric result
        return 0

