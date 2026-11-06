//! The signing-handover extra of an approval, done the same way as the browser does it (byte for byte, so root and
//! the stored keys cannot tell the two apart; the salt and info strings below are a contract with stored keys and never
//! change, whatever the old name in them): the key's CTAP2 hmac-secret over SHA-256("WebAuthn PRF" || 0x00 ||
//! salt), which is exactly what the browser's WebAuthn PRF extension returns for `eval.first = salt` (so the same passkey opens the same keys),
//! sealed to root's per-request transport key: ECDH P-256 with a fresh key, HKDF-SHA256 (salt = request id bytes,
//! info nightshift-prf-transport-v1), AES-256-GCM with the AAD "<id>:<credential id>" (root's open_prf). Nothing
//! here is ever logged or written to disk.

use crate::proto::{b64url, unb64url, unhex};
use aes_gcm::aead::{Aead, Generate, KeyInit, Payload};
use aes_gcm::aead::Nonce;
use aes_gcm::Aes256Gcm;
use hkdf::Hkdf;
use p256::elliptic_curve::sec1::ToSec1Point;
use p256::{PublicKey, SecretKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

const PRF_TRANSPORT_INFO: &[u8] = b"nightshift-prf-transport-v1";

/// The CTAP2 hmac-secret salt the browser uses for WebAuthn PRF `eval.first = input`.
pub fn prf_salt(input: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"WebAuthn PRF");
    h.update([0u8]);
    h.update(input);
    h.finalize().into()
}

fn rid_bytes(rid: &str) -> Result<Vec<u8>, String> {
    unhex(rid).filter(|b| b.len() == 16).ok_or_else(|| "bad request id".to_string())
}

fn point(b64: &str) -> Result<PublicKey, String> {
    let raw = unb64url(b64).ok_or("bad key encoding")?;
    PublicKey::from_sec1_bytes(&raw).map_err(|_| "not a P-256 key".to_string())
}

fn raw_pub(k: &SecretKey) -> Vec<u8> {
    k.public_key().to_sec1_point(false).as_bytes().to_vec()
}

/// HKDF-SHA256 over the ECDH x coordinate (what WebCrypto deriveBits and cryptography's exchange return).
fn derive(mine: &SecretKey, peer: &PublicKey, salt: &[u8], info: &[u8]) -> Zeroizing<[u8; 32]> {
    let shared = p256::ecdh::diffie_hellman(mine.to_nonzero_scalar(), peer.as_affine());
    let mut out = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(salt), shared.raw_secret_bytes()).expand(info, &mut out[..]).expect("32 bytes fit HKDF");
    out
}

/// The hmac-secret output sealed for root: {epk, iv, ct}, what the page's seal() posts as "prf".
pub fn seal_prf(secret: &[u8], transport: &str, rid: &str, cred: &str) -> Result<Value, String> {
    let iv: [u8; 12] = Nonce::<Aes256Gcm>::generate().into();
    seal_prf_with(&SecretKey::generate(), &iv, secret, transport, rid, cred)
}

fn seal_prf_with(mine: &SecretKey, iv: &[u8; 12], secret: &[u8], transport: &str, rid: &str, cred: &str)
    -> Result<Value, String> {
    let k = derive(mine, &point(transport)?, &rid_bytes(rid)?, PRF_TRANSPORT_INFO);
    let aad = format!("{rid}:{cred}");
    let ct = Aes256Gcm::new_from_slice(&k[..]).map_err(|_| "bad key")?
        .encrypt(&Nonce::<Aes256Gcm>::from(*iv), Payload { msg: secret, aad: aad.as_bytes() })
        .map_err(|_| "could not seal the unlock secret".to_string())?;
    Ok(json!({"epk": b64url(&raw_pub(mine)), "iv": b64url(iv), "ct": b64url(&ct)}))
}

#[cfg(test)]
mod tests {
    use super::*;

    // seal_golden.rs: vectors made with Python's cryptography the way root and the page do it, checked on that side too.
    const RID: &str = "00112233445566778899aabbccddeeff";

    fn key(hex: &str) -> SecretKey {
        SecretKey::from_slice(&unhex(hex).unwrap()).unwrap()
    }

    #[test]
    fn prf_salt_is_webauthns() {
        // SHA-256(b"WebAuthn PRF\x00" + SHA-256(b"nightshift release signing v1")), the signing salt through the browser
        let input = crate::proto::sha256(b"nightshift release signing v1");
        assert_eq!(b64url(&prf_salt(&input)), golden::PRF_HMAC_SALT);
    }

    #[test]
    fn prf_seal_matches_the_page_byte_for_byte() {
        let iv: [u8; 12] = unhex(golden::IV).unwrap().try_into().unwrap();
        let blob = seal_prf_with(&key(golden::EPH), &iv, &[0x42; 32], golden::TRANSPORT_PUB, RID, "Y3JlZA").unwrap();
        assert_eq!(blob, json!({"epk": golden::EPH_PUB, "iv": b64url(&iv), "ct": golden::PRF_CT}));
        assert!(seal_prf(&[1; 32], golden::TRANSPORT_PUB, "zz", "c").is_err());
        assert!(seal_prf(&[1; 32], "AAAA", RID, "c").is_err());
    }

    #[test]
    fn random_seal_opens_with_the_transport_key() {
        // the production path (fresh key and IV from the OS RNG), opened the way root does: ECDH + HKDF + AES-GCM
        let blob = seal_prf(&[0x24; 32], golden::TRANSPORT_PUB, RID, "Y3JlZA").unwrap();
        let epk = point(blob["epk"].as_str().unwrap()).unwrap();
        let k = derive(&key(golden::TRANSPORT), &epk, &unhex(RID).unwrap(), PRF_TRANSPORT_INFO);
        let iv: [u8; 12] = unb64url(blob["iv"].as_str().unwrap()).unwrap().try_into().unwrap();
        let ct = unb64url(blob["ct"].as_str().unwrap()).unwrap();
        let pt = Aes256Gcm::new_from_slice(&k[..]).unwrap()
            .decrypt(&Nonce::<Aes256Gcm>::from(iv), Payload { msg: &ct, aad: format!("{RID}:Y3JlZA").as_bytes() })
            .unwrap();
        assert_eq!(pt, [0x24; 32]);
    }

    #[allow(dead_code)] // the private halves root holds, used by the Python side's check
    mod golden {
        include!("seal_golden.rs");
    }
}
