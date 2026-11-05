//! The approve uid's local socket (one JSON line each way) and the WebAuthn pieces the app builds itself: the client
//! data root verifies (type webauthn.get, the challenge root bound to this request and decision, the local origin) and
//! the answer it posts.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

pub const SOCK: &str = "/run/host-steward/grants.sock";

pub fn b64url(data: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..=chunk.len() {
            out.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

pub fn unb64url(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

pub fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

/// clientDataJSON for one decision: exactly what root parses (approvals.local_origin, webauthn._client_data).
pub fn client_data(challenge: &[u8], origin: &str) -> Vec<u8> {
    let v = json!({"type": "webauthn.get", "challenge": b64url(challenge), "origin": origin, "crossOrigin": false});
    serde_json::to_vec(&v).unwrap_or_default()
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// The answer posted for root: the key's assertion over sha256(client data), with the client data itself.
pub fn answer(id: &str, decision: &str, cred: &[u8], auth_data: &[u8], cdj: &[u8], sig: &[u8]) -> Value {
    json!({"op": "answer", "id": id, "decision": decision, "assertion": {
        "credentialId": b64url(cred), "authenticatorData": b64url(auth_data),
        "clientDataJSON": b64url(cdj), "signature": b64url(sig)}})
}

/// One request on the local socket.
/// One request on the local socket, from a worker thread (it may wait for root's service up to 10 s).
pub fn call(msg: &Value) -> Result<Value, String> {
    call_at(&sock(), msg, Duration::from_secs(10))
}

/// The same from the GTK thread: a stalled service must not freeze the window for long.
pub fn call_ui(msg: &Value) -> Result<Value, String> {
    call_at(&sock(), msg, Duration::from_secs(2))
}

fn sock() -> String {
    if cfg!(debug_assertions) {
        if let Ok(p) = std::env::var("NIGHTSHIFT_APPROVE_LOCAL_SOCK") {
            return p; // debug builds only (window tests against a fake service)
        }
    }
    SOCK.into()
}

pub fn call_at(path: &str, msg: &Value, timeout: Duration) -> Result<Value, String> {
    let mut s = UnixStream::connect(path).map_err(|e| format!("approve service not reachable: {e}"))?;
    s.set_read_timeout(Some(timeout)).ok();
    s.set_write_timeout(Some(timeout)).ok();
    let mut line = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
    line.push(b'\n');
    s.write_all(&line).map_err(|e| e.to_string())?;
    let mut out = String::new();
    BufReader::new(s.take(1 << 20)).read_line(&mut out).map_err(|e| e.to_string())?;
    serde_json::from_str(&out).map_err(|_| "approve service gave no answer".to_string())
}

pub fn ask(id: &str) -> Result<Value, String> {
    call_ui(&json!({"op": "ask", "id": id}))
}

pub fn status(id: &str) -> Result<Value, String> {
    call(&json!({"op": "status", "id": id}))
}

pub fn status_ui(id: &str) -> Result<Value, String> {
    call_ui(&json!({"op": "status", "id": id}))
}

pub fn open_ids() -> Vec<String> {
    call_ui(&json!({"op": "open"}))
        .ok()
        .and_then(|v| v.get("ids").and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|x| x.as_str().map(str::to_string))
        .filter(|x| valid_id(x))
        .collect()
}

pub fn valid_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn b64url_round_trip() {
        for n in 0..40 {
            let data: Vec<u8> = (0..n).map(|i| (i * 37 + 11) as u8).collect();
            assert_eq!(unb64url(&b64url(&data)).unwrap(), data);
        }
        assert_eq!(b64url(b"\xfb\xff"), "-_8");
        assert!(unb64url("a+b").is_none());
    }

    /// The exact bytes tests/test_approve_local.py feeds root's verifier (GOLDEN_CLIENT_DATA there).
    #[test]
    fn client_data_is_what_root_parses() {
        let cd = client_data(&[0xab; 32], "nightshift-desktop://approve.example.test");
        assert_eq!(
            String::from_utf8(cd).unwrap(),
            r#"{"challenge":"q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s","crossOrigin":false,"origin":"nightshift-desktop://approve.example.test","type":"webauthn.get"}"#
        );
    }

    #[test]
    fn challenge_binds_the_signed_hash() {
        let o = "nightshift-desktop://x";
        assert_ne!(sha256(&client_data(&[1; 32], o)), sha256(&client_data(&[2; 32], o)));
        assert_ne!(sha256(&client_data(&[1; 32], o)), sha256(&client_data(&[1; 32], "https://x")));
    }

    #[test]
    fn answer_shape() {
        let a = answer(&"a".repeat(32), "approve", b"id", b"ad", b"{}", b"sig");
        let keys: Vec<&String> = a["assertion"].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["authenticatorData", "clientDataJSON", "credentialId", "signature"]);
        assert_eq!(a["decision"], "approve");
    }

    #[test]
    fn ids_and_hex() {
        assert!(valid_id(&"0f".repeat(16)) && !valid_id("../x") && !valid_id(&"G".repeat(32)));
        assert_eq!(unhex("00ff10").unwrap(), [0, 255, 16]);
        assert!(unhex("0").is_none() && unhex("zz").is_none());
    }
}
