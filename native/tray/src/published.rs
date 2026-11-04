//! Open passkey asks as root publishes them (approvals.json: ids, kinds, states, never argv), titled with the push the
//! owner got for each (the push log, from the item store's read: notices::log_of). Same rules as nightshift.web.page.waiting_approvals. Also the access
//! grants open now (approvals.json grants), ending one early through root's normal revoke route (the bypass inbox,
//! as `nightshift elevate revoke`; it only ever narrows), and what the board's Needs you count can honestly say (from
//! the item store's tray summary, items.rs tray_summary).

use serde_json::Value;
use std::path::Path;

const STATE_DIR: &str = "/var/lib/nightshift";

/// Nightshift's state directory; debug builds may point at a test copy (NIGHTSHIFT_STATE_DIR), release builds never.
pub fn state_dir() -> std::path::PathBuf {
    #[cfg(debug_assertions)]
    if let Some(d) = std::env::var_os("NIGHTSHIFT_STATE_DIR") {
        return d.into();
    }
    STATE_DIR.into()
}

/// Root's published approvals list (approvals.json).
pub fn public_path() -> std::path::PathBuf {
    state_dir().join("approvals.json")
}
const TTL_S: f64 = 900.0;
const KINDS: [&str; 3] = ["elevate", "passkey", "signing"];

#[derive(Debug, Clone, PartialEq)]
pub struct Waiting {
    pub id: String,
    pub kind: String,
    pub expires: f64,
    pub title: String,
    pub body: String,
    /// The push log already has this ask (its own title); without it the title is a fallback.
    pub titled: bool,
}

fn read_json(path: &Path) -> Value {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null)
}

/// Still-open asks root pushed (a quiet repeat of a still-open ask is skipped), soonest deadline last.
pub fn waiting(public: &Value, log: &Value, now: f64) -> Vec<Waiting> {
    let mut out = Vec::new();
    let empty = Vec::new();
    let pushed: Vec<&Value> = log.as_array().unwrap_or(&empty).iter().filter(|e| e["kind"] == "approve").collect();
    for r in public["requests"].as_array().unwrap_or(&empty) {
        let id = r["id"].as_str().unwrap_or("");
        let kind = r["kind"].as_str().unwrap_or("");
        if r["state"] != "pending" || !KINDS.contains(&kind) || !crate::proto::valid_id(id) || r["pushed"] == false {
            continue;
        }
        let expires = r["expires"].as_f64().unwrap_or(r["created"].as_f64().unwrap_or(0.0) + TTL_S);
        if expires <= now {
            continue;
        }
        let key = format!("approve:{kind}:{id}");
        let e = pushed.iter().rev().find(|e| e["key"].as_str() == Some(key.as_str()));
        let family = r["family"].as_str().filter(|s| !s.is_empty()).unwrap_or(kind);
        let title = e.and_then(|e| e["title"].as_str()).map_or_else(|| format!("Approve: {family}"), str::to_string);
        let body = e.and_then(|e| e["body"].as_str()).unwrap_or("").to_string();
        out.push(Waiting { id: id.into(), kind: kind.into(), expires, title, body, titled: e.is_some() });
    }
    out.sort_by(|a, b| b.expires.total_cmp(&a.expires));
    out
}

pub fn public() -> Value {
    read_json(&public_path())
}

#[derive(Debug, Clone, PartialEq)]
pub struct Grant {
    pub kind: String,
    pub label: String,
    pub expires: f64,
}

