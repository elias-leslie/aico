//! Owner notifications other than approval asks, from the push log as aico-web's tray door gives it (`GET /api/tray`,
//! read_marks): which ones the tray shows as popups next to it and when it takes one
//! down, and which the tray lists. Cleared anywhere means cleared everywhere: its page opened on any device, its
//! notification or tray row clicked or dismissed here, or the tray's "Mark all read" clicked after it came (read_at),
//! or its issue over (over_at). Opening the
//! notifications page from the tray clears nothing: the tray keeps listing what is new until it is read.
//!
//! The notifier reads the door (daemon.rs, every few seconds) and hands the corner card its pushes; a card
//! started on its own reads them itself (entries). A read here goes to aico-web (`POST /api/tray/seen`; a click:
//! in the background, and kept in memory meanwhile so the card goes at once; the panel waits for it, since its lists
//! come from the store).

use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

/// Asks show as their own notification (daemon); a test push is the owner's own button.
pub const HIDDEN_KINDS: [&str; 3] = ["approve", "elevate", "test"];

/// The push log in a store read (`items --json --pushes`): each push as logged, oldest first. Null when the read has
/// no pushes (an older store, or a read without --pushes).
pub fn log_of(items: &Value) -> Value {
    match items["read_marks"]["pushes"].as_array() {
        Some(rows) => Value::Array(rows.iter().filter(|r| r["push"].is_object()).map(|r| r["push"].clone()).collect()),
        None => Value::Null,
    }
}

/// These pushes from the store (blocking: a corner card or notification card started on its own).
pub fn entries(ids: &[String]) -> Result<Vec<Value>, String> {
    let log = log_of(&crate::items::read()?);
    let empty = Vec::new();
    Ok(ids.iter().filter_map(|i| log.as_array().unwrap_or(&empty).iter().find(|e| e["id"].as_str() == Some(i))).cloned()
        .collect())
}

/// One push from the store (blocking); Ok(None) when it left the log.
pub fn entry(id: &str) -> Result<Option<Value>, String> {
    entries(&[id.to_string()]).map(|mut v| v.pop())
}

/// Reads made in this process (ids, and the last Mark all read): they count at once, before the store's next read
/// shows them (and still count if aico-web could not record them).
static LOCAL: Mutex<(Vec<(String, f64)>, f64)> = Mutex::new((Vec::new(), 0.0));

fn note_local(ids: &[&str], all: Option<f64>) {
    let t = crate::daemon::now();
    if let Ok(mut l) = LOCAL.lock() {
        l.0.extend(ids.iter().map(|i| (i.to_string(), t)));
        let skip = l.0.len().saturating_sub(500);
        l.0.drain(..skip);
        if let Some(at) = all {
            l.1 = l.1.max(at);
        }
    }
}

/// Tell Aico (POST /api/tray/seen): ids read in `via`, or everything up to `at` seconds when `all`.
fn seen(body: serde_json::Value, what: &str) -> Result<(), String> {
    crate::aico::post("/api/tray/seen", &body).map(|_| ()).map_err(|e| format!("{what} not recorded: {e}"))
}

/// The owner pressed "Mark all read": every push up to now is read. Waits for Aico (the panel re-reads after).
pub fn mark_opened() -> Result<(), String> {
    note_local(&[], Some(crate::daemon::now()));
    seen(serde_json::json!({"all": true}), "Mark all read")
}

/// The tray's first run: every push up to the newest one it read is read (not "up to now": one that came while the
/// tray read stays new and gets its card).
pub fn mark_read_up_to(at: f64) -> Result<(), String> {
    if at <= 0.0 {
        return mark_opened(); // no push yet: the mark is now, so this first run is recorded once
    }
    note_local(&[], Some(at));
    seen(serde_json::json!({"all": true, "at": at}), "Mark all read")
}

/// The owner pressed Mark read on these in `via` (panel, popup): recorded as an act on their items; waits for
/// Aico (the panel re-reads after).
pub fn mark_read_pressed(ids: &[String], via: &str) -> Result<(), String> {
    match read_pressed(ids, via) {
        Some(body) => seen(body, "Read"),
        None => Ok(()),
    }
}

