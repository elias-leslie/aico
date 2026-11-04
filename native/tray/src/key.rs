//! The security key behind the approval window: the real one (libfido2), or in debug builds only a scripted fake
//! (NIGHTSHIFT_FAKE_KEY=ok|uv|timeout|denied|blocked|nokey|unplug|noprf) so the PIN, touch and error paths can be driven on a
//! test display without touching a key. Release builds have no fake: the variable is ignored there.

use crate::fido::{self, Assertion, Error, Fido};

pub enum Key {
    Real(fido::Device<'static>),
    #[cfg(debug_assertions)]
    Fake(fake::FakeKey),
}

impl Key {
    /// The key to ask, or a plain sentence why there is none. `log` gets one line per step.
    pub fn find(lib: Result<&'static Fido, String>, log: &dyn Fn(String)) -> Result<Key, String> {
        #[cfg(debug_assertions)]
        if let Ok(mode) = std::env::var("NIGHTSHIFT_FAKE_KEY") {
            return fake::find(&mode, log).map(Key::Fake);
        }
        let lib = lib.map_err(|e| {
            log(format!("libfido2 not loaded: {e}"));
            "The security key library (libfido2) is missing, so the key can't be used here.".to_string()
        })?;
        match lib.first(log) {
            Ok(d) => Ok(Key::Real(d)),
            Err(Error::NoKey) => Err("No security key found. Plug it in, then try again.".into()),
            Err(e) => {
                log(format!("no usable key: {e:?}"));
                Err("The security key couldn't be opened. Unplug it, plug it back in, then try again.".into())
            }
        }
    }

    pub fn path(&self) -> String {
        match self {
            Key::Real(d) => d.path.clone(),
            #[cfg(debug_assertions)]
            Key::Fake(_) => "fake-key".into(),
        }
    }

    pub fn has_uv(&self) -> bool {
        match self {
            Key::Real(d) => d.has_uv(),
            #[cfg(debug_assertions)]
            Key::Fake(f) => f.uv,
        }
    }

    pub fn has_pin(&self) -> bool {
        match self {
            Key::Real(d) => d.has_pin(),
            #[cfg(debug_assertions)]
            Key::Fake(f) => !f.uv,
        }
    }

    pub fn pin_retries(&self) -> Option<i32> {
        match self {
            Key::Real(d) => d.pin_retries(),
            #[cfg(debug_assertions)]
            Key::Fake(_) => Some(fake::retries()),
        }
    }

    /// A handle another thread may cancel while this one waits for the touch (None for the fake).
    pub fn handle(&self) -> Option<usize> {
        match self {
            Key::Real(d) => Some(d.handle()),
            #[cfg(debug_assertions)]
            Key::Fake(_) => None,
        }
    }

    pub fn assert(&self, rp: &str, cdh: &[u8; 32], creds: &[Vec<u8>], pin: Option<&str>, uv: bool,
                  hmac_salt: Option<&[u8; 32]>) -> Result<Assertion, Error> {
        match self {
            Key::Real(d) => d.assert(rp, cdh, creds, pin, uv, true, hmac_salt),
            #[cfg(debug_assertions)]
            Key::Fake(f) => f.assert(pin, hmac_salt),
        }
    }
}

#[cfg(debug_assertions)]
mod fake {
    use super::*;
    use std::sync::atomic::{AtomicI32, Ordering};
    use std::time::Duration;

    pub const PIN: &str = "1234";
    static RETRIES: AtomicI32 = AtomicI32::new(8);

    pub struct FakeKey {
        pub uv: bool,
        mode: String,
    }

    pub fn retries() -> i32 {
        RETRIES.load(Ordering::SeqCst)
    }

    pub fn find(mode: &str, log: &dyn Fn(String)) -> Result<FakeKey, String> {
        log(format!("fake key, mode {mode}"));
        match mode {
            "nokey" => Err("No security key found. Plug it in, then try again.".into()),
            _ => Ok(FakeKey { uv: mode == "uv", mode: mode.into() }),
        }
    }

    fn code(c: i32) -> Error {
        Error::Code(c, format!("fake error {c:#x}"))
    }

    impl FakeKey {
        pub fn assert(&self, pin: Option<&str>, hmac_salt: Option<&[u8; 32]>) -> Result<Assertion, Error> {
            std::thread::sleep(Duration::from_millis(300));
            if self.mode == "blocked" {
                return Err(code(fido::ERR_PIN_AUTH_BLOCKED));
            }
            if !self.uv {
                match pin {
                    None => return Err(code(fido::ERR_PIN_REQUIRED)),
                    Some(p) if p != PIN => {
                        RETRIES.fetch_sub(1, Ordering::SeqCst);
                        return Err(code(fido::ERR_PIN_INVALID));
                    }
                    _ => {}
                }
            }
            std::thread::sleep(Duration::from_millis(1500)); // "touch"
            match self.mode.as_str() {
                "timeout" => Err(code(fido::ERR_ACTION_TIMEOUT)),
                "denied" => Err(code(fido::ERR_OPERATION_DENIED)),
                "unplug" => Err(code(fido::ERR_RX)),
                // mode noprf: a key without hmac-secret (the phone's passkey can't be used here for signing either)
                _ => Ok(Assertion { credential_id: vec![0, 1, 2, 3], auth_data: vec![0; 37], signature: vec![0x30, 0],
                                    hmac_secret: hmac_salt.filter(|_| self.mode != "noprf")
                                        .map(|s| zeroize::Zeroizing::new(crate::proto::sha256(s).to_vec())) }),
            }
        }
    }
}