/// Access grants open now, soonest end first, labeled as the owner reads them (the web service's copy of
/// grantkinds labels; the kind itself when it has none).
pub fn grants(public: &Value, labels: &Value, now: f64) -> Vec<Grant> {
    let empty = Vec::new();
    let mut out: Vec<Grant> = public["grants"].as_array().unwrap_or(&empty).iter()
        .filter_map(|g| {
            let kind = g["kind"].as_str().filter(|k| !k.is_empty() && k.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'))?;
            let expires = g["expires"].as_f64().filter(|e| *e > now)?;
            let label = labels[kind].as_str().filter(|l| !l.is_empty()).unwrap_or(kind).to_string();
            Some(Grant { kind: kind.into(), label, expires })
        })
        .collect();
    out.sort_by(|a, b| a.expires.total_cmp(&b.expires));
    out
}

/// What the Board row can honestly say: the count when the store's tray summary is current and the snapshot fresh,
/// "stale" when the checks are out of date, Unknown otherwise (the read failed, the store's words are old, or the last
/// good read is older than SUMMARY_MAX_AGE_S).
#[derive(Debug, Clone, PartialEq)]
pub enum NeedsYou {
    Count(usize),
    Stale,
    Unknown,
}

pub const SUMMARY_MAX_AGE_S: f64 = 300.0; // the notifier reads the store at least once a minute (daemon.rs)

pub fn needs_you(summary: &Value, now: f64) -> NeedsYou {
    let at = summary["at"].as_f64().unwrap_or(0.0);
    if at <= 0.0 || now - at > SUMMARY_MAX_AGE_S {
        return NeedsYou::Unknown;
    }
    match (summary["snapshot"].as_str(), summary["needs_you"].as_u64()) {
        (Some("fresh"), Some(n)) => NeedsYou::Count(n as usize),
        (Some("stale" | "missing"), _) => NeedsYou::Stale,
        _ => NeedsYou::Unknown,
    }
}

/// The items the tray rule lists with their unread pushes (surface.tray unread_rows), while the summary is current;
/// None when unknown (no good read, an older store without them, or the last good read is too old).
pub fn unread_rows(summary: &Value, now: f64) -> Option<Vec<Vec<String>>> {
    let at = summary["at"].as_f64().unwrap_or(0.0);
    if at <= 0.0 || now - at > SUMMARY_MAX_AGE_S {
        return None;
    }
    summary["unread_rows"].as_array().map(|rows| rows.iter().map(|r| r.as_array().map(|ids| ids.iter()
        .filter_map(|i| i.as_str().map(str::to_string)).collect()).unwrap_or_default()).collect())
}

/// Tether's Aico asks feed for the tray (owner-asks/TRAY-FEED-CONTRACT.md): written on every ask change and once a
/// minute, never with question text. Tests (and debug builds) may point elsewhere.
pub fn aico_feed_path() -> std::path::PathBuf {
    #[cfg(any(test, debug_assertions))]
    if let Some(p) = std::env::var_os("NIGHTSHIFT_AICO_FEED") {
        return p.into();
    }
    let state = std::env::var_os("XDG_STATE_HOME").map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::Path::new(&h).join(".local/state")))
        .unwrap_or_default();
    state.join("tether/default/needs-you.json")
}

/// The Aico asks waiting on the owner. `at` is when Tether wrote it (s); 0 when the file is missing or unreadable.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AicoAsks {
    pub open: usize,
    pub blocking: usize,
    pub url: Option<String>, // the newest ask in Aico, already checked against the allowed hosts
    pub at: f64,
}

pub const AICO_MAX_AGE_S: f64 = 180.0; // Tether rewrites it every minute

/// Reads the feed; `check` vets the newest ask's link (notices::open_link's host rule).
pub fn aico_asks(feed: &Value, check: impl Fn(&str) -> Option<String>) -> AicoAsks {
    let (Some(1), Some(at), Some(open)) = (feed["version"].as_u64(), feed["writtenAt"].as_f64(), feed["open"].as_u64()) else {
        return AicoAsks::default();
    };
    AicoAsks { open: open as usize, blocking: feed["blocking"].as_u64().unwrap_or(0) as usize,
               url: feed["newest"]["url"].as_str().and_then(check), at: at / 1000.0 }
}

fn random_id() -> Option<String> {
    let mut b = [0u8; 16];
    std::fs::File::open("/dev/urandom").and_then(|mut f| std::io::Read::read_exact(&mut f, &mut b)).ok()?;
    Some(b.iter().map(|x| format!("{x:02x}")).collect())
}

fn inbox() -> std::path::PathBuf {
    #[cfg(any(test, debug_assertions))]
    if let Some(d) = std::env::var_os("NIGHTSHIFT_BYPASS_INBOX") {
        return d.into();
    }
    #[cfg(test)] // a test never files a request with root, whatever the build profile
    return std::env::temp_dir().join(format!("ns-inbox-test-{}", std::process::id()));
    #[cfg(not(test))]
    state_dir().join("bypass/inbox")
}

/// End every open grant of `kind` now: one revoke request in root's inbox. Root answers in bypass/out and
/// republishes approvals.json, which the notifier watches.
pub fn revoke(kind: &str) -> Result<String, String> {
    if kind.is_empty() || !kind.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
        return Err("bad grant kind".into());
    }
    submit(serde_json::json!({"kind": "revoke", "grant": kind, "agent": "Aico tray"}))
}