/// mark_read_pressed in the background: the request goes out on its own thread, so it finishes even if the card
/// that asked closes first (the popup).
pub fn mark_read_pressed_bg(ids: &[String], via: &str) {
    let Some(body) = read_pressed(ids, via) else { return };
    std::thread::spawn(move || {
        if let Err(e) = seen(body, "Read") {
            eprintln!("{e}");
        }
    });
}

fn read_pressed(ids: &[String], via: &str) -> Option<serde_json::Value> {
    let ids: Vec<&str> = ids.iter().map(String::as_str).filter(|i| valid_entry_id(i)).collect();
    if ids.is_empty() {
        return None;
    }
    note_local(&ids, None);
    Some(serde_json::json!({"ids": ids, "via": via}))
}

/// Notifications the tray lists: not asks (listed on their own), not ones held back (suppressed, quieted, not final).
fn listed(e: &Value) -> bool {
    !HIDDEN_KINDS.contains(&e["kind"].as_str().unwrap_or(""))
        && !matches!(e["result"].as_str().unwrap_or(""), "suppressed" | "quieted" | "pending")
        && e["id"].as_str().is_some_and(valid_entry_id)
}

/// A file an agent shared (tether share): it belongs to Aico's Files, so the tray neither counts nor lists it. Its
/// corner card and its line on the notifications page stay.
const SHARE_TITLE: &str = "Shared: ";

fn share(e: &Value) -> bool {
    e["kind"].as_str() == Some("manual") && e["title"].as_str().is_some_and(|t| t.starts_with(SHARE_TITLE))
}

/// What the tray counts and lists: listed and not a share.
fn in_tray(e: &Value) -> bool {
    listed(e) && !share(e)
}

/// Notifications the owner hasn't read yet: in the tray and not cleared (read here or on any device, marked all read,
/// or their issue over).
pub fn unread(log: &Value, cleared: &Cleared) -> usize {
    let empty = Vec::new();
    log.as_array().unwrap_or(&empty).iter().filter(|e| in_tray(e) && !cleared.of(e)).count()
}

/// The icon's "N new" under the tray rule: the items the door lists (the tray summary
/// unread_rows, each item's unread pushes) with a push not cleared here. A read here or anywhere clears it at once,
/// and so does its issue ending (owner 2026-11-03); an id no longer in the log counts as cleared.
pub fn unread_items(rows: &[Vec<String>], log: &Value, cleared: &Cleared) -> usize {
    let empty = Vec::new();
    let by_id: HashMap<&str, &Value> = log.as_array().unwrap_or(&empty).iter()
        .filter_map(|e| e["id"].as_str().map(|i| (i, e))).collect();
    rows.iter().filter(|ids| ids.iter().any(|i| by_id.get(i.as_str()).is_some_and(|e| !cleared.of(e)))).count()
}

pub fn ago(secs: f64) -> String {
    // The same rule as ago in @aico/shared/time: hours round to the nearest (90 min is "2 h ago").
    let m = (secs / 60.0).round() as i64;
    match m {
        i64::MIN..=0 => "just now".into(),
        1..=59 => format!("{m} min ago"),
        60..=2879 => format!("{} h ago", (m as f64 / 60.0).round() as i64),
        _ => format!("{} days ago", m / 1440),
    }
}

pub fn valid_entry_id(id: &str) -> bool {
    id.len() == 12 && id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// A result that means the owner should see it now (it went out, or waits on this desktop for the phone).
pub fn showable(result: &str) -> bool {
    result.starts_with("sent ") || matches!(result, "sent" | "held" | "desktop-popup" | "spooled" | "no-subscribers")
}

/// New notifications to show: after `since`, not asks, final and showable, not shown yet, not cleared.
pub fn to_show<'a>(log: &'a Value, since: f64, shown: &HashMap<String, u32>, cleared: &Cleared) -> Vec<&'a Value> {
    let Some(all) = log.as_array() else { return Vec::new() };
    all.iter()
        .filter(|e| e["ts"].as_f64().unwrap_or(0.0) > since)
        .filter(|e| !HIDDEN_KINDS.contains(&e["kind"].as_str().unwrap_or("")))
        .filter(|e| e["quiet"] != true) // the owner silenced this type on the desktop; it stays in the list
        .filter(|e| showable(e["result"].as_str().unwrap_or("")))
        .filter(|e| e["id"].as_str().is_some_and(|i| valid_entry_id(i) && !shown.contains_key(i)))
        .filter(|e| !cleared.of(e))
        .collect()
}

