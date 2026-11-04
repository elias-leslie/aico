//! CTAP2 assertions straight from the security key over USB HID, through the system libfido2 (libfido2-1, loaded at
//! run time so the background notifier never maps it). Only what an approval needs: find a key, say whether it needs
//! a PIN for user verification, and get one assertion for the registered credential ids, RP ID and client data hash,
//! with the hmac-secret extension when a release signing needs the key's unlock secret (seal.rs).

use libloading::{Library, Symbol};
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::ptr;

const FIDO_OPT_OMIT: c_int = 0;
const FIDO_OPT_FALSE: c_int = 1;
const FIDO_OPT_TRUE: c_int = 2;
const FIDO_OK: c_int = 0;
const FIDO_EXT_HMAC_SECRET: c_int = 0x01;

pub const ERR_NO_CREDENTIALS: c_int = 0x2e;
pub const ERR_ACTION_TIMEOUT: c_int = 0x2f;
pub const ERR_KEEPALIVE_CANCEL: c_int = 0x2d;
pub const ERR_OPERATION_DENIED: c_int = 0x27;
pub const ERR_PIN_INVALID: c_int = 0x31;
pub const ERR_PIN_BLOCKED: c_int = 0x32;
pub const ERR_PIN_AUTH_INVALID: c_int = 0x33;
pub const ERR_PIN_AUTH_BLOCKED: c_int = 0x34;
pub const ERR_PIN_NOT_SET: c_int = 0x35;
pub const ERR_PIN_REQUIRED: c_int = 0x36;
pub const ERR_UV_BLOCKED: c_int = 0x3c;
pub const ERR_RX: c_int = -2; // libfido2 FIDO_ERR_RX: the key stopped answering (unplugged)

type Opaque = c_void;

pub struct Fido {
    lib: Library,
}

/// One opened key. Closed and freed on drop.
pub struct Device<'a> {
    f: &'a Fido,
    dev: *mut Opaque,
    pub path: String,
}

/// What the key returned for one getAssertion.
pub struct Assertion {
    pub credential_id: Vec<u8>,
    pub auth_data: Vec<u8>,
    pub signature: Vec<u8>,
    /// hmac-secret output when asked for (never logged; wiped on drop).
    pub hmac_secret: Option<zeroize::Zeroizing<Vec<u8>>>,
}

#[derive(Debug)]
#[allow(dead_code)] // the texts show in Debug output (probe)
pub enum Error {
    NoLibrary(String),
    NoKey,
    Code(c_int, String),
}

impl Fido {
    pub fn load() -> Result<Fido, Error> {
        let lib = unsafe { Library::new("libfido2.so.1") }.map_err(|e| Error::NoLibrary(e.to_string()))?;
        let f = Fido { lib };
        unsafe {
            let init: Symbol<unsafe extern "C" fn(c_int)> = f.sym(b"fido_init\0")?;
            init(0);
        }
        Ok(f)
    }

    unsafe fn sym<T>(&self, name: &[u8]) -> Result<Symbol<'_, T>, Error> {
        self.lib.get(name).map_err(|e| Error::NoLibrary(e.to_string()))
    }

    pub fn strerr(&self, code: c_int) -> String {
        unsafe {
            match self.sym::<unsafe extern "C" fn(c_int) -> *const c_char>(b"fido_strerr\0") {
                Ok(f) => {
                    let p = f(code);
                    if p.is_null() {
                        format!("error {code}")
                    } else {
                        CStr::from_ptr(p).to_string_lossy().into_owned()
                    }
                }
                Err(_) => format!("error {code}"),
            }
        }
    }

    fn err(&self, code: c_int) -> Error {
        Error::Code(code, self.strerr(code))
    }

    /// Paths of the FIDO keys plugged in now (hidraw nodes the owner's session may open).
    pub fn devices(&self) -> Result<Vec<String>, Error> {
        unsafe {
            let new: Symbol<unsafe extern "C" fn(usize) -> *mut Opaque> = self.sym(b"fido_dev_info_new\0")?;
            let manifest: Symbol<unsafe extern "C" fn(*mut Opaque, usize, *mut usize) -> c_int> =
                self.sym(b"fido_dev_info_manifest\0")?;
            let at: Symbol<unsafe extern "C" fn(*const Opaque, usize) -> *const Opaque> =
                self.sym(b"fido_dev_info_ptr\0")?;
            let path: Symbol<unsafe extern "C" fn(*const Opaque) -> *const c_char> =
                self.sym(b"fido_dev_info_path\0")?;
            let free: Symbol<unsafe extern "C" fn(*mut *mut Opaque, usize)> = self.sym(b"fido_dev_info_free\0")?;
            let list = new(16);
            if list.is_null() {
                return Err(self.err(-9));
            }
            let mut n = 0usize;
            let rc = manifest(list, 16, &mut n);
            let mut out = Vec::new();
            if rc == FIDO_OK {
                for i in 0..n {
                    let p = path(at(list, i));
                    if !p.is_null() {
                        out.push(CStr::from_ptr(p).to_string_lossy().into_owned());
                    }
                }
            }
            let mut l = list;
            free(&mut l, 16);
            if rc != FIDO_OK {
                return Err(self.err(rc));
            }
            Ok(out)
        }
    }

    pub fn open(&self, path: &str) -> Result<Device<'_>, Error> {
        let cpath = CString::new(path).map_err(|_| Error::NoKey)?;
        unsafe {
            let new: Symbol<unsafe extern "C" fn() -> *mut Opaque> = self.sym(b"fido_dev_new\0")?;
            let open: Symbol<unsafe extern "C" fn(*mut Opaque, *const c_char) -> c_int> = self.sym(b"fido_dev_open\0")?;
            let dev = new();
            if dev.is_null() {
                return Err(self.err(-9));
            }
            let d = Device { f: self, dev, path: path.to_string() };
            let rc = open(dev, cpath.as_ptr());
            if rc != FIDO_OK {
                return Err(self.err(rc));
            }
            Ok(d)
        }
    }

    /// The first FIDO2 key that opens. libfido2's manifest lists only HID devices whose report descriptor has the
    /// FIDO usage page (0xF1D0), so other hidraw nodes never show up here; `log` gets one line per candidate.
    pub fn first(&self, log: &dyn Fn(String)) -> Result<Device<'_>, Error> {
        let paths = self.devices()?;
        log(format!("{} FIDO device(s) listed: {}", paths.len(), paths.join(", ")));
        let mut last = Error::NoKey;
        for p in paths {
            match self.open(&p) {
                Ok(d) if d.is_fido2() => return Ok(d),
                Ok(_) => log(format!("{p}: U2F only (no FIDO2), skipped")),
                Err(e) => {
                    log(format!("{p}: cannot open: {e:?}"));
                    last = e;
                }
            }
        }
        Err(last)
    }
}

