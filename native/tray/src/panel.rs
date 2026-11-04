//! The inbox panel (`aico-tray panel`): one scrollable window above the tray, in the approval card's place and
//! style, so problems, approvals and questions need no website. Sections: Needs you (the open Status problems),
//! Approvals (open asks), Questions (agents' Tether asks), Notifications (agent reports nobody has read). Everything
//! comes from aico-web's tray door (`GET /api/tray`, items.rs), whose words the Status page shows too, so both say
//! the same: the panel adds no wording of its own to a row. A choice is answered here over Tether's socket (ask.rs).
//! A row shows severity, title, two or three lines and its age and source; Enter or a click expands it in place (the
//! notification card's own parts: notice.rs) with its actions, which come with the data (id, label, tier). Approve is
//! the only key-tier action: it opens the approval card. Open goes to the item's own place; Mark read is view state.
//! Header: Status, Mark all read, close. Escape closes; the arrows move between rows. It re-reads every 15 seconds
//! while open, and at once when Tether's feed changes.

use crate::notice::{self, label, s};
use crate::{ask, browser, notices, published};
use gtk::glib;
use gtk::prelude::*;
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::SystemTime;

const WIDTH: i32 = 560;
const CSS: &str = "
.ns-panel list { background-color: transparent; }
.ns-panel row.ns-item { border-radius: 10px; padding: 10px 12px; margin: 2px 0; background-color: #151922; }
.ns-panel row.ns-item:hover { background-color: #1b2130; }
.ns-panel row.ns-item:focus { outline: 2px solid #ffe08a; outline-offset: -2px; }
.ns-panel button:focus-visible { outline: 2px solid #ffe08a; outline-offset: 1px; }
.ns-panel button.ns-quick { padding: 0 8px; min-height: 0; }
.ns-panel row.ns-item.ns-open { background-color: #181c25; border: 1px solid #2b3242; }
.ns-panel row.ns-head { padding: 12px 4px 4px 4px; }
.ns-panel label.ns-sect { color: #a3abbc; font-size: 0.82em; font-weight: 600; letter-spacing: 1px; }
.ns-panel label.ns-row-t { font-weight: bold; }
.ns-panel label.ns-sev { font-size: 0.78em; font-weight: bold; border-radius: 6px; padding: 1px 6px; }
.ns-panel label.ns-sev.ns-critical { background-color: #341719; color: #ff8f8f; }
.ns-panel label.ns-sev.ns-warning { background-color: #2a2414; color: #f2b552; }
.ns-panel label.ns-sev.ns-info { background-color: #152238; color: #86b4ff; }
.ns-panel label.ns-sev.ns-ok { background-color: #14291d; color: #5fd08f; }
.ns-panel label.ns-dot { color: #86b4ff; font-weight: bold; }
.ns-panel label.ns-pill { font-size: 0.8em; border: 1px solid #4a5468; border-radius: 6px; padding: 0 5px; color: #c3c9d6; }
.ns-panel label.ns-pill.ns-p-open { border-color: #6b5a2f; color: #f2b552; }
.ns-panel label.ns-pill.ns-p-ok { border-color: #2f6b49; color: #5fd08f; }
.ns-panel label.ns-handoff { color: #86b4ff; font-size: 0.88em; }
";

/// One line of the panel: a section heading or an item.
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)] // a few dozen lines per read, built once and compared
pub enum Line {
    Head(String),
    Item(Item),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub key: String, // unique in the panel: section + id, keeps a row open across a re-read
    pub severity: String,
    pub title: String,
    pub text: String,
    pub meta: String,
    pub pills: Vec<(String, String)>,
    pub unread: bool,
    pub actions: Vec<Value>,
    pub card: Value,          // the notification card's parts (GET /api/tray/notice/ID), Null when none
    pub more: Vec<String>,    // lines shown expanded when there is no card
    pub question: Value,      // an agent's question (Tether ask), Null otherwise
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

fn count(n: usize, one: &str, many: &str) -> String {
    if n == 1 { format!("1 {one}") } else { format!("{n} {many}") }
}

fn sev_word(s: &str) -> &'static str {
    match s {
        "critical" => "Critical",
        "warning" => "Warning",
        "ok" => "OK", // over: resolved, cleared or acknowledged (its card's severity now)
        _ => "Info",
    }
}

/// The header line: what waits, said as the tray says it (an unknown part says unknown, never zero).
pub fn summary(data: &Value, questions: &Result<Vec<Value>, String>) -> String {
    let c = &data["counts"];
    let mut parts = Vec::new();
    parts.push(match c["needs"].as_u64() {
        Some(0) => "nothing needs you".into(),
        Some(n) => if n == 1 { "1 needs you".into() } else { format!("{n} need you") },
        None => "Needs you unknown".into(),
    });
    match c["approvals"].as_u64() {
        Some(0) => {}
        Some(n) => parts.push(count(n as usize, "approval waiting", "approvals waiting")),
        None => parts.push("approvals unknown".into()),
    }
    match questions {
        Ok(q) => {
            let open = q.iter().filter(|a| a["state"] == "open").count();
            if open > 0 {
                parts.push(count(open, "question", "questions"));
            }
        }
        Err(_) => parts.push("questions unknown".into()),
    }
    // the Notifications the tray rule keeps: problems still open, and what the owner hasn't read
    if let Some(n) = c["open"].as_u64().filter(|n| *n > 0) {
        parts.push(format!("{n} still open"));
    }
    match c["unread"].as_u64() {
        Some(0) => {}
        Some(n) => parts.push(format!("{n} unread")),
        None => parts.push("notifications unknown".into()),
    }
    let t = parts.join(" · ");
    let mut ch = t.chars();
    ch.next().map(|f| f.to_uppercase().chain(ch).collect()).unwrap_or_default()
}

/// Where an Aico question opens: Aico's own page for the ask.
fn aico_link(id: &str) -> Option<String> {
    let host = crate::status_host();
    (!host.is_empty()).then(|| format!("https://{host}/?ask={id}"))
}

/// The panel's lines from the inbox data and Tether's questions, in order. Every word on a row is the data's own.
pub fn lines(data: &Value, questions: &Result<Vec<Value>, String>, now: f64, link: impl Fn(&str) -> Option<String>) -> Vec<Line> {
    let mut out = Vec::new();
    let empty = Vec::new();
    // no lists at all (Aico couldn't be read): an empty section says unknown, never nothing
    let known = data["needs"].is_array();
    let needs = data["needs"].as_array().unwrap_or(&empty);
    // A section that is known to be empty says nothing (one line below covers all four); one that may not be says
    // unknown, never nothing.
    let mut quiet = 0;
    match (known, needs.len()) {
        (false, _) => out.push(Line::Head("NEEDS YOU · UNKNOWN".into())),
        (true, 0) => quiet += 1,
        (true, n) => out.push(Line::Head(format!("NEEDS YOU ({n})"))),
    }
    for n in needs {
        let mut meta = vec![s(n, "host").to_string(), format!("open {}", s(n, "age_text"))];
        meta.retain(|m| !m.is_empty() && m != "open ");
        let text = strs(&n["text"]);
        out.push(Line::Item(Item {
            key: format!("need:{}", s(n, "key")), severity: s(n, "severity").into(), title: s(n, "title").into(),
            text: text.first().cloned().unwrap_or_default(), meta: meta.join(" · "), pills: vec![],
            unread: n["unread"].as_array().is_some_and(|a| !a.is_empty()),
            actions: n["actions"].as_array().cloned().unwrap_or_default(), card: n["card"].clone(),
            more: [text, vec![s(n, "answered").to_string()]].concat().into_iter().filter(|l| !l.is_empty()).collect(),
            question: Value::Null,
        }));
    }
    let asks = data["approvals"].as_array().unwrap_or(&empty);
    match (data["approvals"].is_array(), asks.len()) {
        (false, _) => out.push(Line::Head("APPROVALS · UNKNOWN".into())),
        (true, 0) => quiet += 1,
        (true, n) => out.push(Line::Head(format!("APPROVALS ({n})"))),
    }
    for a in asks {
        out.push(Line::Item(Item {
            key: format!("ask:{}", s(a, "id")), severity: "warning".into(), title: s(a, "title").into(),
            text: notices::desk_body(s(a, "body"), false), meta: s(a, "left_text").into(), pills: vec![],
            unread: true, actions: a["actions"].as_array().cloned().unwrap_or_default(), card: Value::Null, more: vec![],
            question: Value::Null,
        }));
    }
    // the door lists open asks only
    let live: Result<Vec<&Value>, &String> = questions.as_ref().map(|qs| qs.iter().filter(|q| s(q, "state") == "open").collect());
    match live {
        Err(e) => out.push(Line::Head(format!("QUESTIONS · UNKNOWN ({e})"))),
        Ok(qs) if qs.is_empty() => quiet += 1,
        Ok(qs) => {
            out.push(Line::Head(format!("QUESTIONS ({})", qs.len())));
            for q in qs {
                let who = q["requester"].as_str().unwrap_or("An agent"); // no session id: the owner reads it
                let age = notices::ago(now - q["createdAt"].as_f64().unwrap_or(0.0) / 1000.0);
                let state = match s(q, "state") {
                    "answered" => format!("you answered: {}", q["answer"].as_str().or(q["note"].as_str()).unwrap_or("a note")),
                    _ if q["blocking"] == true => "the agent is waiting".into(),
                    _ => "waiting for your answer".into(),
                };
                let mut actions = Vec::new();
                if let Some(url) = link(s(q, "id")) {
                    actions.push(json!({"id": "open", "label": "Open in Aico", "tier": "view", "url": url,
                                        "hint": "The question in Aico, where the agent asked it."}));
                }
                out.push(Line::Item(Item {
                    key: format!("q:{}", s(q, "id")), severity: if q["blocking"] == true { "warning" } else { "info" }.into(),
                    title: s(q, "question").into(), text: s(q, "body").into(), meta: format!("{who} · {age} · {state}"),
                    pills: vec![], unread: s(q, "state") == "open", actions, card: Value::Null,
                    more: vec![], question: (*q).clone(),
                }));
            }
        }
    }
    let rows = data["notifications"].as_array().unwrap_or(&empty);
    // the rows here that are new (pushes listed under Needs you or past the website's cap count in the summary only)
    let unread = rows.iter().filter(|r| r["unread"].as_array().is_some_and(|a| !a.is_empty())).count();
    match (rows.is_empty(), unread) {
        _ if !data["notifications"].is_array() => out.push(Line::Head("NOTIFICATIONS · UNKNOWN".into())),
        (true, _) => quiet += 1,
        (false, 0) => out.push(Line::Head("NOTIFICATIONS · NOTHING NEW".into())),
        (false, n) => out.push(Line::Head(format!("NOTIFICATIONS ({n} NEW)"))),
    }
    for r in rows {
        let mut meta = vec![notices::ago(now - r["ts"].as_f64().unwrap_or(0.0))];
        if !s(r, "asked").is_empty() {
            meta.push(s(r, "asked").into());
        }
        if r["pushes"].as_u64().unwrap_or(1) > 1 {
            meta.push(format!("{} pushes", r["pushes"]));
        }
        out.push(Line::Item(Item {
            key: format!("n:{}", s(r, "id")), severity: s(r, "severity").into(), title: s(r, "title").into(),
            text: notices::desk_body(s(r, "body"), false), meta: meta.join(" · "),
            pills: r["pills"].as_array().unwrap_or(&empty).iter().map(|p| (s(p, "label").to_string(), s(p, "cls").to_string())).collect(),
            unread: r["unread"].as_array().is_some_and(|a| !a.is_empty()),
            actions: r["actions"].as_array().cloned().unwrap_or_default(), // an agent's question is under Questions
            card: r["card"].clone(), more: vec![], question: Value::Null,
        }));
    }
    if quiet == 4 {
        out.push(Line::Head("NOTHING WAITING".into())); // all four known empty: one line, not four
    }
    out
}

enum Msg {
    Data(u64, Result<Value, String>, Result<Vec<Value>, String>),
    Answered(String, Result<Value, String>),
    Marked(String, Result<(), String>),
}

struct Panel {
    win: gtk::Window,
    list: gtk::ListBox,
    scroll: gtk::ScrolledWindow,
    summary: gtk::Label,
    health: gtk::Label,
    more: gtk::Button,
    data: RefCell<Value>,
    questions: RefCell<Questions>,
    expanded: RefCell<HashSet<String>>,
    // a row's own line after an action (handed over, refused, sent), until the read numbered .1 (u64::MAX: kept)
    status: RefCell<HashMap<String, (String, u64)>>,
    gen: Cell<u64>, // reads started
    shown: RefCell<Vec<String>>, // what each listed row was built from, in order
    rows: RefCell<HashMap<String, (String, gtk::ListBoxRow)>>, // rows kept while unchanged (an answer being picked)
    loading: Cell<bool>,
    again: Cell<bool>,
    busy: Cell<bool>,
    sig: RefCell<Vec<f64>>,
    cap: Cell<i32>, // the list's tallest before it scrolls
    hover: Cell<bool>, // the pointer is over the panel: rows are not added, removed or moved under it
    held: RefCell<Option<(Value, Questions)>>, // a read that would move rows, shown once the pointer leaves
    then: RefCell<Option<(String, String)>>,
    tx: async_channel::Sender<Msg>,
    main: glib::MainLoop,
}

type Shared = Rc<Panel>;
type Questions = Result<Vec<Value>, String>;

fn log(msg: impl AsRef<str>) {
    eprintln!("panel: {}", msg.as_ref());
}

/// The files whose change means the panel's data may have changed: Tether's feed (a new or answered question).
fn watched() -> Vec<std::path::PathBuf> {
    vec![published::aico_feed_path()]
}

/// The line under the header: a stale status snapshot first, then the health line.
pub fn health_line(data: &Value) -> String {
    let mut health = s(data, "health").to_string();
    if !matches!(s(data, "snapshot"), "fresh" | "") {
        health = format!("Status snapshot is {}: states may be out of date. {health}", s(data, "snapshot"));
    }
    health.trim_end().to_string()
}

fn signature() -> Vec<f64> {
    watched().iter().map(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok()
        .and_then(|m| m.duration_since(SystemTime::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64())).collect()
}

fn load(p: &Shared) {
    if p.loading.replace(true) {
        p.again.set(true);
        return;
    }
    p.again.set(false);
    *p.sig.borrow_mut() = signature();
    let (tx, g) = (p.tx.clone(), p.gen.get() + 1);
    p.gen.set(g);
    std::thread::spawn(move || {
        let data = crate::items::read();
        let qs = data.as_ref().map_err(|e| e.clone()).and_then(questions);
        let _ = tx.send_blocking(Msg::Data(g, data, qs));
    });
}

/// The agents' open questions as the tray door lists them (Tether's asks), or why that list is unknown (Tether can't
/// be read).
pub fn questions(data: &Value) -> Result<Vec<Value>, String> {
    if let Some(why) = data["questions_unknown"].as_str() {
        return Err(why.to_string());
    }
    data["questions"].as_array().cloned().ok_or_else(|| "Aico has no question list yet".to_string())
}

/// Whether the owner is typing in a row (an answer to a question): a re-read then waits, so nothing they typed is lost.
fn typing(p: &Shared) -> bool {
    gtk::prelude::GtkWindowExt::focus(&p.win).is_some_and(|w| w.is::<gtk::Text>() || w.is::<gtk::Entry>())
}

fn render(p: &Shared) {
    let data = p.data.borrow().clone();
    let qs = p.questions.borrow().clone();
    let now = crate::daemon::now();
    let focused = p.list.focus_child().and_then(|r| r.downcast::<gtk::ListBoxRow>().ok()).map(|r| r.widget_name().to_string());
    let inner = gtk::prelude::GtkWindowExt::focus(&p.win);
    let scroll = p.scroll.vadjustment().value();
    let all = lines(&data, &qs, now, aico_link);
    let prints: Vec<String> = all.iter().map(|l| print(p, l)).collect();
    p.summary.set_text(&summary(&data, &qs));
    let mut health = health_line(&data);
    if let Some((t, _)) = p.status.borrow().get("") {
        // the panel's own line (Mark all read that was not recorded), until the panel closes
        health = if health.is_empty() { t.clone() } else { format!("{t} · {health}") };
    }
    p.health.set_text(&health);
    p.health.set_visible(!health.is_empty());
    // the link under the list (inbox.elsewhere)
    p.more.set_label(&match data["elsewhere"].as_str() {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => "Open the Status page".into(),
    });
    if *p.shown.borrow() == prints {
        return; // nothing on the list changed: no row is rebuilt (a choice being made in one stays)
    }
    while let Some(c) = p.list.first_child() {
        p.list.remove(&c);
    }
    let opening = p.shown.borrow().is_empty();
    let mut top: Option<gtk::ListBoxRow> = None;
    let mut kept = std::mem::take(&mut *p.rows.borrow_mut());
    let mut rows = HashMap::new();
    let mut restore = None;
    for (line, fp) in all.iter().zip(&prints) {
        match line {
            Line::Head(t) => {
                let row = gtk::ListBoxRow::new();
                row.set_activatable(false);
                row.set_selectable(false);
                row.set_can_focus(false);
                row.add_css_class("ns-head");
                row.set_child(Some(&label(t, "ns-sect")));
                p.list.append(&row);
            }
            Line::Item(it) => {
                let row = match kept.remove(&it.key) {
                    Some((old, row)) if old == *fp => row,
                    _ => item_row(p, it),
                };
                if focused.as_deref() == Some(it.key.as_str()) {
                    restore = Some(row.clone());
                }
                p.list.append(&row);
                top.get_or_insert_with(|| row.clone());
                rows.insert(it.key.clone(), (fp.clone(), row));
            }
        }
    }
    *p.rows.borrow_mut() = rows;
    *p.shown.borrow_mut() = prints;
    match (inner.filter(|w| w.root().is_some()), restore) {
        // the first list: the top row takes the keyboard, so the arrows and Enter work before any click (GTK gave it
        // to the header's first button when the window mapped, before there were rows)
        _ if opening && top.is_some() => {
            if let Some(r) = top {
                r.grab_focus(); // a row's ring follows focus (:focus), so it shows before any key
            }
        }
        (Some(w), _) => {
            w.grab_focus();
        }
        (None, Some(r)) => {
            r.grab_focus();
        }
        _ => {}
    }
    let p2 = p.clone();
    glib::idle_add_local_once(move || {
        fit(&p2);
        p2.scroll.vadjustment().set_value(scroll);
    });
}

/// What a row is built from: the same print, the same row. An open row's age is left out (it would rebuild it each
/// minute, and the choice being made in it with it).
fn print(p: &Shared, l: &Line) -> String {
    match l {
        Line::Head(t) => format!("head:{t}"),
        Line::Item(it) => {
            let open = p.expanded.borrow().contains(&it.key);
            let said = p.status.borrow().get(&it.key).map(|x| x.0.clone()).unwrap_or_default();
            let it = Item { meta: if open { String::new() } else { it.meta.clone() }, ..it.clone() };
            format!("{}\u{1f}{open}|{said}|{it:?}", it.key) // its key first (moves())
        }
    }
}

/// As tall as its rows, up to the cap, then it scrolls (a shown window keeps its size unless told: notice.rs fit).
fn fit(p: &Shared) {
    let w = if p.list.width() > 0 { p.list.width() } else { WIDTH - 32 };
    let (_, natural, _, _) = p.list.measure(gtk::Orientation::Vertical, w);
    let cap = p.cap.get();
    p.scroll.set_min_content_height(-1); // max may not go below the old min
    p.scroll.set_max_content_height(natural.clamp(1, cap));
    p.scroll.set_min_content_height(natural.min(cap));
    p.win.set_default_size(WIDTH, 1);
}

fn wrapped(text: &str, class: &str, lines: i32) -> gtk::Label {
    let l = label(text, class);
    l.set_selectable(false);
    l.set_max_width_chars(40); // fills the panel's width; never asks for more (a long line would widen it)
    if lines > 0 {
        l.set_lines(lines);
        l.set_ellipsize(gtk::pango::EllipsizeMode::End);
    }
    l
}

/// Whether listing these lines adds, removes or reorders rows compared with what is shown (each print starts with
/// its row's key, print()).
fn moves(shown: &[String], all: &[Line]) -> bool {
    let was: Vec<&str> = shown.iter().filter(|x| !x.starts_with("head:")).map(|x| x.split('\u{1f}').next().unwrap_or("")).collect();
    let now: Vec<&str> = all.iter().filter_map(|l| if let Line::Item(it) = l { Some(it.key.as_str()) } else { None }).collect();
    !shown.is_empty() && was != now
}

fn item_row(p: &Shared, it: &Item) -> gtk::ListBoxRow {
    let row = gtk::ListBoxRow::new();
    row.set_widget_name(&it.key);
    row.add_css_class("ns-item");
    let open = p.expanded.borrow().contains(&it.key);
    let col = gtk::Box::new(gtk::Orientation::Vertical, 4);
    let top = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    if it.unread {
        let dot = gtk::Label::new(Some("●"));
        dot.add_css_class("ns-dot");
        dot.set_valign(gtk::Align::Start);
        dot.set_tooltip_text(Some("Not read yet"));
        top.append(&dot);
    }
    let sev = gtk::Label::new(Some(sev_word(&it.severity)));
    sev.add_css_class("ns-sev");
    sev.add_css_class(&format!("ns-{}", if matches!(it.severity.as_str(), "critical" | "warning" | "ok") { &it.severity } else { "info" }));
    sev.set_valign(gtk::Align::Start);
    top.append(&sev);
    let title = wrapped(&it.title, "ns-row-t", if open { 0 } else { 2 });
    title.set_hexpand(true);
    top.append(&title);
    col.append(&top);
    if !it.text.is_empty() && !open {
        col.append(&wrapped(&it.text, "ns-lead", 3));
    }
    let meta = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    for (l, cls) in &it.pills {
        let pl = gtk::Label::new(Some(l));
        pl.add_css_class("ns-pill");
        if !cls.is_empty() {
            pl.add_css_class(&format!("ns-p-{cls}"));
        }
        meta.append(&pl);
    }
    let m = wrapped(&it.meta, "ns-meta", 1);
    m.set_hexpand(true);
    meta.append(&m);
    // where the item goes, one click away without opening the row (the rest of its actions are inside)
    if let Some(btn) = (!open).then(|| it.actions.iter().find(|a| s(a, "id") == "open")).flatten()
        .and_then(|a| action_button(p, it, a)) {
        btn.remove_css_class("ns-go");
        btn.add_css_class("ns-flat");
        btn.add_css_class("ns-quick");
        btn.set_valign(gtk::Align::Center);
        meta.append(&btn);
    }
    col.append(&meta);
    let said = p.status.borrow().get(&it.key).map(|x| x.0.clone()).unwrap_or_default();
    if !said.is_empty() {
        col.append(&wrapped(&said, "ns-handoff", 0));
    }
    if open {
        row.add_css_class("ns-open");
        col.append(&detail(p, it));
    }
    row.set_child(Some(&col));
    row
}

/// The row expanded: the notification card's parts (as its popup shows them), the question's form, and the actions.
fn detail(p: &Shared, it: &Item) -> gtk::Box {
    let b = gtk::Box::new(gtk::Orientation::Vertical, 8);
    b.set_margin_top(6);
    let c = &it.card;
    let mut said = vec![norm(&it.title)];
    if !it.text.is_empty() && it.question.is_null() {
        b.append(&wrapped(&it.text, "ns-lead", 0));
        said.push(norm(&it.text));
    }
    if c.is_object() {
        let n = &c["now"];
        if !s(n, "label").is_empty() {
            b.append(&wrapped(s(n, "label"), "ns-khead", 0));
        }
        for l in notice::now_lines(c) {
            let k = norm(&l);
            if !said.iter().any(|x| !x.is_empty() && (k.contains(x.as_str()) || x.contains(k.as_str()))) {
                b.append(&wrapped(&l, "ns-ksub", 0));
            }
            said.push(k);
        }
        // a Needs you item: the finding's lines as the board shows them now (its push's details may be older)
        for l in it.more.iter().skip(if it.text.is_empty() { 0 } else { 1 }) {
            let k = norm(l);
            if !said.iter().any(|x| !x.is_empty() && (k.contains(x.as_str()) || x.contains(k.as_str()))) {
                b.append(&wrapped(l, "ns-ksub", 0));
            }
            said.push(k);
        }
        let details = if it.more.is_empty() { strs(&c["details"]) } else { vec![] };
        if !details.is_empty() {
            let d = gtk::Box::new(gtk::Orientation::Vertical, 4);
            for x in &details {
                d.append(&wrapped(x, "ns-dd", 0));
            }
            let ex = gtk::Expander::new(Some("Details"));
            ex.set_child(Some(&d));
            ex.set_expanded(n.is_null() && details.len() <= 3);
            b.append(&ex);
        }
        let cmds = strs(&c["commands"]);
        if !cmds.is_empty() {
            b.append(&label(if cmds.len() == 1 { "Run this" } else { "Run these" }, "ns-dt"));
        }
        for cmd in cmds {
            b.append(&notice::command_row(cmd, || log("command copied")));
        }
    } else {
        for l in it.more.iter().skip(if it.text.is_empty() { 0 } else { 1 }) {
            b.append(&wrapped(l, "ns-ksub", 0));
        }
    }
    if it.question.is_object() {
        let qb = gtk::Box::new(gtk::Orientation::Vertical, 8);
        let (p2, key, id) = (p.clone(), it.key.clone(), s(&it.question, "id").to_string());
        let shown = it.question["options"].as_array().cloned().unwrap_or_default();
        let send: notice::Send = Rc::new(move |option, text, note| {
            if p2.busy.replace(true) {
                return false;
            }
            log(format!("answer to ask {id}: sending"));
            let (tx, id, key, shown) = (p2.tx.clone(), id.clone(), key.clone(), shown.clone());
            std::thread::spawn(move || {
                let _ = tx.send_blocking(Msg::Answered(key, ask::answer_shown(&id, option, &shown, &text, &note)));
            });
            true
        });
        // the question's own text is the row's title already
        let q = json!({"question": "", "body": it.question["body"], "command": it.question["command"],
                       "state": it.question["state"], "answer": it.question["answer"], "note": it.question["note"],
                       "options": it.question["options"], "recommended": it.question["recommended"]});
        notice::ask_form(&qb, &q, || log("command copied"), send);
        if let Some(first) = qb.first_child() {
            qb.remove(&first); // the empty question heading
        }
        b.append(&qb);
    }
    let line = key_line(&it.actions);
    let buttons = gtk::FlowBox::new();
    buttons.set_selection_mode(gtk::SelectionMode::None);
    buttons.set_max_children_per_line(5);
    buttons.set_column_spacing(6);
    buttons.set_row_spacing(6);
    buttons.set_halign(gtk::Align::Start);
    buttons.set_homogeneous(false);
    for a in &it.actions {
        if let Some(btn) = action_button(p, it, a) {
            buttons.insert(&btn, -1);
        }
    }
    if !line.is_empty() {
        b.append(&wrapped(&line, "ns-meta", 0));
    }
    b.append(&buttons);
    b
}

/// Which of a row's actions the security key signs (only Approve), said once above the buttons.
pub fn key_line(actions: &[Value]) -> String {
    let keyed: Vec<&str> = actions.iter().filter(|a| s(a, "tier") == "key").map(|a| s(a, "label")).collect();
    match keyed.as_slice() {
        [] => String::new(),
        ["Approve"] => "Approve opens the approval card; your security key confirms it there.".into(),
        [one] => format!("{one} opens the approval card; your security key confirms it."),
        [rest @ .., last] => format!("{} and {last} each open the approval card; your security key confirms it.", rest.join(", ")),
    }
}

/// A line as compared for saying it once: lower case letters and digits only.
fn norm(t: &str) -> String {
    t.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

fn action_button(p: &Shared, it: &Item, a: &Value) -> Option<gtk::Button> {
    let id = s(a, "id").to_string();
    if !matches!(id.as_str(), "approve" | "answer" | "open" | "mark-read") {
        log(format!("action {id} not offered here"));
        return None;
    }
    let btn = gtk::Button::with_label(s(a, "label"));
    if a["primary"] == true {
        btn.add_css_class("ns-go");
    }
    if !s(a, "hint").is_empty() {
        btn.set_tooltip_text(Some(s(a, "hint")));
    }
    let (p2, key, a) = (p.clone(), it.key.clone(), a.clone());
    btn.connect_clicked(move |_| act(&p2, &key, &id, &a));
    Some(btn)
}

fn act(p: &Shared, key: &str, id: &str, a: &Value) {
    match id {
        "approve" => {
            let (rid, kind) = (s(&a["approve"], "request").to_string(), s(&a["approve"], "kind").to_string());
            if crate::proto::valid_id(&rid) {
                log(format!("approve {} pressed: opening its card", &rid[..8]));
                become_card(p, rid, kind);
            } else {
                say(p, key, "Couldn't open this ask's card here. Open it on the website.");
            }
        }
        "answer" => {
            // the question is listed under Questions: open it there; else where it was asked (Aico)
            let q = a["url"].as_str().and_then(|u| u.split("ask=").nth(1)).map(|i| format!("q:{}", i.get(..12).unwrap_or(i)));
            let listed = q.as_ref().is_some_and(|q| {
                let mut c = p.list.first_child();
                while let Some(w) = c {
                    if w.widget_name() == q.as_str() {
                        return true;
                    }
                    c = w.next_sibling();
                }
                false
            });
            match q.filter(|_| listed) {
                Some(q) => {
                    read(p, key);
                    p.expanded.borrow_mut().insert(q.clone());
                    render(p);
                    let mut c = p.list.first_child();
                    while let Some(w) = c {
                        if w.widget_name() == q.as_str() {
                            w.grab_focus();
                        }
                        c = w.next_sibling();
                    }
                }
                None => act(p, key, "open", a),
            }
        }
        "open" => {
            let url = s(a, "url").to_string();
            if openable(&url) {
                read(p, key);
                log(format!("open {url}"));
                browser::open(&url);
                quit(p, "Open pressed");
            } else {
                say(p, key, "This link isn't on Aico or a known agent site, so it isn't opened.");
            }
        }
        "mark-read" => {
            let ids = strs(&a["ids"]);
            log(format!("{key}: marked read"));
            let (tx, key) = (p.tx.clone(), key.to_string());
            std::thread::spawn(move || {
                let _ = tx.send_blocking(Msg::Marked(key, notices::mark_read_pressed(&ids, "panel")));
            });
        }
        _ => {}
    }
}

/// Aico's own pages (Status, a question), the approval host's, and the agent sites a push may point at (notices::open_link).
fn openable(url: &str) -> bool {
    let own = [crate::status_host(), crate::approve_host()].into_iter().filter(|h| !h.is_empty())
        .any(|h| url.strip_prefix(&format!("https://{h}")).is_some_and(|r| r.is_empty() || r.starts_with(['/', '?', '#'])));
    own && url.chars().all(|c| c.is_ascii_graphic()) || notices::open_link(&json!({"refs": {"open": url}})).is_some()
}

/// The unread pushes a row holds (Needs you and Notifications rows; the other sections have none by id).
fn unread_ids(data: &Value, key: &str) -> Vec<String> {
    let mut out = Vec::new();
    for list in ["needs", "notifications"] {
        for r in data[list].as_array().unwrap_or(&Vec::new()) {
            let k = if list == "needs" { format!("need:{}", s(r, "key")) } else { format!("n:{}", s(r, "id")) };
            if k == key {
                out.extend(strs(&r["unread"]));
            }
        }
    }
    out
}

/// Mark what a row holds as read (its Mark read action's ids), as opening it on the website would.
fn read(p: &Shared, key: &str) {
    for i in unread_ids(&p.data.borrow(), key) {
        notices::mark_seen(&i);
    }
}

/// A row's own line until the owner closes the panel (in progress, or what went wrong).
fn say(p: &Shared, key: &str, text: &str) {
    p.status.borrow_mut().insert(key.to_string(), (text.to_string(), u64::MAX));
    render(p);
}

/// A row's own line until the next read, which shows where it stands (an answered question).
fn say_until_read(p: &Shared, key: &str, text: &str) {
    p.status.borrow_mut().insert(key.to_string(), (text.to_string(), p.gen.get() + 1));
    render(p);
}

fn become_card(p: &Shared, id: String, kind: String) {
    *p.then.borrow_mut() = Some((id, kind));
    p.main.quit();
}

fn quit(p: &Shared, why: &str) {
    log(format!("closed: {why}"));
    p.main.quit();
}

fn on_msg(p: &Shared, m: Msg) {
    if !p.main.is_running() {
        return; // closed, or the approval card now
    }
    match m {
        Msg::Data(g, d, q) => {
            p.loading.set(false);
            p.status.borrow_mut().retain(|_, (_, until)| *until > g);
            match d {
                Ok(v) => {
                    log(format!("loaded: {}", summary(&v, &q)));
                    if p.hover.get() && moves(&p.shown.borrow(), &lines(&v, &q, crate::daemon::now(), aico_link)) {
                        // a click aimed at one row must not land on another: shown once the pointer leaves
                        *p.held.borrow_mut() = Some((v, q));
                        return;
                    }
                    p.held.borrow_mut().take();
                    *p.data.borrow_mut() = v;
                }
                Err(e) => {
                    log(format!("not loaded: {e}"));
                    let mut d = p.data.borrow_mut();
                    if d.is_null() {
                        *d = json!({"health": format!("Couldn't read Aico ({e}). The Status page shows it."),
                                    "counts": {}});
                    } else {
                        // what is listed is the last read: say so, never pass it off as current
                        let at = d["at"].as_f64().map_or("earlier".into(), |t| format!("at {}", notice::hhmm(t)));
                        d["health"] = json!(format!("Couldn't refresh ({e}). This is what Aico said {at}."));
                    }
                }
            }
            *p.questions.borrow_mut() = q;
            if typing(p) {
                p.again.set(true); // the owner is typing an answer: re-read once they are done
            } else {
                render(p);
            }
            if p.again.replace(false) && !typing(p) {
                load(p);
            }
        }
        Msg::Answered(key, r) => {
            p.busy.set(false);
            let text = match r {
                Ok(a) => a["answer"].as_str().map(|x| format!("Sent: {x}. The agent gets it as soon as it's free."))
                    .unwrap_or_else(|| "Your note is sent.".into()),
                Err(e) => format!("{e}. Nothing was sent."),
            };
            log(format!("{key}: {text}"));
            say_until_read(p, &key, &text);
            load(p);
        }
        Msg::Marked(key, r) => {
            if r.is_ok() && key.is_empty() {
                p.status.borrow_mut().remove(""); // a Mark all read that went through clears the one that did not
            }
            if let Err(e) = r {
                log(e.clone());
                let what = if key.is_empty() { "Couldn't mark all read" } else { "Couldn't mark it read" };
                say(p, &key, &format!("{what}: {e}."));
            }
            load(p);
        }
    }
}

pub fn run() -> i32 {
    if gtk::init().is_err() {
        log("no display");
        return 2;
    }
    crate::window::style(&format!("{}{CSS}", notice::CSS));
    let main = glib::MainLoop::new(None, false);
    let win = gtk::Window::new();
    win.add_css_class("ns-win");
    win.add_css_class("ns-panel");
    win.set_title(Some("Aico inbox"));
    win.set_default_size(WIDTH, -1);
    crate::icons::set_default_window_icon();
    let outer = gtk::Box::new(gtk::Orientation::Vertical, 8);
    outer.set_margin_top(16);
    outer.set_margin_bottom(16);
    outer.set_margin_start(16);
    outer.set_margin_end(16);
    outer.set_size_request(WIDTH - 32, -1);
    let head = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    let brand = label("INBOX", "ns-brand"); // the window title says Aico; the buttons need the width
    brand.set_wrap(false); // never broken mid-word next to the buttons
    brand.set_hexpand(true);
    let mark = gtk::Button::with_label("Mark all read");
    mark.add_css_class("ns-flat");
    let dash = gtk::Button::with_label("Status");
    dash.add_css_class("ns-flat");
    dash.set_tooltip_text(Some("The Aico Status page in the browser"));
    let close = gtk::Button::with_label("Close");
    close.add_css_class("ns-flat");
    for w in [brand.upcast_ref::<gtk::Widget>(), mark.upcast_ref(), dash.upcast_ref(), close.upcast_ref()] {
        head.append(w);
    }
    let summary_l = wrapped("Reading Aico...", "ns-ttl", 0);
    let health = wrapped("", "ns-meta", 0);
    health.set_visible(false);
    let list = gtk::ListBox::new();
    list.set_selection_mode(gtk::SelectionMode::None);
    let scroll = gtk::ScrolledWindow::new();
    scroll.set_policy(gtk::PolicyType::Never, gtk::PolicyType::Automatic);
    scroll.set_propagate_natural_height(true);
    scroll.set_child(Some(&list));
    let more = gtk::Button::with_label("Open the Status page");
    more.add_css_class("ns-flat");
    more.set_halign(gtk::Align::Start);
    for w in [head.upcast_ref::<gtk::Widget>(), summary_l.upcast_ref(), health.upcast_ref(), scroll.upcast_ref(), more.upcast_ref()] {
        outer.append(w);
    }
    win.set_child(Some(&outer));
    let (tx, rx) = async_channel::unbounded::<Msg>();
    let p: Shared = Rc::new(Panel {
        win: win.clone(), list: list.clone(), scroll: scroll.clone(), summary: summary_l, health, more: more.clone(),
        data: RefCell::new(Value::Null), questions: RefCell::new(Ok(vec![])), expanded: RefCell::new(HashSet::new()),
        status: RefCell::new(HashMap::new()), gen: Cell::new(0), shown: RefCell::new(vec![]),
        rows: RefCell::new(HashMap::new()), loading: Cell::new(false), again: Cell::new(false), busy: Cell::new(false),
        sig: RefCell::new(vec![]), cap: Cell::new(400), hover: Cell::new(false), held: RefCell::new(None), then: RefCell::new(None), tx, main: main.clone(),
    });
    {
        let p2 = p.clone();
        glib::spawn_future_local(async move {
            while let Ok(m) = rx.recv().await {
                on_msg(&p2, m);
            }
        });
        let p2 = p.clone();
        list.connect_row_activated(move |_, row| {
            let key = row.widget_name().to_string();
            if key.is_empty() {
                return;
            }
            let opened = {
                let mut e = p2.expanded.borrow_mut();
                if !e.remove(&key) {
                    e.insert(key.clone());
                    true
                } else {
                    false
                }
            };
            log(format!("{key} {}", if opened { "expanded" } else { "folded" }));
            render(&p2);
            // Opening a row to read it counts as reading it (the row was clicked): its dot goes, as Mark read would.
            let ids = if opened { unread_ids(&p2.data.borrow(), &key) } else { vec![] };
            if !ids.is_empty() {
                log(format!("{key}: read by opening it"));
                let tx = p2.tx.clone();
                std::thread::spawn(move || {
                    let _ = tx.send_blocking(Msg::Marked(key, notices::mark_read_pressed(&ids, "panel")));
                });
            }
        });
        let p2 = p.clone();
        mark.connect_clicked(move |_| {
            log("mark all read");
            let tx = p2.tx.clone();
            std::thread::spawn(move || {
                let _ = tx.send_blocking(Msg::Marked(String::new(), notices::mark_opened()));
            });
        });
        let p2 = p.clone();
        dash.connect_clicked(move |_| {
            let url = p2.data.borrow()["links"]["dashboard"].as_str().map(str::to_string)
                .unwrap_or_else(|| format!("https://{}/status", crate::status_host()));
            browser::open(&url);
            quit(&p2, "Status");
        });
        let p2 = p.clone();
        more.connect_clicked(move |_| {
            browser::open(&notices::url(""));
            quit(&p2, "Status page");
        });
        let p2 = p.clone();
        close.connect_clicked(move |_| quit(&p2, "Close pressed"));
        let p2 = p.clone();
        win.connect_close_request(move |_| {
            quit(&p2, "window closed");
            glib::Propagation::Stop
        });
        let keys = gtk::EventControllerKey::new();
        keys.set_propagation_phase(gtk::PropagationPhase::Capture);
        let p2 = p.clone();
        keys.connect_key_pressed(move |_, key, _, _| {
            if key == gtk::gdk::Key::Escape {
                quit(&p2, "Escape pressed");
                return glib::Propagation::Stop;
            }
            glib::Propagation::Proceed
        });
        win.add_controller(keys);
        // rows stay put under the pointer; a re-read that moves them is shown when it leaves
        let hover = gtk::EventControllerMotion::new();
        let p2 = p.clone();
        hover.connect_enter(move |_, _, _| p2.hover.set(true));
        let p2 = p.clone();
        hover.connect_leave(move |_| {
            p2.hover.set(false);
            let held = p2.held.borrow_mut().take();
            if let Some((v, q)) = held.filter(|_| p2.main.is_running()) {
                *p2.data.borrow_mut() = v;
                *p2.questions.borrow_mut() = q;
                render(&p2);
            }
        });
        win.add_controller(hover);
        // re-read at once when Tether's feed changes (a question came or was answered), and every 15 seconds for the rest
        let p2 = p.clone();
        let last = Cell::new(crate::daemon::now());
        glib::timeout_add_seconds_local(2, move || {
            if !p2.main.is_running() {
                return glib::ControlFlow::Break; // the approval card in its place reads nothing of this
            }
            let t = crate::daemon::now();
            if signature() != *p2.sig.borrow() || t - last.get() > 15.0 || p2.again.get() {
                last.set(t);
                if !typing(&p2) {
                    load(&p2);
                }
            }
            glib::ControlFlow::Continue
        });
    }
    // as tall as its rows up to 70% of the screen, then it scrolls
    let screen = gtk::gdk::Display::default().and_then(|d| d.monitors().item(0).and_downcast::<gtk::gdk::Monitor>())
        .map_or(900, |m| m.geometry().height());
    p.cap.set((screen * 7 / 10 - 160).max(300)); // the header and footer take the rest
    #[cfg(debug_assertions)] // checking the expanded rows' layout without a pointer (Broadway)
    if let Some(keys) = std::env::var_os("AICO_PANEL_EXPAND") {
        p.expanded.borrow_mut().extend(keys.to_string_lossy().split(',').map(str::to_string));
        p.cap.set(4000);
    }
    // dropped from the shell extension's moon when it shows one (it places the window), else at the tray corner
    let popover = std::env::var_os(crate::anchor::POPOVER).is_some();
    crate::anchor::place(&win, crate::anchor::Opts { popover, ..Default::default() });
    win.set_focus_visible(true); // the focused row or button shows it from the start, before any key
    win.present();
    load(&p);
    log("shown");
    main.run();
    win.set_visible(false);
    let then = p.then.borrow_mut().take();
    match then {
        // the key's card in this same place: the owner pressed Approve, Expected, Not expected or Mute here
        Some((id, kind)) => crate::window::run(&id, false, &crate::ask_url(&kind, &id), false),
        None => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/inbox-sample.json")).unwrap()
    }

    #[test]
    fn a_read_moves_rows_only_when_it_adds_removes_or_reorders_them() {
        let all = lines(&sample(), &Ok(vec![]), 2000.0, |_| None);
        let shown = |ls: &[Line]| -> Vec<String> {
            ls.iter().map(|l| match l {
                Line::Head(t) => format!("head:{t}"),
                Line::Item(it) => format!("{}\u{1f}changed text", it.key),
            }).collect()
        };
        assert!(!moves(&shown(&all), &all), "the same rows with new words or counts stay where they are");
        assert!(!moves(&[], &all), "the first list is shown at once");
        let mut fewer = all.clone();
        let gone = fewer.iter().rposition(|l| matches!(l, Line::Item(_))).unwrap();
        fewer.remove(gone);
        assert!(moves(&shown(&all), &fewer));
        let mut swapped = all.clone();
        let items: Vec<usize> = swapped.iter().enumerate().filter(|(_, l)| matches!(l, Line::Item(_))).map(|(i, _)| i).collect();
        swapped.swap(items[0], items[1]);
        assert!(moves(&shown(&all), &swapped));
    }

    #[test]
    fn rows_say_what_the_data_says() {
        let data = sample();
        let qs = Ok(vec![json!({"id": "e0062e61c89f", "question": "Ship it?", "body": "Tests pass.", "state": "open",
                                "blocking": true, "requester": "Aico — release", "createdAt": 1000.0 * 1000.0,
                                "options": ["Yes", "No"], "recommended": 0})]);
        let ls = lines(&data, &qs, 1000.0 + 600.0, |id| Some(format!("https://aico.example/?ask={id}")));
        let heads: Vec<&str> = ls.iter().filter_map(|l| if let Line::Head(h) = l { Some(h.as_str()) } else { None }).collect();
        assert_eq!(heads[0], format!("NEEDS YOU ({})", data["needs"].as_array().unwrap().len()));
        assert!(heads[1].starts_with("APPROVALS"));
        assert_eq!(heads[2], "QUESTIONS (1)");
        assert!(heads[3].starts_with("NOTIFICATIONS"));
        let items: Vec<&Item> = ls.iter().filter_map(|l| if let Line::Item(i) = l { Some(i) } else { None }).collect();
        // every row's title and actions are the data's own, in the data's order
        let mut want: Vec<(String, Vec<Value>)> = Vec::new();
        for list in ["needs", "approvals"] {
            for r in data[list].as_array().unwrap() {
                want.push((s(r, "title").into(), r["actions"].as_array().unwrap().clone()));
            }
        }
        want.push(("Ship it?".into(), vec![json!({"id": "open", "label": "Open in Aico", "tier": "view",
                                                  "url": "https://aico.example/?ask=e0062e61c89f",
                                                  "hint": "The question in Aico, where the agent asked it."})]));
        for r in data["notifications"].as_array().unwrap() {
            want.push((s(r, "title").into(), r["actions"].as_array().unwrap().clone()));
        }
        let got: Vec<(String, Vec<Value>)> = items.iter().map(|i| (i.title.clone(), i.actions.clone())).collect();
        assert_eq!(got, want);
        let n = data["notifications"][0].clone();
        let row = items.iter().find(|i| i.key == format!("n:{}", s(&n, "id"))).unwrap();
        assert_eq!(row.pills, n["pills"].as_array().unwrap().iter().map(|p| (s(p, "label").to_string(), s(p, "cls").to_string())).collect::<Vec<_>>());
        assert_eq!(row.unread, !n["unread"].as_array().unwrap().is_empty());
        let q = items.iter().find(|i| i.key == "q:e0062e61c89f").unwrap();
        assert_eq!(q.meta, "Aico — release · 10 min ago · the agent is waiting");
    }

    #[test]
    fn unread_state_reads_unknown_never_nothing() {
        let heads: Vec<String> = lines(&json!({}), &Ok(vec![]), 1000.0, |_| None).into_iter()
            .filter_map(|l| if let Line::Head(h) = l { Some(h) } else { None }).collect();
        assert_eq!(heads, ["NEEDS YOU · UNKNOWN", "APPROVALS · UNKNOWN", "NOTIFICATIONS · UNKNOWN"]);
    }

    #[test]
    fn empty_sections_say_one_line_not_four() {
        let data = json!({"needs": [], "approvals": [], "notifications": []});
        let heads = |d: &Value| -> Vec<String> { lines(d, &Ok(vec![]), 1000.0, |_| None).into_iter()
            .filter_map(|l| if let Line::Head(h) = l { Some(h) } else { None }).collect() };
        assert_eq!(heads(&data), ["NOTHING WAITING"]);
        // one section with something keeps its own head only; the empty ones stay quiet
        let one = json!({"needs": [], "approvals": [{"id": "a", "title": "t", "body": "", "left_text": "", "actions": []}],
                         "notifications": []});
        assert_eq!(heads(&one), ["APPROVALS (1)"]);
    }

    #[test]
    fn opening_a_row_reads_the_unread_pushes_it_holds() {
        let data = json!({"needs": [{"key": "k1", "unread": ["aaaaaaaaaaaa"]}],
                          "notifications": [{"id": "bbbbbbbbbbbb", "unread": ["bbbbbbbbbbbb", "cccccccccccc"]},
                                            {"id": "dddddddddddd", "unread": []}]});
        assert_eq!(unread_ids(&data, "need:k1"), ["aaaaaaaaaaaa"]);
        assert_eq!(unread_ids(&data, "n:bbbbbbbbbbbb"), ["bbbbbbbbbbbb", "cccccccccccc"]);
        assert!(unread_ids(&data, "n:dddddddddddd").is_empty() && unread_ids(&data, "q:x").is_empty());
    }

    #[test]
    fn the_header_counts_its_own_rows() {
        let data = sample();
        let new = data["notifications"].as_array().unwrap().iter().filter(|r| !r["unread"].as_array().unwrap().is_empty()).count();
        let ls = lines(&data, &Ok(vec![]), 1000.0, |_| None);
        assert!(ls.iter().any(|l| matches!(l, Line::Head(h) if *h == format!("NOTIFICATIONS ({new} NEW)"))));
    }

    #[test]
    fn open_goes_only_to_known_places() {
        let own = crate::status_host();
        if !own.is_empty() {
            assert!(openable(&format!("https://{own}/n/abc")) && openable(&format!("https://{own}")));
            assert!(!openable(&format!("https://{own}.evil.example/")));
        }
        assert!(!openable("https://evil.example/") && !openable("http://localhost/") && !openable("javascript:alert(1)"));
    }

    #[test]
    fn the_key_line_names_what_the_key_confirms() {
        let data = sample();
        let owner = data["needs"][0]["actions"].as_array().unwrap();
        assert_eq!(key_line(owner), ""); // Expected, Not expected and Mute are plain: recorded at once, no key
        assert_eq!(key_line(data["approvals"][0]["actions"].as_array().unwrap()),
                   "Approve opens the approval card; your security key confirms it there.");
        assert_eq!(key_line(&[]), "");
        // every action the model offers is one the panel knows how to do
        for part in ["needs", "approvals", "notifications"] {
            for r in data[part].as_array().unwrap() {
                for a in r["actions"].as_array().unwrap() {
                    assert!(["approve", "expected", "not-expected", "mute", "look-into", "answer", "retry", "open", "mark-read",
                             "done"].contains(&s(a, "id")), "{a}");
                    assert!(!s(a, "label").is_empty());
                }
            }
        }
    }

    #[test]
    fn unknown_is_never_zero() {
        let data = json!({"counts": {"needs": 4, "approvals": 0, "unread": 10}});
        assert_eq!(summary(&data, &Ok(vec![])), "4 need you · 10 unread");
        assert_eq!(summary(&data, &Err("Tether isn't reachable".into())), "4 need you · questions unknown · 10 unread");
        // the tray rule's header: what still needs anything, nothing else
        assert_eq!(summary(&json!({"counts": {"needs": 0, "approvals": 0, "unread": 1, "open": 0}}), &Ok(vec![])),
                   "Nothing needs you · 1 unread");
        assert_eq!(summary(&json!({"counts": {"needs": 0, "approvals": 1, "unread": 0, "open": 2}}), &Ok(vec![])),
                   "Nothing needs you · 1 approval waiting · 2 still open");
        assert_eq!(summary(&json!({"counts": {}}), &Ok(vec![])),
                   "Needs you unknown · approvals unknown · notifications unknown");
        let ls = lines(&json!({}), &Err("Tether isn't reachable".into()), 0.0, |_| None);
        assert!(ls.contains(&Line::Head("QUESTIONS · UNKNOWN (Tether isn't reachable)".into())));
    }
}
