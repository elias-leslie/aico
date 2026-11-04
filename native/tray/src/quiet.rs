//! "Quiet for 1 hour" from the tray: notify/quiet.json {"until": epoch}, the same file push.quiet_hour_until reads.
//! While it is on, pushes wait (push.py) and the notifier shows no cards, except an approval ask close to expiring;
//! ending it early writes the time it ended, so what waited goes out from then on.

use serde_json::Value;

pub const HOUR_S: f64 = 3600.0;
const MAX_S: f64 = 2.0 * 3600.0; // push.QUIET_MAX_S: a far-off end is not a quiet hour
/// An ask's card still comes up once it has this little time left (push.QUIET_ASK_NEAR_S).
pub const ASK_NEAR_S: f64 = 300.0;

fn path() -> std::path::PathBuf {
    crate::published::state_dir().join("notify/quiet.json")
}

/// When the quiet hour ends, or 0 when none is on (same rules as push.quiet_hour_until).
pub fn until_in(v: &Value, now: f64) -> f64 {
    match v["until"].as_f64() {
        Some(end) if now < end && end <= now + MAX_S => end,
        _ => 0.0,
    }
}

pub fn until(now: f64) -> f64 {
    let v = std::fs::read(path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
    until_in(&v, now)
}

fn write(end: f64) {
    let p = path();
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let tmp = p.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::json!({"until": end}).to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, &p);
    }
}

pub fn start(now: f64) {
    write(now + HOUR_S);
}

pub fn end(now: f64) {
    write(now);
}

/// Whether an ask's card may come up now: always outside a quiet hour, inside one only close to its expiry.
pub fn ask_may_show(quiet_until: f64, expires: f64, now: f64) -> bool {
    quiet_until == 0.0 || expires - now <= ASK_NEAR_S
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn quiet_hour_reads_like_the_push_side() {
        assert_eq!(until_in(&json!({"until": 4600.0}), 1000.0), 4600.0);
        assert_eq!(until_in(&json!({"until": 1000.0}), 1000.0), 0.0); // ended
        assert_eq!(until_in(&json!({"until": 1000.0 + 3.0 * 3600.0}), 1000.0), 0.0); // bogus far-off end
        assert_eq!(until_in(&json!({"until": "x"}), 1000.0), 0.0);
        assert_eq!(until_in(&Value::Null, 1000.0), 0.0);
    }

    #[test]
    fn asks_wait_until_close_to_expiring() {
        assert!(ask_may_show(0.0, 1900.0, 1000.0));
        assert!(!ask_may_show(4600.0, 1900.0, 1000.0));
        assert!(ask_may_show(4600.0, 1300.0, 1000.0));
    }
}
