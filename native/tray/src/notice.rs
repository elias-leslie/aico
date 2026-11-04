//! One notification's card (a tray row or the corner card clicked), in the approval card's place and style: the
//! notification as Aico's tray door explains it (`GET /api/tray/notice/<id>`: what happened, the details, its age),
//! commands it asks the owner to run with a Copy button, Mark read and Open.
//! An agent's question (a Tether ask, its push linking Aico) shows here with its choices, and the answer goes to Tether
//! (ask.rs) as Aico's drawer sends it. Only Approve turns the card into the approval card, where the key signs it.

use crate::{ask, browser, notices};
use gtk::glib;
use gtk::prelude::*;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

const WIDTH: i32 = 460;
pub const CSS: &str = "
.ns-win label.ns-meta { color: #a3abbc; font-size: 0.85em; }
.ns-win label.ns-ttl { font-size: 1.25em; font-weight: bold; }
.ns-win label.ns-cmd { font-family: monospace; font-size: 0.92em; }
.ns-cmdrow { background-color: #0f1218; border: 1px solid #2b3242; border-radius: 8px; padding: 6px 8px; }
.ns-win button.ns-small { padding: 2px 10px; min-height: 0; font-size: 0.9em; }
.ns-key.ns-attn { background-color: #2a2414; border-color: #6b5a2f; }
";

/// What the owner pressed that ends this card: it then becomes the approval card for that ask.
enum Then {
    Card { id: String, kind: String },
}

enum Msg {
    Card(Result<Value, String>),
    Ask(Result<Value, String>),
    Answered(Result<Value, String>),
}

struct Ui {
    win: gtk::Window,
    body: gtk::Box,
    scroll: gtk::ScrolledWindow,
    title: gtk::Label,
    lead: gtk::Label,
    meta: gtk::Label,
    now: gtk::Box,
    spinner: gtk::Spinner,
    nhead: gtk::Label,
    ntext: gtk::Box,
    details_box: gtk::Expander,
    details: gtk::Box,
    extras: gtk::Box,
    ask_box: gtk::Box,
    keyline: gtk::Label,
    answers: gtk::Box,
    /// the view actions (Open, Mark read, Done), left of Close
    views: gtk::Box,
}

struct App {
    ui: Ui,
    id: String,
    /// the agent's question this push is about (a Tether ask id), answered here
    ask: Option<String>,
    /// the push as logged (its title and links before the card's words come), None when it left the log
    entry: Option<Value>,
    /// the question's status line (Sending..., why it failed)
    ask_status: RefCell<Option<gtk::Label>>,
    card: RefCell<Value>,
    busy: RefCell<bool>,
    then: RefCell<Option<Then>>,
    tx: async_channel::Sender<Msg>,
    main: glib::MainLoop,
}

type Shared = Rc<App>;

fn log(id: &str, msg: impl AsRef<str>) {
    eprintln!("notice {id}: {}", msg.as_ref());
}

/// A line as a sentence: the finding's words sometimes end without a stop.
fn sentence(x: &str) -> String {
    let x = x.trim();
    if x.is_empty() || x.ends_with(['.', '!', '?', ':']) { x.to_string() } else { format!("{x}.") }
}

pub fn label(text: &str, class: &str) -> gtk::Label {
    let l = gtk::Label::new(Some(text));
    l.set_wrap(true);
    l.set_wrap_mode(gtk::pango::WrapMode::WordChar);
    l.set_xalign(0.0);
    l.set_selectable(true);
    l.set_can_focus(false);
    if !class.is_empty() {
        l.add_css_class(class);
    }
    l
}

pub fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}

pub fn clear(b: &gtk::Box) {
    while let Some(w) = b.first_child() {
        b.remove(&w);
    }
}

/// The card of a notification (or of an agent's question) from Aico's tray door. Blocking.
pub fn card(id: &str) -> Result<Value, String> {
    crate::aico::get(&format!("/api/tray/notice/{id}"))
}

/// How tall the content may grow before it scrolls: 560 px, or 60% of the screen when the desktop's text scale makes
/// cards that much taller.
fn tallest(win: &gtk::Window) -> i32 {
    let display = gtk::prelude::WidgetExt::display(win);
    let screen = win.surface().and_then(|sf| display.monitor_at_surface(&sf))
        .or_else(|| display.monitors().item(0).and_downcast::<gtk::gdk::Monitor>())
        .map_or(0, |m| m.geometry().height());
    560.max(screen * 3 / 5)
}

/// Fit the content (all of it up to 560 px or 60% of the screen if taller, then it scrolls), as the approval card does.
fn fit(app: &Shared) {
    fn apply(ui: &Ui) {
        // at the width the window will have: the card's, or wider when the desktop's text scale makes a row of buttons
        // need more (measured narrower, wrapped text would leave a gap below it; wider, it would be cut off)
        let (min_w, _, _, _) = ui.win.measure(gtk::Orientation::Horizontal, -1);
        let edge = if ui.body.width() > 0 { ui.win.width() - ui.body.width() } else { 40 };
        let w = WIDTH.max(min_w) - edge;
        let (_, natural, _, _) = ui.body.measure(gtk::Orientation::Vertical, w);
        let cap = tallest(&ui.win);
        ui.scroll.set_min_content_height(-1); // max may not go below the old min
        ui.scroll.set_max_content_height(natural.clamp(1, cap));
        ui.scroll.set_min_content_height(natural.min(cap));
        ui.win.set_default_size(WIDTH, 1);
    }
    let a2 = app.clone();
    glib::idle_add_local_once(move || {
        apply(&a2.ui);
        let a3 = a2.clone();
        glib::timeout_add_local_once(Duration::from_millis(120), move || apply(&a3.ui));
    });
}

fn tone(b: &gtk::Box, cls: &str) {
    for c in ["ns-wait", "ns-ok", "ns-bad", "ns-attn"] {
        b.remove_css_class(c);
    }
    let c = match cls {
        "ok" => "ns-ok",
        "critical" => "ns-bad",
        "attention" | "warning" => "ns-attn",
        "wait" => "ns-wait",
        _ => "",
    };
    if !c.is_empty() {
        b.add_css_class(c);
    }
}

/// The Now panel: the state and what to do, or a spinner while it loads, or why it could not.
fn now_panel(app: &Shared, head: &str, lines: &[String], cls: &str, spin: bool) {
    let ui = &app.ui;
    tone(&ui.now, cls);
    ui.spinner.set_visible(spin);
    ui.spinner.set_spinning(spin);
    ui.nhead.set_text(head);
    ui.nhead.set_visible(!head.is_empty()); // an empty heading would push the line below the spinner
    clear(&ui.ntext);
    for l in lines.iter().filter(|l| !l.is_empty()) {
        ui.ntext.append(&label(l, "ns-ksub"));
    }
    ui.now.set_visible(!head.is_empty() || lines.iter().any(|l| !l.is_empty()));
    fit(app);
}

pub fn hhmm(ts: f64) -> String {
    glib::DateTime::from_unix_local(ts as i64).ok().and_then(|d| d.format("%H:%M").ok()).map(|g| g.to_string()).unwrap_or_default()
}

pub fn small(text: &str, class: &str) -> gtk::Button {
    let b = gtk::Button::with_label(text);
    b.add_css_class("ns-small");
    if !class.is_empty() {
        b.add_css_class(class);
    }
    b.set_valign(gtk::Align::Center);
    b
}

/// The Now panel's lines (the card here and a row in the inbox panel): what to do, the rest, what the finding says now
/// (its numbers may have moved since the push was sent), who handles it, and a stale snapshot.
pub fn now_lines(c: &Value) -> Vec<String> {
    let n = &c["now"];
    let mut lines: Vec<String> = [s(n, "todo"), s(n, "rest")].iter().map(|x| sentence(x)).collect();
    lines.extend(c["current"].as_array().into_iter().flatten().filter_map(Value::as_str).map(sentence));
    match s(c, "who") {
        "you" => lines.push("Who handles it: you.".into()),
        "agent" => lines.push("Who handles it: an agent.".into()),
        "aico" => lines.push("Who handles it: Aico.".into()),
        _ => {}
    }
    if !matches!(s(c, "snapshot"), "fresh" | "") {
        lines.push(format!("Aico's status snapshot is {}, so its state now may be out of date.", s(c, "snapshot")));
    }
    lines.retain(|l| !l.is_empty());
    lines
}

/// The card as root's words have it now.
fn render(app: &Shared) {
    let c = app.card.borrow().clone();
    let ui = &app.ui;
    ui.title.set_text(s(&c, "title"));
    ui.win.set_title(Some(&format!("Aico: {}", s(&c, "title"))));
    let body = notices::desk_body(s(&c, "body"), app.ask.is_some());
    ui.lead.set_text(&body);
    ui.lead.set_visible(!body.is_empty());
    let age = notices::ago(crate::daemon::now() - c["ts"].as_f64().unwrap_or(0.0));
    ui.meta.set_text(&[s(&c, "kind"), &format!("sent {age}"), s(&c, "delivery")].iter().filter(|x| !x.is_empty())
        .cloned().collect::<Vec<_>>().join(" · "));
    let n = &c["now"];
    now_panel(app, s(n, "label"), &now_lines(&c), s(n, "cls"), false);
    clear(&ui.details);
    let details: Vec<&str> = c["details"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    for d in &details {
        ui.details.append(&label(d, "ns-dd"));
    }
    ui.details_box.set_visible(!details.is_empty());
    ui.details_box.set_expanded(n.is_null() && details.len() <= 3); // nothing tracked after the push: the details are it
    render_extras(app, &c);
    render_answers(app, &c);
}

/// A command to run, with Copy.
fn cmd_row(app: &Shared, cmd: String) -> gtk::Box {
    let id = app.id.clone();
    command_row(cmd, move || log(&id, "command copied"))
}

/// A command to run, with Copy (`copied` logs it).
pub fn command_row(cmd: String, copied: impl Fn() + 'static) -> gtk::Box {
    let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    row.add_css_class("ns-cmdrow");
    let l = label(&cmd, "ns-cmd");
    l.set_hexpand(true);
    let copy = small("Copy", "");
    copy.connect_clicked(move |b| {
        b.clipboard().set_text(&cmd);
        b.set_label("Copied");
        copied();
    });
    row.append(&l);
    row.append(&copy);
    row
}

/// Commands to copy, the reboot report's rows, and the links the page offers.
fn render_extras(app: &Shared, c: &Value) {
    let ui = &app.ui;
    clear(&ui.extras);
    let cmds: Vec<String> = c["commands"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if !cmds.is_empty() {
        ui.extras.append(&label(if cmds.len() == 1 { "Run this" } else { "Run these" }, "ns-dt"));
    }
    for cmd in cmds {
        ui.extras.append(&cmd_row(app, cmd));
    }
    for l in c["links"].as_array().cloned().unwrap_or_default() {
        let url = s(&l, "url").to_string();
        if !url.starts_with("https://") || (app.ask.is_some() && url.contains("?ask=")) { // the question is answered here
            continue;
        }
        let b = gtk::Button::with_label(s(&l, "label"));
        b.add_css_class("ns-flat");
        b.set_halign(gtk::Align::Start);
        let id = app.id.clone();
        b.connect_clicked(move |_| {
            log(&id, "link opened");
            browser::open(&url);
        });
        ui.extras.append(&b);
    }
    ui.extras.set_visible(ui.extras.first_child().is_some());
    fit(app);
}

/// The card's actions (tray.ts), primary first: Approve above (the key confirms it on the approval card), the view
/// ones (Open, Mark read) beside Close. Before the card has loaded, or when it couldn't, Mark read and Open in browser
/// stay as the fallback.
fn render_answers(app: &Shared, c: &Value) {
    let ui = &app.ui;
    clear(&ui.answers);
    clear(&ui.views);
    let Some(actions) = c["actions"].as_array().filter(|a| !a.is_empty()) else {
        let read = gtk::Button::with_label("Mark read");
        let a2 = app.clone();
        read.connect_clicked(move |_| act(&a2, "mark-read", &json!({})));
        let open = gtk::Button::with_label("Open in browser");
        open.add_css_class("ns-flat");
        let a2 = app.clone();
        open.connect_clicked(move |_| act(&a2, "open", &json!({})));
        ui.views.append(&read);
        ui.views.append(&open);
        ui.answers.set_visible(false);
        ui.keyline.set_visible(false);
        return;
    };
    let asked_here = app.ask_status.borrow().is_some(); // the question's form is in the card: Answer is it
    let shown = place(actions, asked_here);
    let mut keyed: Vec<Value> = Vec::new();
    for a in &shown {
        let id = s(a, "id").to_string();
        let b = gtk::Button::with_label(s(a, "label"));
        if !s(a, "hint").is_empty() {
            b.set_tooltip_text(Some(s(a, "hint")));
        }
        if s(a, "tier") == "view" {
            if a["primary"] == true {
                b.add_css_class("ns-go");
            } else if id != "mark-read" {
                b.add_css_class("ns-flat");
            }
            ui.views.append(&b);
        } else {
            if a["primary"] == true {
                b.add_css_class("ns-go");
            }
            if s(a, "tier") == "key" {
                keyed.push(a.clone());
            }
            ui.answers.append(&b);
        }
        let (a2, a) = (app.clone(), a.clone());
        b.connect_clicked(move |_| act(&a2, &id, &a));
    }
    ui.answers.set_visible(ui.answers.first_child().is_some());
    // said right above the buttons it is about: which open the key's card
    let line = crate::panel::key_line(&keyed);
    ui.keyline.set_text(&line);
    ui.keyline.set_visible(!line.is_empty());
}

/// The actions the popup shows, in the card's order (ones it doesn't know are left out). An agent's question answered
/// in the popup needs no Answer.
fn place(actions: &[Value], asked_here: bool) -> Vec<Value> {
    const KNOWN: [&str; 4] = ["approve", "answer", "open", "mark-read"];
    actions.iter().filter(|a| {
        let id = s(a, "id");
        KNOWN.contains(&id) && !(id == "answer" && asked_here)
    }).cloned().collect()
}

/// A link the popup opens: Aico's own pages (and the approval host's), or the agent sites a push may point at (as the inbox panel).
fn openable(url: &str) -> bool {
    let own = [crate::status_host(), crate::approve_host()].into_iter().filter(|h| !h.is_empty())
        .any(|h| url.strip_prefix(&format!("https://{h}")).is_some_and(|r| r.is_empty() || r.starts_with(['/', '?', '#'])));
    own && url.len() <= 300 && url.chars().all(|c| c.is_ascii_graphic()) || notices::open_link(&json!({"refs": {"open": url}})).is_some()
}

/// What one of the card's actions does here.
fn act(app: &Shared, id: &str, a: &Value) {
    match id {
        "approve" => {
            let (rid, kind) = (s(&a["approve"], "request").to_string(), s(&a["approve"], "kind").to_string());
            if crate::proto::valid_id(&rid) {
                log(&app.id, format!("approve {} pressed: opening its card", &rid[..8]));
                become_card(app, rid, kind);
            }
        }
        "answer" | "open" => {
            // its own place (refs.open, else its page); without the card, its page (an agent's question: Aico)
            let url = a["url"].as_str().filter(|u| openable(u)).map(str::to_string).unwrap_or_else(|| {
                app.ask.as_ref().and_then(|_| app.entry.as_ref()).and_then(notices::open_link)
                    .unwrap_or_else(|| notices::url(&app.id))
            });
            notices::mark_seen(&app.id);
            log(&app.id, format!("{id}: {url}"));
            browser::open(&url);
            quit(app, "Open pressed");
        }
        "mark-read" => {
            let mut ids: Vec<String> = a["ids"].as_array().into_iter().flatten().filter_map(|i| i.as_str().map(str::to_string))
                .filter(|i| notices::valid_entry_id(i)).collect();
            if ids.is_empty() {
                ids.push(app.id.clone());
            }
            notices::mark_read_pressed_bg(&ids, "popup");
            quit(app, "Mark read");
        }
        _ => {}
    }
}

/// The agent's question as Tether has it: choices (the recommended one marked and picked), their own words, a note,
/// Send; or how it was answered or closed.
fn render_ask(app: &Shared, a: &Value) {
    let b = &app.ui.ask_box;
    clear(b);
    b.set_visible(true);
    let a2 = app.clone();
    let id = s(a, "id").to_string();
    let send = Rc::new(move |option: Option<usize>, text: String, note: String| {
        if std::mem::replace(&mut *a2.busy.borrow_mut(), true) {
            return false;
        }
        log(&a2.id, format!("answer to ask {id}: sending"));
        let (tx, id) = (a2.tx.clone(), id.clone());
        std::thread::spawn(move || {
            let _ = tx.send_blocking(Msg::Answered(ask::answer(&id, option, &text, &note)));
        });
        true
    });
    let nid = app.id.clone();
    *app.ask_status.borrow_mut() = ask_form(b, a, move || log(&nid, "command copied"), send);
    fit(app);
}

/// What the owner may send: a choice (by index) or their own words, and a note; false when one is already on its way.
pub type Send = Rc<dyn Fn(Option<usize>, String, String) -> bool>;

/// An agent's question into `b` (this card, or a row of the inbox panel): the question, its detail and command,
/// choices with the recommended one marked and picked, their own words, a note and Send (`send` sends it); or how it
/// was answered or closed. Returns the status line under Send (None when there is nothing to send).
pub fn ask_form(b: &gtk::Box, a: &Value, copied: impl Fn() + 'static, go_send: Send) -> Option<gtk::Label> {
    b.append(&label(s(a, "question"), "ns-khead"));
    if !s(a, "body").is_empty() {
        b.append(&label(s(a, "body"), "ns-dd"));
    }
    if !s(a, "command").is_empty() {
        b.append(&command_row(s(a, "command").to_string(), copied));
    }
    let state = s(a, "state");
    let said = match (a["answer"].as_str(), a["note"].as_str()) {
        (Some(x), Some(n)) => format!("{x} (note: {n})"),
        (Some(x), None) => x.to_string(),
        (None, Some(n)) => format!("note: {n}"),
        _ => String::new(),
    };
    match state {
        "open" => {}
        "answered" => {
            b.append(&label(&format!("You answered: {said}. You can change it until the agent acts on it."), "ns-ksub"));
        }
        "done" => {
            let l = if said.is_empty() { "The agent has closed this question.".to_string() }
                    else { format!("You answered: {said}. The agent has acted on it.") };
            b.append(&label(&l, "ns-ksub"));
            return None;
        }
        _ => {
            b.append(&label("The agent took this question back. Nothing to answer.", "ns-ksub"));
            return None;
        }
    }
    let options: Vec<String> = a["options"].as_array().map(|o| o.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let rec = a["recommended"].as_u64().map(|r| r as usize);
    let mut picks: Vec<gtk::CheckButton> = Vec::new();
    for (i, o) in options.iter().enumerate() {
        let cb = gtk::CheckButton::with_label(&if rec == Some(i) { format!("{o} (recommended)") } else { o.clone() });
        if let Some(first) = picks.first() {
            cb.set_group(Some(first));
        }
        let picked = if state == "answered" { a["answer"].as_str() == Some(o.as_str()) } else { rec == Some(i) };
        cb.set_active(picked);
        b.append(&cb);
        picks.push(cb);
    }
    let own = gtk::Entry::new();
    own.set_max_length(100);
    own.set_placeholder_text(Some(if options.is_empty() { "Your answer" } else { "Or your own answer" }));
    let note = gtk::Entry::new();
    note.set_max_length(1000);
    note.set_placeholder_text(Some("Note for the agent (optional)"));
    let send = gtk::Button::with_label(if state == "answered" { "Change answer" } else { "Send" });
    send.add_css_class("ns-go");
    send.set_halign(gtk::Align::Start);
    let status = label("", "ns-ksub");
    status.set_visible(false);
    for w in [own.upcast_ref::<gtk::Widget>(), note.upcast_ref(), send.upcast_ref(), status.upcast_ref()] {
        b.append(w);
    }
    let go = {
        let (picks, own, note, status, b2) = (picks.clone(), own.clone(), note.clone(), status.clone(), b.clone());
        Rc::new(move || {
            let text = own.text().to_string();
            let option = if text.trim().is_empty() { picks.iter().position(|c| c.is_active()) } else { None };
            if option.is_none() && text.trim().is_empty() && note.text().trim().is_empty() {
                status.set_text("Pick a choice or write an answer.");
                status.set_visible(true);
                return;
            }
            if !go_send(option, text, note.text().to_string()) {
                return;
            }
            b2.set_sensitive(false);
            status.set_text("Sending...");
            status.set_visible(true);
        })
    };
    let g = go.clone();
    send.connect_clicked(move |_| g());
    // Enter sends only the words just typed as the answer, never a preselected choice (nor from the note field)
    own.connect_activate(move |e| {
        if !e.text().trim().is_empty() {
            go();
        }
    });
    Some(status)
}

fn become_card(app: &Shared, id: String, kind: String) {
    *app.then.borrow_mut() = Some(Then::Card { id, kind });
    app.main.quit();
}

fn on_msg(app: &Shared, m: Msg) {
    match m {
        Msg::Card(Ok(c)) => {
            log(&app.id, format!("state loaded: {} to copy", c["commands"].as_array().map_or(0, Vec::len)));
            *app.card.borrow_mut() = c;
            render(app);
        }
        Msg::Card(Err(e)) => {
            log(&app.id, format!("state not loaded: {e}"));
            now_panel(app, "Couldn't check its state now", &[format!("{e}. Open in browser shows it.")], "critical", false);
        }
        Msg::Ask(Ok(a)) => {
            log(&app.id, format!("question loaded ({})", s(&a, "state")));
            render_ask(app, &a);
            let c = app.card.borrow().clone();
            render_answers(app, &c); // its Answer is the form now
        }
        Msg::Ask(Err(e)) => {
            log(&app.id, format!("question not loaded: {e}"));
            clear(&app.ui.ask_box);
            app.ui.ask_box.append(&label(&format!("Couldn't read the agent's question: {e}. Answer it in Aico."),
                                         "ns-ksub"));
            fit(app);
        }
        Msg::Answered(Ok(a)) => {
            log(&app.id, "answer sent");
            *app.busy.borrow_mut() = false;
            notices::mark_seen(&app.id);
            let b = &app.ui.ask_box;
            clear(b);
            b.append(&label(s(&a, "question"), "ns-khead"));
            let what = a["answer"].as_str().map(|x| format!("Sent: {x}.")).unwrap_or_else(|| "Your note is sent.".into());
            b.append(&label(&format!("{what} The agent gets it as soon as it's free."), "ns-ksub"));
            fit(app);
            let a2 = app.clone();
            glib::timeout_add_local_once(Duration::from_millis(2500), move || quit(&a2, "answered"));
        }
        Msg::Answered(Err(e)) => {
            log(&app.id, format!("answer not sent: {e}"));
            *app.busy.borrow_mut() = false;
            app.ui.ask_box.set_sensitive(true);
            if let Some(l) = app.ask_status.borrow().as_ref() {
                l.set_text(&format!("{e}. Nothing was sent."));
                l.set_visible(true);
            }
            fit(app);
        }
    }
}

fn quit(app: &Shared, why: &str) {
    log(&app.id, format!("closed: {why}"));
    app.main.quit();
}

pub fn run(id: &str) -> i32 {
    if !notices::valid_entry_id(id) {
        eprintln!("notice: bad id");
        return 64;
    }
    run_with(id, notices::entry(id))
}

/// One notification's card, with the push as the caller already has it (a corner card clicked); Err: the store
/// could not be read for it.
pub fn run_with(id: &str, got: Result<Option<Value>, String>) -> i32 {
    if !notices::valid_entry_id(id) {
        eprintln!("notice: bad id");
        return 64;
    }
    let (entry, unread_why) = match got {
        Ok(e) => (e, None),
        Err(e) => (None, Some(e)),
    };
    if gtk::init().is_err() {
        log(id, "no display");
        return 2;
    }
    crate::window::style(CSS);
    let main = glib::MainLoop::new(None, false);
    let win = gtk::Window::new();
    win.add_css_class("ns-win");
    win.set_default_size(WIDTH, -1);
    crate::icons::set_default_window_icon();
    let outer = gtk::Box::new(gtk::Orientation::Vertical, 12);
    outer.set_margin_top(20);
    outer.set_margin_bottom(20);
    outer.set_margin_start(20);
    outer.set_margin_end(20);
    let head = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let brand = label("AICO NOTIFICATION", "ns-brand");
    brand.set_hexpand(true);
    head.append(&brand);
    let title = label("", "ns-ttl");
    let lead = label("", "ns-lead");
    let meta = label("", "ns-meta");
    let now = gtk::Box::new(gtk::Orientation::Horizontal, 12);
    now.add_css_class("ns-key");
    let spinner = gtk::Spinner::new();
    spinner.set_size_request(24, 24);
    spinner.set_valign(gtk::Align::Start);
    let ncol = gtk::Box::new(gtk::Orientation::Vertical, 6);
    ncol.set_hexpand(true);
    let nhead = label("", "ns-khead");
    let ntext = gtk::Box::new(gtk::Orientation::Vertical, 4);
    ncol.append(&nhead);
    ncol.append(&ntext);
    now.append(&spinner);
    now.append(&ncol);
    let details = gtk::Box::new(gtk::Orientation::Vertical, 6);
    details.set_margin_top(8);
    let details_box = gtk::Expander::new(Some("Details"));
    details_box.set_child(Some(&details));
    let extras = gtk::Box::new(gtk::Orientation::Vertical, 8);
    let ask_box = gtk::Box::new(gtk::Orientation::Vertical, 8);
    ask_box.add_css_class("ns-key");
    ask_box.add_css_class("ns-attn");
    ask_box.set_visible(false);
    let body = gtk::Box::new(gtk::Orientation::Vertical, 12);
    for w in [title.upcast_ref::<gtk::Widget>(), lead.upcast_ref(), meta.upcast_ref(), ask_box.upcast_ref(), now.upcast_ref(),
              details_box.upcast_ref(), extras.upcast_ref()] {
        body.append(w);
    }
    let scroll = gtk::ScrolledWindow::new();
    scroll.set_policy(gtk::PolicyType::Never, gtk::PolicyType::Automatic);
    scroll.set_propagate_natural_height(true);
    scroll.set_max_content_height(560);
    scroll.set_child(Some(&body));
    let answers = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let keyline = label("", "ns-meta");
    keyline.set_visible(false);
    let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let views = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let gap = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    gap.set_hexpand(true);
    let close = gtk::Button::with_label("Close");
    close.add_css_class("ns-flat");
    for w in [views.upcast_ref::<gtk::Widget>(), gap.upcast_ref(), close.upcast_ref()] {
        row.append(w);
    }
    for w in [head.upcast_ref::<gtk::Widget>(), scroll.upcast_ref(), keyline.upcast_ref(), answers.upcast_ref(),
              row.upcast_ref()] {
        outer.append(w);
    }
    win.set_child(Some(&outer));
    let (tx, rx) = async_channel::unbounded::<Msg>();
    // what the log says at once; its state now follows from Aico's own words (the tray door's card)
    let first = entry.as_ref().map(|e| json!({"title": e["title"], "body": e["body"], "ts": e["ts"], "kind": ""}))
        .unwrap_or_else(|| json!({"title": "Notification"}));
    let ui = Ui { win: win.clone(), body, scroll, title, lead, meta, now, spinner, nhead, ntext, details_box, details,
                  extras, ask_box, keyline, answers, views };
    let ask_id = entry.as_ref().and_then(ask::id_of);
    let missing = entry.is_none();
    let app: Shared = Rc::new(App { ui, id: id.into(), ask: ask_id.clone(), entry, ask_status: RefCell::new(None),
                                    card: RefCell::new(first), busy: RefCell::new(false),
                                    then: RefCell::new(None), tx: tx.clone(), main: main.clone() });
    render(&app);
    if let Some(why) = unread_why {
        now_panel(&app, "Unknown: Aico can't be read", &[why], "", false);
    } else if missing {
        now_panel(&app, "Not in the log any more", &["Notifications are kept for 30 days (at most 500).".into()], "", false);
    } else {
        now_panel(&app, "", &["Checking its state now...".into()], "wait", true);
        let (id2, tx2) = (id.to_string(), tx.clone());
        std::thread::spawn(move || {
            let _ = tx2.send_blocking(Msg::Card(card(&id2)));
        });
        if let Some(q) = ask_id {
            app.ui.ask_box.set_visible(true);
            app.ui.ask_box.append(&label("Reading the agent's question...", "ns-ksub"));
            std::thread::spawn(move || {
                let _ = tx.send_blocking(Msg::Ask(ask::get(&q)));
            });
        }
    }
    {
        let a2 = app.clone();
        glib::spawn_future_local(async move {
            while let Ok(m) = rx.recv().await {
                on_msg(&a2, m);
            }
        });
        let a2 = app.clone();
        close.connect_clicked(move |_| quit(&a2, "Close pressed"));
        let a2 = app.clone();
        win.connect_close_request(move |_| {
            quit(&a2, "window closed");
            glib::Propagation::Stop
        });
        let keys = gtk::EventControllerKey::new();
        keys.set_propagation_phase(gtk::PropagationPhase::Capture); // before a focused button or text field, as the approval card
        let a2 = app.clone();
        keys.connect_key_pressed(move |_, key, _, _| {
            if key == gtk::gdk::Key::Escape {
                quit(&a2, "Escape pressed");
            }
            glib::Propagation::Proceed
        });
        win.add_controller(keys);
        let a2 = app.clone();
        app.ui.details_box.connect_expanded_notify(move |_| fit(&a2));
    }
    crate::anchor::place(&win, crate::anchor::Opts::default());
    win.present();
    close.grab_focus();
    log(id, "shown");
    main.run();
    win.set_visible(false);
    let then = app.then.borrow_mut().take();
    match then {
        // the key's card in this same place: the owner pressed an answer or Approve here
        Some(Then::Card { id, kind }) => crate::window::run(&id, false, &crate::ask_url(&kind, &id), false),
        None => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[Value]) -> Vec<&str> {
        v.iter().map(|a| s(a, "id")).collect()
    }

    #[test]
    fn shows_the_cards_actions_in_order_as_the_panel_does() {
        let d: Value = serde_json::from_str(include_str!("../tests/fixtures/tray-sample.json")).unwrap();
        for n in d["notifications"].as_array().unwrap() {
            let acts = n["actions"].as_array().unwrap();
            assert_eq!(ids(&place(acts, false)), ids(acts), "{}", n["id"]);
        }
    }

    #[test]
    fn a_question_answered_here_drops_answer_and_actions_it_does_not_know_are_left_out() {
        let acts = vec![json!({"id": "answer", "tier": "plain"}), json!({"id": "something-new", "tier": "plain"}),
                        json!({"id": "mark-read", "tier": "view"})];
        assert_eq!(ids(&place(&acts, true)), vec!["mark-read"]);
        assert_eq!(ids(&place(&acts, false)), vec!["answer", "mark-read"]);
    }
}