impl Device<'_> {
    fn flag(&self, name: &[u8]) -> bool {
        unsafe {
            match self.f.sym::<unsafe extern "C" fn(*const Opaque) -> bool>(name) {
                Ok(s) => s(self.dev),
                Err(_) => false,
            }
        }
    }

    /// Built-in user verification (fingerprint): no PIN needed.
    pub fn has_uv(&self) -> bool {
        self.flag(b"fido_dev_has_uv\0")
    }

    /// A PIN is set on the key.
    pub fn has_pin(&self) -> bool {
        self.flag(b"fido_dev_has_pin\0")
    }

    pub fn is_fido2(&self) -> bool {
        self.flag(b"fido_dev_is_fido2\0")
    }

    pub fn pin_retries(&self) -> Option<i32> {
        unsafe {
            let s = self.f.sym::<unsafe extern "C" fn(*mut Opaque, *mut c_int) -> c_int>(b"fido_dev_get_retry_count\0").ok()?;
            let mut n: c_int = 0;
            (s(self.dev, &mut n) == FIDO_OK).then_some(n)
        }
    }

    /// A raw pointer another thread may use for cancel() while this one waits for the touch.
    pub fn handle(&self) -> usize {
        self.dev as usize
    }

    /// getAssertion: user presence always; user verification by the PIN when given, else by the key's own UV when
    /// `uv`, else none (a silent probe when `up` is false too). `hmac_salt`: also the hmac-secret output for that salt
    /// (libfido2 does the key agreement and decrypts it; with user verification the key uses its UV secret, as for
    /// the browser's PRF with userVerification required).
    #[allow(clippy::too_many_arguments)]
    pub fn assert(&self, rp: &str, cdh: &[u8; 32], creds: &[Vec<u8>], pin: Option<&str>, uv: bool, up: bool,
                  hmac_salt: Option<&[u8; 32]>) -> Result<Assertion, Error> {
        let f = self.f;
        let crp = CString::new(rp).map_err(|_| f.err(-7))?;
        let cpin = match pin {
            Some(p) => Some(CString::new(p).map_err(|_| f.err(-7))?),
            None => None,
        };
        unsafe {
            let new: Symbol<unsafe extern "C" fn() -> *mut Opaque> = f.sym(b"fido_assert_new\0")?;
            let free: Symbol<unsafe extern "C" fn(*mut *mut Opaque)> = f.sym(b"fido_assert_free\0")?;
            let set_rp: Symbol<unsafe extern "C" fn(*mut Opaque, *const c_char) -> c_int> = f.sym(b"fido_assert_set_rp\0")?;
            let set_cdh: Symbol<unsafe extern "C" fn(*mut Opaque, *const u8, usize) -> c_int> =
                f.sym(b"fido_assert_set_clientdata_hash\0")?;
            let allow: Symbol<unsafe extern "C" fn(*mut Opaque, *const u8, usize) -> c_int> =
                f.sym(b"fido_assert_allow_cred\0")?;
            let set_up: Symbol<unsafe extern "C" fn(*mut Opaque, c_int) -> c_int> = f.sym(b"fido_assert_set_up\0")?;
            let set_uv: Symbol<unsafe extern "C" fn(*mut Opaque, c_int) -> c_int> = f.sym(b"fido_assert_set_uv\0")?;
            let get: Symbol<unsafe extern "C" fn(*mut Opaque, *mut Opaque, *const c_char) -> c_int> =
                f.sym(b"fido_dev_get_assert\0")?;
            let count: Symbol<unsafe extern "C" fn(*const Opaque) -> usize> = f.sym(b"fido_assert_count\0")?;
            let ptr_fn = |name: &[u8]| f.sym::<unsafe extern "C" fn(*const Opaque, usize) -> *const u8>(name);
            let len_fn = |name: &[u8]| f.sym::<unsafe extern "C" fn(*const Opaque, usize) -> usize>(name);
            let a = new();
            if a.is_null() {
                return Err(f.err(-9));
            }
            let guard = AssertGuard { a, free: &free };
            let mut rc = set_rp(a, crp.as_ptr());
            if rc == FIDO_OK {
                rc = set_cdh(a, cdh.as_ptr(), cdh.len());
            }
            for c in creds {
                if rc == FIDO_OK {
                    rc = allow(a, c.as_ptr(), c.len());
                }
            }
            if rc == FIDO_OK {
                rc = set_up(a, if up { FIDO_OPT_TRUE } else { FIDO_OPT_FALSE });
            }
            if rc == FIDO_OK {
                rc = set_uv(a, if uv && pin.is_none() { FIDO_OPT_TRUE } else { FIDO_OPT_OMIT });
            }
            if let Some(salt) = hmac_salt {
                let ext: Symbol<unsafe extern "C" fn(*mut Opaque, c_int) -> c_int> = f.sym(b"fido_assert_set_extensions\0")?;
                let set_salt: Symbol<unsafe extern "C" fn(*mut Opaque, *const u8, usize) -> c_int> =
                    f.sym(b"fido_assert_set_hmac_salt\0")?;
                if rc == FIDO_OK {
                    rc = ext(a, FIDO_EXT_HMAC_SECRET);
                }
                if rc == FIDO_OK {
                    rc = set_salt(a, salt.as_ptr(), salt.len());
                }
            }
            if rc == FIDO_OK {
                rc = get(self.dev, a, cpin.as_ref().map_or(ptr::null(), |p| p.as_ptr()));
            }
            if rc != FIDO_OK {
                return Err(f.err(rc));
            }
            if count(a) < 1 {
                return Err(f.err(ERR_NO_CREDENTIALS));
            }
            let take = |p: &[u8], l: &[u8]| -> Result<Vec<u8>, Error> {
                let (pf, lf) = (ptr_fn(p)?, len_fn(l)?);
                let (ptr, len) = (pf(a, 0), lf(a, 0));
                Ok(if ptr.is_null() { Vec::new() } else { std::slice::from_raw_parts(ptr, len).to_vec() })
            };
            let out = Assertion {
                credential_id: take(b"fido_assert_id_ptr\0", b"fido_assert_id_len\0")?,
                auth_data: take(b"fido_assert_authdata_raw_ptr\0", b"fido_assert_authdata_raw_len\0")?,
                signature: take(b"fido_assert_sig_ptr\0", b"fido_assert_sig_len\0")?,
                hmac_secret: match hmac_salt {
                    Some(_) => Some(zeroize::Zeroizing::new(
                        take(b"fido_assert_hmac_secret_ptr\0", b"fido_assert_hmac_secret_len\0")?)).filter(|v| !v.is_empty()),
                    None => None,
                },
            };
            drop(guard);
            Ok(out)
        }
    }
}

/// Cancel a getAssertion waiting for the touch (another thread, same device handle).
pub fn cancel(f: &Fido, handle: usize) {
    unsafe {
        if let Ok(s) = f.sym::<unsafe extern "C" fn(*mut Opaque) -> c_int>(b"fido_dev_cancel\0") {
            s(handle as *mut Opaque);
        }
    }
}

struct AssertGuard<'a> {
    a: *mut Opaque,
    free: &'a Symbol<'a, unsafe extern "C" fn(*mut *mut Opaque)>,
}

impl Drop for AssertGuard<'_> {
    fn drop(&mut self) {
        let mut a = self.a;
        unsafe { (self.free)(&mut a) };
    }
}

impl Drop for Device<'_> {
    fn drop(&mut self) {
        unsafe {
            if let Ok(close) = self.f.sym::<unsafe extern "C" fn(*mut Opaque) -> c_int>(b"fido_dev_close\0") {
                close(self.dev);
            }
            if let Ok(free) = self.f.sym::<unsafe extern "C" fn(*mut *mut Opaque)>(b"fido_dev_free\0") {
                let mut d = self.dev;
                free(&mut d);
            }
        }
    }
}