#[derive(Debug, Clone, Default)]
pub struct Cleared {
    pub seen: HashMap<String, f64>,
    pub opened_seen: f64,
    pub over: HashSet<String>,
}

impl Cleared {
    /// The store's read marks (read_marks in `items --json`) with this process's own reads.
    pub fn of_marks(marks: &Value) -> Cleared {
        let empty = Vec::new();
        let rows = marks["pushes"].as_array().unwrap_or(&empty);
        let id = |r: &Value| r["id"].as_str().map(str::to_string);
        let mut seen: HashMap<String, f64> = rows.iter().filter_map(|r| Some((id(r)?, r["read_at"].as_f64()?))).collect();
        let over = rows.iter().filter(|r| r["over_at"].as_f64().is_some()).filter_map(id).collect();
        let stored = marks["read_all_at"].as_f64().unwrap_or(0.0);
        let opened_seen = LOCAL.lock().map_or(stored, |l| {
            for (k, t) in &l.0 {
                seen.entry(k.clone()).or_insert(*t);
            }
            l.1.max(stored)
        });
        Cleared { seen, opened_seen, over }
    }

    /// The owner saw it: opened, clicked or dismissed anywhere, or "Mark all read" after it came.
    pub fn read(&self, e: &Value) -> bool {
        self.seen.contains_key(e["id"].as_str().unwrap_or("")) || e["ts"].as_f64().unwrap_or(0.0) <= self.opened_seen
    }

    /// Read, or its issue over: no popup for it any more.
    pub fn of(&self, e: &Value) -> bool {
        self.read(e) || e["id"].as_str().is_some_and(|i| self.over.contains(i))
    }
}

/// The owner cleared it here (clicked or dismissed): recorded in Aico in the background, counted here at once.
pub fn mark_seen(id: &str) {
    if !valid_entry_id(id) {
        return;
    }
    mark_read_pressed_bg(&[id.to_string()], "tray");
}

/// Where a notification may open: Aico itself, and the other apps the site file allows (urls.open_hosts).
fn open_hosts() -> Vec<String> {
    let site: Vec<String> = std::fs::read("/etc/aico/site.json").ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v["urls"]["open_hosts"].as_array().map(|a| a.iter().filter_map(|h| h.as_str().map(str::to_string)).collect()))
        .unwrap_or_default();
    std::iter::once(crate::status_host()).filter(|h| !h.is_empty()).chain(site).collect()
}

/// The other app an agent's push points at (refs.open, e.g. its Aico session or share): opened 
/// Only an https link on an allowed host, checked again here.
pub fn open_link(e: &Value) -> Option<String> {
    link_on(e["refs"]["open"].as_str()?, &open_hosts())
}

fn link_on(url: &str, hosts: &[String]) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let host = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    let ok = url.len() <= 300 && !host.is_empty() && !host.contains('@')
        && url.chars().all(|c| c.is_ascii_graphic()) && hosts.iter().any(|h| h == host);
    ok.then(|| url.to_string())
}

/// A push body as the desktop shows it: without the phone's closing "Tap to answer." (as web/notices._page_body drops
/// "Tap ..."), nor, for an agent's question answered in the card (`ask`), "Open Aico to answer it.". Only a last
/// sentence ending the body, with no command in it, is dropped.
pub fn desk_body(body: &str, ask: bool) -> String {
    let b = body.trim_end();
    let leads: &[&str] = if ask { &["Tap to ", "Tap for ", "Open Aico to "] } else { &["Tap to ", "Tap for "] };
    for lead in leads {
        if let Some(i) = b.rfind(lead) {
            let tail = &b[i..];
            let one = tail.ends_with('.') && !tail[..tail.len() - 1].contains(['.', '!', '?', '\n', '`']);
            let starts = i == 0 || b[..i].trim_end().ends_with(['.', '!', '?']) || b[..i].ends_with('\n');
            if one && starts {
                return b[..i].trim_end().to_string();
            }
        }
    }
    b.to_string()
}