/// One request in root's inbox (bypass.submit's format and modes), with a fresh id and this process's unit.
pub fn submit(mut body: Value) -> Result<String, String> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let rid = random_id().ok_or("no random id")?;
    let unit = std::fs::read_to_string("/proc/self/cgroup").ok()
        .and_then(|c| c.trim().rsplit('/').next().map(|u| u.chars().take(120).collect::<String>())).unwrap_or_default();
    body["id"] = rid.clone().into();
    body["unit"] = unit.into();
    let dir = inbox();
    let tmp = dir.join(format!(".{rid}.tmp"));
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o644)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&tmp).map_err(|e| e.to_string())?;
    let _ = f.set_permissions(std::fs::Permissions::from_mode(0o644)); // past the umask: root reads it
    f.write_all(body.to_string().as_bytes()).map_err(|e| e.to_string())?;
    drop(f);
    std::fs::rename(&tmp, dir.join(format!("{rid}.json"))).map_err(|e| e.to_string())?;
    Ok(rid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn open_pushed_asks_only_with_their_push_title() {
        let a = "a".repeat(32);
        let b = "b".repeat(32);
        let c = "c".repeat(32);
        let public = json!({"requests": [
            {"id": a, "kind": "elevate", "state": "pending", "expires": 2000.0, "family": "sh"},
            {"id": b, "kind": "passkey", "state": "pending", "expires": 1500.0, "pushed": false},
            {"id": c, "kind": "elevate", "state": "applied", "expires": 2000.0},
            {"id": "../x", "kind": "elevate", "state": "pending", "expires": 2000.0},
            {"id": "d".repeat(32), "kind": "elevate", "state": "pending", "expires": 900.0},
            {"id": "e".repeat(32), "kind": "policy", "state": "pending", "expires": 2000.0}]});
        let log = json!([{"kind": "approve", "key": format!("approve:elevate:{a}"), "title": "Run sh as root?", "body": "x"}]);
        let w = waiting(&public, &log, 1000.0);
        assert_eq!(w.len(), 1);
        assert_eq!((w[0].title.as_str(), w[0].titled), ("Run sh as root?", true));
        let w = waiting(&public, &json!([]), 1000.0);
        assert_eq!((w[0].title.as_str(), w[0].titled), ("Approve: sh", false));
    }

    #[test]
    fn open_grants_soonest_first_with_their_labels() {
        let public = json!({"grants": [
            {"id": "a", "kind": "owner-chrome", "expires": 3000.0},
            {"id": "b", "kind": "github-admin", "expires": 2000.0},
            {"id": "c", "kind": "github-admin", "expires": 900.0},
            {"id": "d", "kind": "../x", "expires": 3000.0}]});
        let labels = json!({"github-admin": "GitHub admin"});
        let g = grants(&public, &labels, 1000.0);
        assert_eq!(g, vec![Grant { kind: "github-admin".into(), label: "GitHub admin".into(), expires: 2000.0 },
                           Grant { kind: "owner-chrome".into(), label: "owner-chrome".into(), expires: 3000.0 }]);
    }

    #[test]
    fn needs_you_is_a_count_only_when_current() {
        let now = 10_000.0;
        assert_eq!(needs_you(&json!({"at": now - 30.0, "snapshot": "fresh", "needs_you": 4}), now), NeedsYou::Count(4));
        assert_eq!(needs_you(&json!({"at": now - 30.0, "snapshot": "stale", "needs_you": 4}), now), NeedsYou::Stale);
        assert_eq!(needs_you(&json!({"at": now - 900.0, "snapshot": "fresh", "needs_you": 4}), now), NeedsYou::Unknown);
        assert_eq!(needs_you(&Value::Null, now), NeedsYou::Unknown);
        // the tray rule's unread items: only from a current file that has them
        let rows = json!({"at": now - 30.0, "unread_rows": [["aaaaaaaaaaaa"], ["bbbbbbbbbbbb", "cccccccccccc"]]});
        assert_eq!(unread_rows(&rows, now), Some(vec![vec!["aaaaaaaaaaaa".to_string()],
                                                     vec!["bbbbbbbbbbbb".into(), "cccccccccccc".into()]]));
        assert_eq!(unread_rows(&json!({"at": now - 30.0, "needs_you": 4}), now), None); // an older web service
        assert_eq!(unread_rows(&json!({"at": now - 900.0, "unread_rows": []}), now), None);
    }

    #[test]
    fn aico_feed_reads_counts_and_only_a_vetted_link() {
        let ok = |u: &str| u.starts_with("https://aico.example/").then(|| u.to_string());
        let feed = json!({"version": 1, "writtenAt": 1793380081541.0, "open": 2, "blocking": 1,
                          "newest": {"id": "e0062e61c89f", "url": "https://aico.example/?ask=e0062e61c89f"}});
        assert_eq!(aico_asks(&feed, ok), AicoAsks { open: 2, blocking: 1, url: Some("https://aico.example/?ask=e0062e61c89f".into()),
                                                    at: 1793380081.541 });
        let mut bad = feed.clone();
        bad["newest"]["url"] = json!("https://evil.example/");
        assert_eq!(aico_asks(&bad, ok).url, None);
        assert_eq!(aico_asks(&json!({"version": 2, "writtenAt": 1.0, "open": 2}), ok), AicoAsks::default()); // unknown version
        assert_eq!(aico_asks(&Value::Null, ok), AicoAsks::default());
    }

    #[test]
    fn revoke_files_one_request_in_the_inbox() {
        let d = std::env::temp_dir().join(format!("ns-inbox-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::env::set_var("NIGHTSHIFT_BYPASS_INBOX", &d);
        assert!(revoke("../etc").is_err());
        let rid = revoke("github-admin").unwrap();
        std::env::remove_var("NIGHTSHIFT_BYPASS_INBOX");
        let v: Value = serde_json::from_slice(&std::fs::read(d.join(format!("{rid}.json"))).unwrap()).unwrap();
        assert_eq!((v["kind"].as_str(), v["grant"].as_str(), v["id"].as_str()), (Some("revoke"), Some("github-admin"), Some(rid.as_str())));
        assert!(crate::proto::valid_id(&rid));
        let _ = std::fs::remove_dir_all(&d);
    }
}
