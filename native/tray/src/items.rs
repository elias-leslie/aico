//! What the tray reads from Aico: aico-web's tray door (aico.rs, `GET /api/tray`), one answer in the shape
//! `nightshift inbox --json` had: the panel's lists (needs, approvals, questions, notifications), the frame (snapshot,
//! health, counts, links), the badge summary (`summary`) and the push log with its read marks (`read_marks`). The door
//! builds every word from Aico's Status, asks and notices at the moment of the read; nothing here computes one.

use serde_json::{json, Value};

/// The door's format version this reader knows (packages/web-server/src/tray.ts).
const API_V: u64 = 1;

/// One read of the door. Blocks: never call it on the GTK thread.
pub fn read() -> Result<Value, String> {
    let v = crate::aico::get("/api/tray")?;
    match v["version"].as_u64() {
        Some(API_V) => {
            crate::set_status_host(v["links"]["dashboard"].as_str().unwrap_or(""));
            Ok(v)
        }
        other => Err(format!("Aico answered in a format this tray doesn't know (version {})",
                             other.map_or("missing".into(), |n| n.to_string()))),
    }
}

/// The tray icon's summary (`summary`: needs_you, snapshot, health, grant_labels, unread_rows) with `at`, the time
/// of the read, for published::needs_you's age rule. Null (unknown) when the read failed.
pub fn tray_summary(read: &Result<Value, String>) -> Value {
    match read {
        Ok(v) if v["summary"].is_object() => {
            let mut t = v["summary"].clone();
            t["at"] = json!(v["at"].as_f64().unwrap_or(0.0));
            t
        }
        _ => Value::Null,
    }
}

/// Why the summary is unknown, for the log (None when it is known).
pub fn tray_unknown_why(read: &Result<Value, String>) -> Option<String> {
    match read {
        Err(e) => Some(e.clone()),
        Ok(v) => (!v["summary"].is_object()).then(|| "Aico gave no tray summary".into()),
    }
}


#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::published::{self, NeedsYou};

    /// What aico-web's tray door answered for the scene in packages/web-server/src/tray.test.ts (that test keeps this
    /// file equal to the door's answer; UPDATE_TRAY_FIXTURE=1 rewrites it).
    pub fn tray_sample() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/tray-sample.json")).unwrap()
    }

    #[test]
    fn the_panel_lists_what_the_door_answered() {
        let d = tray_sample();
        let lines = crate::panel::lines(&d, &crate::panel::questions(&d), 1_793_793_600.0, |_| None);
        let heads: Vec<String> = lines.iter().filter_map(|l| match l {
            crate::panel::Line::Head(h) => Some(h.clone()),
            _ => None,
        }).collect();
        assert_eq!(heads, ["NEEDS YOU (2)", "APPROVALS (1)", "QUESTIONS (1)", "NOTIFICATIONS (1 NEW)"]);
        let titles: Vec<&str> = lines.iter().filter_map(|l| match l {
            crate::panel::Line::Item(i) => Some(i.title.as_str()),
            _ => None,
        }).collect();
        assert_eq!(titles, ["Trends failed", "Sudo use warning", "Open GitHub admin for 30 min?", "Ship it?", "Disk full"]);
        // a problem's Open goes to the Status page; the approval keeps its key action
        let acts = |n: usize| match &lines.iter().filter(|l| matches!(l, crate::panel::Line::Item(_))).nth(n) {
            Some(crate::panel::Line::Item(i)) => i.actions.clone(),
            _ => vec![],
        };
        assert_eq!(acts(0)[0]["id"], "open");
        assert!(acts(0)[0]["url"].as_str().unwrap().ends_with("/status"));
        assert_eq!(acts(2)[0]["id"], "approve");
        assert_eq!(acts(2)[0]["tier"], "key");
        assert_eq!(crate::panel::summary(&d, &crate::panel::questions(&d)), "2 need you · 1 approval waiting · 1 question · 1 unread");
    }

    #[test]
    fn the_badge_counts_open_problems_and_ended_alerts_count_as_nothing() {
        let d = tray_sample();
        let now = d["at"].as_f64().unwrap();
        let r = Ok(d.clone());
        let sum = tray_summary(&r);
        assert_eq!(published::needs_you(&sum, now + 5.0), NeedsYou::Count(2));
        // the one unread report is the only row; the VPN alert that came back is not in it
        let rows = published::unread_rows(&sum, now + 5.0).unwrap();
        assert_eq!(rows.len(), 1);
        let log = crate::notices::log_of(&d);
        let cleared = crate::notices::Cleared::of_marks(&d["read_marks"]);
        assert_eq!(crate::notices::unread_items(&rows, &log, &cleared), 1);
        let ended: Vec<&Value> = d["read_marks"]["pushes"].as_array().unwrap().iter().filter(|p| p["over_at"].is_number()).collect();
        assert_eq!(ended.len(), 1);
        let gone = &ended[0]["push"];
        assert_eq!(gone["title"], "VPN down");
        assert!(cleared.of(gone), "the ended alert gets no card and counts as nothing");
        assert!(crate::notices::to_show(&log, 0.0, &Default::default(), &cleared).iter().all(|e| e["title"] != "VPN down"));
        assert_eq!(sum["grant_labels"]["github-admin"], "GitHub admin");
        // the last good read is too old: unknown, never the old count
        assert_eq!(published::needs_you(&sum, now + published::SUMMARY_MAX_AGE_S + 1.0), NeedsYou::Unknown);
    }

    #[test]
    fn a_failed_or_unknown_read_is_unknown_never_zero() {
        let bad: Result<Value, String> = Err("Aico isn't answering on port 3002 (refused)".into());
        let now = 1_793_793_600.0;
        assert_eq!(published::needs_you(&tray_summary(&bad), now), NeedsYou::Unknown);
        assert_eq!(tray_unknown_why(&bad).as_deref(), Some("Aico isn't answering on port 3002 (refused)"));
        assert_eq!(published::unread_rows(&tray_summary(&bad), now), None);
        let none = Ok(json!({"version": 1, "at": now}));
        assert_eq!(published::needs_you(&tray_summary(&none), now), NeedsYou::Unknown);
        assert!(tray_unknown_why(&none).is_some());
        let mut missing = tray_sample();
        missing["summary"]["snapshot"] = json!("missing");
        assert_eq!(published::needs_you(&tray_summary(&Ok(missing)), now), NeedsYou::Stale);
        assert!(tray_unknown_why(&Ok(tray_sample())).is_none());
    }

    #[test]
    fn questions_are_unknown_when_tether_cannot_be_read() {
        let mut d = tray_sample();
        assert_eq!(crate::panel::questions(&d).unwrap()[0]["question"], "Ship it?");
        d["questions_unknown"] = json!("Tether can't be read (refused)");
        assert_eq!(crate::panel::questions(&d).unwrap_err(), "Tether can't be read (refused)");
        assert!(crate::panel::questions(&json!({})).is_err()); // no list at all: unknown, never none
    }

    #[test]
    fn the_door_host_becomes_the_status_host() {
        crate::set_status_host("https://aico.example.dev/status");
        assert_eq!(crate::status_host(), "aico.example.dev");
        crate::set_status_host("not a link");
        crate::set_status_host("https://evil host/");
        assert_eq!(crate::status_host(), "aico.example.dev"); // a bad link changes nothing
    }
}