/// The Status page, where Aico keeps what is wrong (there is no page per notification).
pub fn url(_id: &str) -> String {
    let host = crate::status_host();
    if host.is_empty() { String::new() } else { format!("https://{host}/status") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cleared() -> Cleared {
        Cleared { seen: HashMap::from([("cccccccccccc".to_string(), 1.0)]), opened_seen: 15.0, over: HashSet::from(["111111111111".into()]) }
    }

    #[test]
    fn a_quiet_entry_pops_no_card() {
        let log = json!([
            {"id": "aaaaaaaaaaaa", "ts": 10.0, "kind": "manual", "result": "desktop-popup", "quiet": true},
            {"id": "bbbbbbbbbbbb", "ts": 20.0, "kind": "manual", "result": "desktop-popup"}]);
        let ids: Vec<&str> =
            to_show(&log, 5.0, &HashMap::new(), &cleared()).iter().map(|e| e["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["bbbbbbbbbbbb"]);
    }

    #[test]
    fn shows_new_final_pushes_once_and_never_cleared_ones() {
        let log = json!([
            {"id": "aaaaaaaaaaaa", "ts": 10.0, "kind": "finding", "result": "sent 1/1"},
            {"id": "bbbbbbbbbbbb", "ts": 20.0, "kind": "finding", "result": "held"},
            {"id": "cccccccccccc", "ts": 30.0, "kind": "finding", "result": "held"},
            {"id": "dddddddddddd", "ts": 40.0, "kind": "approve", "result": "sent 1/1"},
            {"id": "eeeeeeeeeeee", "ts": 50.0, "kind": "cost", "result": "pending"},
            {"id": "ffffffffffff", "ts": 60.0, "kind": "cost", "result": "quieted"},
            {"id": "111111111111", "ts": 70.0, "kind": "manual", "result": "desktop-popup", "key": "k-gone"},
            {"id": "222222222222", "ts": 80.0, "kind": "manual", "result": "desktop-popup"},
            {"id": "../etc", "ts": 90.0, "kind": "manual", "result": "sent 1/1"}]);
        let shown = HashMap::from([("222222222222".to_string(), 7u32)]);
        let ids: Vec<&str> = to_show(&log, 5.0, &shown, &cleared()).iter().map(|e| e["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["bbbbbbbbbbbb"]); // a is older than the last open of the notifications page, c seen, d an ask, e not final, ...
    }

    #[test]
    fn unread_counts_only_pushes_that_went_out_and_nobody_cleared() {
        let log = json!([
            {"id": "aaaaaaaaaaaa", "ts": 10.0, "kind": "finding", "result": "sent 2/2"},
            {"id": "bbbbbbbbbbbb", "ts": 20.0, "kind": "approve", "result": "sent 1/1"},
            {"id": "cccccccccccc", "ts": 25.0, "kind": "manual", "result": "sent 1/1"},
            {"id": "dddddddddddd", "ts": 30.0, "kind": "manual", "result": "suppressed"},
            {"id": "eeeeeeeeeeee", "ts": 40.0, "kind": "manual", "result": "sent 2/2"},
            {"id": "ffffffffffff", "ts": 50.0, "kind": "cost", "result": "quieted"},
            {"id": "111111111111", "ts": 60.0, "kind": "finding", "result": "held", "key": "k-gone"}]);
        let mut cl = Cleared { seen: HashMap::new(), opened_seen: 5.0, over: HashSet::new() };
        assert_eq!(unread(&log, &cl), 4);
        cl.opened_seen = 15.0; // Mark all read at 15
        assert_eq!(unread(&log, &cl), 3);
        cl.seen.insert("cccccccccccc".into(), 1.0); // read on the phone
        cl.over.insert("111111111111".into()); // its issue is over
        assert_eq!(unread(&log, &cl), 1);
    }

    #[test]
    fn the_moon_counts_the_items_the_tray_rule_lists_until_read() {
        let log = json!([
            {"id": "aaaaaaaaaaaa", "ts": 10.0, "kind": "manual", "result": "sent 1/1", "key": "k-over"},
            {"id": "bbbbbbbbbbbb", "ts": 20.0, "kind": "manual", "result": "sent 1/1"},
            {"id": "cccccccccccc", "ts": 30.0, "kind": "finding", "result": "sent 1/1"},
            {"id": "dddddddddddd", "ts": 40.0, "kind": "manual", "result": "sent 1/1"}]); // info: not a listed item
        let rows = vec![vec!["aaaaaaaaaaaa".to_string()], vec!["bbbbbbbbbbbb".into(), "cccccccccccc".into()],
                        vec!["999999999999".into()]]; // pruned from the log: read
        let mut cl = Cleared { seen: HashMap::new(), opened_seen: 5.0, over: HashSet::from(["aaaaaaaaaaaa".into()]) };
        assert_eq!(unread_items(&rows, &log, &cl), 1); // an issue that ended before it was seen is not new
        cl.seen.insert("bbbbbbbbbbbb".into(), 1.0);
        assert_eq!(unread_items(&rows, &log, &cl), 1); // its older push is still unread
        cl.seen.insert("cccccccccccc".into(), 1.0);
        assert_eq!(unread_items(&rows, &log, &cl), 0);
    }

    #[test]
    fn an_issue_that_ended_before_it_was_read_is_not_new() {
        // the push came, its issue ended before the owner read it: the item store still lists the row's push as unread
        // for another reason (older push), but the ended one alone never counts, read or not
        let log = json!([{"id": "aaaaaaaaaaaa", "ts": 10.0, "kind": "finding", "result": "sent 1/1", "key": "k-over"}]);
        let rows = vec![vec!["aaaaaaaaaaaa".to_string()]];
        let cl = Cleared { seen: HashMap::new(), opened_seen: 0.0, over: HashSet::from(["aaaaaaaaaaaa".into()]) };
        assert!(!cl.read(&log[0]) && cl.of(&log[0]));
        assert_eq!(unread_items(&rows, &log, &cl), 0);
        assert_eq!(unread(&log, &cl), 0);
        let open = Cleared::default();
        assert_eq!(unread_items(&rows, &log, &open), 1); // still open (not over): new until read
    }

    #[test]
    fn shares_belong_to_aico_and_never_push_others_out() {
        let mut entries: Vec<Value> = (0..10).map(|i| json!({"id": format!("{i:012x}"), "ts": 100.0 + i as f64,
            "kind": "manual", "severity": "info", "title": format!("Shared: report {i}"), "result": "sent 1/1"})).collect();
        entries.insert(0, json!({"id": "aaaaaaaaaaaa", "ts": 10.0, "kind": "finding", "severity": "warning",
                                 "title": "Browser VM is down", "result": "sent 1/1"}));
        entries.push(json!({"id": "bbbbbbbbbbbb", "ts": 200.0, "kind": "manual", "severity": "info",
                            "title": "Shared notes are ready", "result": "sent 1/1"})); // not a share: no "Shared: "
        let log = Value::Array(entries);
        let cl = Cleared::default();
        assert_eq!(unread(&log, &cl), 2);
    }

    #[test]
    fn ages_read_plainly() {
        assert_eq!(ago(20.0), "just now");
        assert_eq!(ago(600.0), "10 min ago");
        assert_eq!(ago(7200.0), "2 h ago");
        assert_eq!(ago(5400.0), "2 h ago");
        assert_eq!(ago(3.0 * 86400.0), "3 days ago");
    }

    #[test]
    fn agent_pushes_open_only_allowed_https_links() {
        let hosts = vec!["aico.example".to_string()];
        assert_eq!(link_on("https://aico.example/?session=0f442411", &hosts).as_deref(), Some("https://aico.example/?session=0f442411"));
        assert_eq!(link_on("https://aico.example", &hosts).as_deref(), Some("https://aico.example"));
        for bad in ["http://aico.example/", "https://evil.example/", "https://aico.example.evil/", "https://x@aico.example/",
                    "https://aico.example:444/", "https://aico.example/ a", "javascript:alert(1)"] {
            assert_eq!(link_on(bad, &hosts), None, "{bad}");
        }
        assert_eq!(link_on(&format!("https://aico.example/{}", "a".repeat(300)), &hosts), None);
        assert_eq!(open_link(&json!({"refs": {}})), None);
        assert_eq!(desk_body("Auth config changed. Tap to answer.", false), "Auth config changed.");
        let q = "\u{201c}Aico\u{201d} has a question for you. Open Aico to answer it.";
        assert_eq!(desk_body(q, true), "\u{201c}Aico\u{201d} has a question for you.");
        assert_eq!(desk_body(q, false), q); // no card answers it: Aico is where to go
        assert_eq!(desk_body("Tap to decide.", false), "");
        for kept in ["Tap to answer. Then it is recorded.", "Disk 95% full.", "Reboot report.\nTap to retry\nfoo: bar",
                     "Done. Tap to run `st backup now`.", "Check it. Tap to retry", "Stop. Then tap to go."] {
            assert_eq!(desk_body(kept, false), kept);
        }
    }

    #[test]
    fn reads_here_count_at_once() {
        note_local(&["aaaaaaaaaaaa"], None);
        let cl = Cleared::of_marks(&Value::Null);
        assert!(cl.read(&json!({"id": "aaaaaaaaaaaa", "ts": 1e12})));
        assert!(!cl.read(&json!({"id": "bbbbbbbbbbbb", "ts": 1e12})));
    }

    #[test]
    fn the_store_read_gives_the_log_and_what_was_cleared() {
        let items = json!({"read_marks": {"read_all_at": 15.0, "pushes": [
            {"id": "aaaaaaaaaaaa", "ts": 10.0, "item": null, "read_at": 15.0, "over_at": null,
             "push": {"id": "aaaaaaaaaaaa", "ts": 10.0, "kind": "finding", "result": "sent 1/1", "title": "A"}},
            {"id": "bbbbbbbbbbbb", "ts": 20.0, "item": "x", "read_at": 21.0, "over_at": null,
             "push": {"id": "bbbbbbbbbbbb", "ts": 20.0, "kind": "finding", "result": "sent 1/1", "title": "B"}},
            {"id": "cccccccccccc", "ts": 30.0, "item": "y", "read_at": null, "over_at": 31.0,
             "push": {"id": "cccccccccccc", "ts": 30.0, "kind": "finding", "result": "held", "title": "C", "key": "k"}},
            {"id": "dddddddddddd", "ts": 40.0, "item": null, "read_at": null, "over_at": null,
             "push": {"id": "dddddddddddd", "ts": 40.0, "kind": "manual", "result": "sent 1/1", "title": "D"}}]}});
        let log = log_of(&items);
        assert_eq!(log.as_array().unwrap().len(), 4);
        let cl = Cleared::of_marks(&items["read_marks"]);
        assert!(cl.opened_seen >= 15.0);
        let read: Vec<bool> = log.as_array().unwrap().iter().map(|e| cl.read(e)).collect();
        assert_eq!(read, [true, true, false, false]); // c's issue is over, not read
        let gone: Vec<bool> = log.as_array().unwrap().iter().map(|e| cl.of(e)).collect();
        assert_eq!(gone, [true, true, true, false]); // but it is cleared: no popup for it, and not new
        assert_eq!(unread(&log, &cl), 1); // the fallback count (no tray rows): over or read is not new
        assert!(log_of(&json!({"read_marks": {"pushes": [{"id": "aaaaaaaaaaaa", "read_at": null}]}})).as_array().unwrap().is_empty());
        assert!(log_of(&json!({"v": 1})).is_null()); // an older store: no pushes in the read
    }
}
