//! The approval window: exactly what root froze for one ask (the approve page's own text, from the approve uid's
//! local socket), time left, and Approve / Deny with the security key. Approve from the notification starts the key
//! at once (PIN first when the key needs one for user verification, then "Touch your key"); Review waits for a click.
//! Enter in the PIN field and the Approve button both submit the PIN. The answer goes back over the local socket and
//! root verifies it. Then the next open ask, closing after the last. "Open in browser" is today's web page, always there
//! as the fallback. Every step goes to the unit journal (never the PIN), and every failure shows in the window.
//! The signing handover also asks the key for its unlock secret (hmac-secret, sealed to root: seal.rs); it is never
//! logged or written anywhere.

use crate::fido::{self, Fido};
use crate::key::Key;
use crate::{browser, proto};
use gtk::glib;
use gtk::prelude::*;
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

static FIDO: OnceLock<Result<Fido, String>> = OnceLock::new();
static WAITING_DEV: Mutex<Option<usize>> = Mutex::new(None); // the key handle while it waits for the touch
static ID8: OnceLock<String> = OnceLock::new();

fn fido_lib() -> Result<&'static Fido, String> {
    FIDO.get_or_init(|| Fido::load().map_err(|e| format!("{e:?}"))).as_ref().map_err(Clone::clone)
}

/// The look of a window of this app (after gtk::init): dark theme, the shared CSS, plus `extra`.
pub fn style(extra: &str) {
    #[allow(deprecated)] // the colours below are explicit; this keeps built-in widgets (menus, selection) dark too
    if let Some(settings) = gtk::Settings::default() {
        settings.set_gtk_application_prefer_dark_theme(true);
    }
    let provider = gtk::CssProvider::new();
    provider.load_from_data(&format!("{CSS}{extra}"));
    if let Some(display) = gtk::gdk::Display::default() {
        gtk::style_context_add_provider_for_display(&display, &provider, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
    }
}

/// One journal line for this window: "window 1a2b3c4d: <what happened>".
pub fn log(msg: impl AsRef<str>) {
    eprintln!("window {}: {}", ID8.get().map_or("-", String::as_str), msg.as_ref());
}

// Aico's palette (status and approve page tokens): dark, low glare, whatever the desktop theme is.
const CSS: &str = "
window.ns-win { background-color: #0f1218; color: #e6e9f0; }
window.ns-win.ns-popover { border-radius: 12px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6), 0 0 0 1px #2b3242; }
window.ns-popover .titlebar { min-height: 0; padding: 0; border: none; background: none; box-shadow: none; }
.ns-win label { color: #e6e9f0; }
.ns-win label.ns-brand { color: #a3abbc; font-size: 0.82em; font-weight: 600; letter-spacing: 1px; }
.ns-win label.ns-left { color: #a3abbc; font-size: 0.9em; }
.ns-win label.ns-left-low { color: #f2b552; font-weight: bold; }
.ns-win label.ns-title { font-size: 1.55em; font-weight: bold; }
.ns-win label.ns-lead { color: #c3c9d6; }
.ns-win expander-widget title label { color: #a3abbc; font-weight: normal; }
.ns-win expander-widget title expander { color: #a3abbc; }
.ns-win label.ns-dt { color: #a3abbc; font-size: 0.92em; }
.ns-win label.ns-dd { font-size: 0.92em; }
.ns-key { background-color: #181c25; border: 1px solid #2b3242; border-radius: 10px; padding: 14px 16px; }
.ns-key.ns-wait { background-color: #152238; border-color: #35507f; }
.ns-key.ns-ok { background-color: #12291d; border-color: #2f6b49; }
.ns-key.ns-bad { background-color: #341719; border-color: #7a3a44; }
.ns-win label.ns-khead { font-size: 1.2em; font-weight: bold; }
.ns-win label.ns-ksub { color: #c3c9d6; }
.ns-icon { color: #86b4ff; }
.ns-icon.ns-ok { color: #5fd08f; }
.ns-icon.ns-bad { color: #ff6f6f; }
@keyframes ns-pulse { from { opacity: 1; } to { opacity: 0.3; } }
.ns-pulse { animation: ns-pulse 0.8s ease-in-out infinite alternate; }
.ns-win entry.ns-pin { background-color: #0f1218; background-image: none; color: #e6e9f0; border: 1px solid #4a5468;
  border-radius: 8px; min-height: 38px; padding: 0 10px; font-size: 1.2em; caret-color: #e6e9f0; box-shadow: none; outline: none; }
.ns-win entry.ns-pin:focus-within { border-color: #ffe08a; }
.ns-win entry.ns-pin:focus-within placeholder { opacity: 0; }
.ns-win button { background-image: none; background-color: #1f2430; color: #e6e9f0; border: 1px solid #4a5468;
  border-radius: 8px; padding: 8px 16px; box-shadow: none; text-shadow: none; min-height: 24px; }
.ns-win button:hover { background-color: #273150; }
.ns-win:not(:backdrop) button:focus-visible { outline: 2px solid #ffe08a; outline-offset: 2px; }
.ns-win button:disabled { opacity: 0.5; }
.ns-win button.ns-go { background-color: #2f8f5b; border-color: #37a368; color: #ffffff; font-weight: bold; padding: 8px 26px; }
.ns-win button.ns-go:hover { background-color: #37a368; }
.ns-win button.ns-go label, .ns-win button label { color: inherit; }
.ns-win button.ns-flat { background-color: transparent; border-color: transparent; color: #86b4ff; }
.ns-win button.ns-flat:hover { background-color: #181c25; }
";

enum Msg {
    NeedPin { retries: Option<i32>, wrong: bool },
    Touch,
    Posted,
    Outcome(Value),
    /// The ask was fetched again just before signing and can't be signed as shown: new text, or no longer open.
    Refreshed(Value),
    Failed { text: String, forget_pin: bool },
}

/// What the key panel shows.
enum Panel {
    Hidden,
    Working(&'static str),
    Pin { retries: Option<i32>, wrong: bool },
    Touch,
    Done { ok: bool, head: String, text: String },
    Note(String),
    Failed(String),
}

struct Ui {
    win: gtk::Window,
    body: gtk::Box,
    scroll: gtk::ScrolledWindow,
    brand: gtk::Label,
    left: gtk::Label,
    title: gtk::Label,
    lead: gtk::Label,
    details_box: gtk::Expander,
    details: gtk::Grid,
    key: gtk::Box,
    icon: gtk::Image,
    spinner: gtk::Spinner,
    khead: gtk::Label,
    ksub: gtk::Label,
    pin: gtk::Entry,
    approve: gtk::Button,
    deny: gtk::Button,
    browser: gtk::Button,
}

#[derive(Default)]
struct State {
    id: String,
    ask: Value,
    done: HashSet<String>,
    answered: u32,
    pin: Option<String>,
    busy: bool,
    pin_shown: bool,
    pin_for: Option<&'static str>,
    leaving: bool,
    first_url: String, // the notifier's link for the first ask (built from the site file and root's list)
}

/// "Open in browser": the approve page for the ask shown, built from root's site file, never from the reply.
fn page_url(st: &State) -> String {
    let kind = s(&st.ask, "kind");
    if kind.is_empty() || st.ask.get("error").is_some() {
        return st.first_url.clone();
    }
    crate::ask_url(kind, &st.id)
}

type Shared = Rc<(Ui, RefCell<State>, async_channel::Sender<Msg>)>;

fn label(text: &str, class: &str) -> gtk::Label {
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

fn classes(w: &impl IsA<gtk::Widget>, on: &[&str], all: &[&str]) {
    let w = w.as_ref();
    for c in all {
        w.remove_css_class(c);
    }
    for c in on {
        w.add_css_class(c);
    }
}

fn clear(c: &gtk::Grid) {
    while let Some(w) = c.first_child() {
        c.remove(&w);
    }
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}

fn now() -> f64 {
    crate::daemon::now()
}

fn left_secs(ask: &Value) -> f64 {
    ask["expires"].as_f64().unwrap_or(0.0) - now()
}

fn left_text(ask: &Value) -> String {
    let left = left_secs(ask);
    if left <= 0.0 {
        return "Time is up".into();
    }
    let m = (left / 60.0).floor() as i64;
    if m >= 120 {
        format!("{} h left", m / 60)
    } else if m >= 1 {
        format!("{m} min left")
    } else {
        format!("{} s left", left as i64)
    }
}

fn signable(ask: &Value) -> bool {
    ask["state"] == "pending" && ask["challenges"].is_object() && ask["local"].is_null()
}

/// What the owner reads on the card. Root's challenges are not in it: they may change (a batch joining) without the text.
fn card_text(ask: &Value) -> Vec<&Value> {
    ["title", "lead", "details", "yes"].iter().map(|k| &ask[*k]).collect()
}

/// Whether a fresh copy of the ask may be signed for the card on screen: it must still be signable and read the same.
/// Its `challenges` are then the ones to sign, since a joined batch rebinds them.
fn same_card(shown: &Value, fresh: &Value) -> bool {
    signable(fresh) && card_text(shown) == card_text(fresh)
}

fn buttons(app: &Shared) {
    let (ui, state) = (&app.0, app.1.borrow());
    let ok = signable(&state.ask) && !state.busy;
    ui.approve.set_sensitive(ok);
    ui.deny.set_sensitive(ok);
    ui.browser.set_sensitive(!page_url(&state).is_empty());
}

fn panel(app: &Shared, p: Panel) {
    let ui = &app.0;
    let all = ["ns-wait", "ns-ok", "ns-bad"];
    let (tone, icon, spin, head, sub, pin): (&str, &str, bool, String, String, bool) = match p {
        Panel::Hidden => {
            ui.key.set_visible(false);
            app.1.borrow_mut().pin_shown = false;
            return;
        }
        Panel::Working(t) => ("ns-wait", "", true, t.into(), String::new(), false),
        Panel::Pin { retries, wrong } => {
            let tries = match retries {
                Some(n) if n <= 3 => format!(" {n} tries left before the key locks."),
                Some(n) => format!(" {n} tries left."),
                None => String::new(),
            };
            if wrong {
                ("ns-bad", "dialog-password-symbolic", false, "Wrong PIN".into(), format!("Type it again.{tries}"), true)
            } else {
                ("", "dialog-password-symbolic", false, "Enter your security key PIN".into(),
                 "Then press Enter or Approve.".into(), true)
            }
        }
        Panel::Touch => ("ns-wait", "auth-fingerprint-symbolic", false, "Touch your security key".into(),
                         "Touch its contact when it blinks.".into(), false),
        Panel::Done { ok, head, text } => (if ok { "ns-ok" } else { "" }, if ok { "emblem-ok-symbolic" } else { "action-unavailable-symbolic" },
                                           false, head, text, false),
        Panel::Note(t) => ("", "dialog-information-symbolic", false, t, String::new(), false),
        Panel::Failed(t) => ("ns-bad", "dialog-error-symbolic", false, "Not sent".into(), t, false),
    };
    classes(&ui.key, &[tone].into_iter().filter(|t| !t.is_empty()).collect::<Vec<_>>(), &all);
    let icon_tone = match tone { "ns-ok" => "ns-ok", "ns-bad" => "ns-bad", _ => "" };
    classes(&ui.icon, &[icon_tone].into_iter().filter(|t| !t.is_empty()).collect::<Vec<_>>(), &["ns-ok", "ns-bad", "ns-pulse"]);
    if icon == "auth-fingerprint-symbolic" {
        ui.icon.add_css_class("ns-pulse");
    }
    ui.icon.set_icon_name(Some(icon).filter(|i| !i.is_empty()));
    ui.icon.set_pixel_size(48); // the old Dialog icon size
    ui.icon.set_visible(!icon.is_empty() && !spin);
    ui.spinner.set_visible(spin);
    ui.spinner.set_spinning(spin);
    ui.khead.set_text(&head);
    ui.ksub.set_text(&sub);
    ui.ksub.set_visible(!sub.is_empty());
    ui.pin.set_visible(pin);
    ui.key.set_visible(true);
    app.1.borrow_mut().pin_shown = pin;
    if pin {
        ui.pin.set_text("");
        ui.pin.grab_focus();
    }
    fit(app);
}

/// Fit the content (all of it up to 520 px, then it scrolls), with no leftover space from the last state. Measured
/// once layout has settled, so an opened Details or a longer message is counted.
/// Narrow, so it sits in the screen's right-hand corner by the tray and never over the middle.
const WIDTH: i32 = 460;

fn fit(app: &Shared) {
    // the content's width at the window's real width (the outer box has 20 px margins), not what the scroll area
    // holds while the window is still the size of its first, everything-visible layout
    fn apply(ui: &Ui) {
        let (_, natural, _, _) = ui.body.measure(gtk::Orientation::Vertical, WIDTH - 40);
        ui.scroll.set_max_content_height(natural.clamp(1, 520));
        ui.scroll.set_min_content_height(natural.min(520));
        ui.win.set_default_size(WIDTH, 1);
    }
    let a2 = app.clone();
    glib::idle_add_local_once(move || {
        apply(&a2.0);
        let a3 = a2.clone();
        glib::timeout_add_local_once(Duration::from_millis(120), move || apply(&a3.0)); // after the panel's own relayout
    });
}

fn render(app: &Shared) {
    let ui = &app.0;
    let state = app.1.borrow();
    let a = &state.ask;
    let open = proto::open_ids().into_iter().filter(|x| !state.done.contains(x) && *x != state.id).count() as u32;
    let total = state.answered + 1 + open;
    ui.brand.set_text(&if total > 1 { format!("AICO APPROVAL · {} OF {total}", state.answered + 1) } else {
        "AICO APPROVAL".into()
    });
    ui.win.set_title(Some(&format!("Aico: {}", s(a, "title"))));
    ui.title.set_text(s(a, "title"));
    ui.lead.set_text(s(a, "lead"));
    ui.lead.set_visible(!s(a, "lead").is_empty());
    clear(&ui.details);
    for (i, row) in a["details"].as_array().cloned().unwrap_or_default().iter().enumerate() {
        let k = label(row[0].as_str().unwrap_or(""), "ns-dt");
        k.set_yalign(0.0);
        k.set_max_width_chars(22);
        let v = label(row[1].as_str().unwrap_or(""), "ns-dd");
        v.set_hexpand(true);
        ui.details.attach(&k, 0, i as i32, 1, 1);
        ui.details.attach(&v, 1, i as i32, 1, 1);
    }
    ui.details_box.set_expanded(false);
    tick_left(ui, a);
    let (pending, local) = (a["state"] == "pending", a["local"].as_str().map(str::to_string));
    let ended = format!("{}. {}", s(a, "label"), s(a, "text"));
    let ok = matches!(s(a, "state"), "applied" | "approved" | "no-op");
    drop(state);
    ui.win.set_visible(true);
    if !pending {
        panel(app, Panel::Done { ok, head: ended.trim_end_matches(". ").to_string(), text: String::new() });
    } else if let Some(why) = local {
        panel(app, Panel::Note(why));
    } else {
        panel(app, Panel::Hidden);
    }
    fit(app);
    buttons(app);
}

fn tick_left(ui: &Ui, ask: &Value) {
    ui.left.set_text(&left_text(ask));
    let low = left_secs(ask) < 120.0;
    classes(&ui.left, if low { &["ns-left-low"] } else { &[] }, &["ns-left-low"]);
}

/// Work on the key and with root, off the UI thread.
fn worker(tx: async_channel::Sender<Msg>, ask: Value, decision: &'static str, pin: Option<String>) {
    let fail = |text: &str, forget_pin: bool| {
        log(format!("not sent: {text}"));
        let _ = tx.send_blocking(Msg::Failed { text: text.into(), forget_pin });
    };
    // Root rebinds the challenge when another ask joins a batch after this card opened, so sign only a fresh copy.
    let ask = match proto::ask(s(&ask, "id")) {
        Ok(fresh) if same_card(&ask, &fresh) => fresh,
        Ok(fresh) if fresh.get("error").is_none() => {
            log(format!("{decision}: the ask changed since the card opened; showing it again"));
            let _ = tx.send_blocking(Msg::Refreshed(fresh));
            return;
        }
        Ok(fresh) => return fail(&format!("Couldn't re-check the ask with root: {}. Nothing was sent.", s(&fresh, "error")), false),
        Err(e) => return fail(&format!("Couldn't re-check the ask with root ({e}). Nothing was sent."), false),
    };
    log(format!("{decision}: looking for the security key"));
    let dev = match Key::find(fido_lib(), &|m| log(m)) {
        Ok(d) => d,
        Err(text) => return fail(&text, false),
    };
    let builtin_uv = dev.has_uv();
    let has_pin = dev.has_pin();
    log(format!("key {}: PIN set {has_pin}, built-in verification {builtin_uv}, PIN tries left {:?}", dev.path(), dev.pin_retries()));
    if !builtin_uv && !has_pin {
        return fail("This key has no PIN, so it can't verify you here. Open in browser instead.", false);
    }
    if !builtin_uv && pin.is_none() {
        log("PIN needed: asking for it");
        let _ = tx.send_blocking(Msg::NeedPin { retries: dev.pin_retries(), wrong: false });
        return;
    }
    let id = s(&ask, "id").to_string();
    let challenge = match proto::unhex(s(&ask["challenges"], decision)) {
        Some(c) if c.len() == 32 => c,
        _ => return fail("Root's challenge for this ask is missing. Open in browser instead.", false),
    };
    // the signing handover: the key's unlock secret too (hmac-secret with the browser's PRF salt, seal.rs)
    let want_prf = decision == "approve" && ask["prf"].is_object();
    let hmac_salt = if want_prf {
        match ask["prf"]["salt"].as_str().and_then(proto::unb64url) {
            Some(v) if v.len() == 32 => Some(crate::seal::prf_salt(&v)),
            _ => return fail("Root's unlock request for this signing is malformed. Open in browser instead.", false),
        }
    } else {
        None
    };
    let creds: Vec<Vec<u8>> = ask["creds"].as_array().cloned().unwrap_or_default().iter()
        .filter_map(|c| c.as_str().and_then(proto::unb64url)).collect();
    if creds.is_empty() {
        return fail("No passkey is enrolled for this ask. Open in browser instead.", false);
    }
    // The key is asked only for the approve host named in root's site file, with the local origin root expects for
    // it: never a site or origin the approve service's reply names (it could name another site's login).
    let host = crate::approve_host();
    let origin = format!("nightshift-desktop://{host}");
    if host.is_empty() || s(&ask, "rp") != host || s(&ask, "origin") != origin {
        return fail("This ask names another site than the approve host, so the key was not asked. Open in browser instead.", false);
    }
    let cdj = proto::client_data(&challenge, &origin);
    let cdh = proto::sha256(&cdj);
    log(format!("asking the key for {host} ({} credential(s), {}{}); waiting for the touch", creds.len(),
                if pin.is_some() { "PIN given" } else { "built-in verification" },
                if want_prf { ", unlock secret" } else { "" }));
    let _ = tx.send_blocking(Msg::Touch);
    let asked = Instant::now();
    *WAITING_DEV.lock().unwrap() = dev.handle();
    let res = dev.assert(&host, &cdh, &creds, pin.as_deref(), true, hmac_salt.as_ref());
    *WAITING_DEV.lock().unwrap() = None;
    let a = match res {
        Ok(a) => a,
        Err(fido::Error::Code(c, msg)) => {
            log(format!("key answered with error {c:#x} ({msg}) after {:.0} ms", asked.elapsed().as_secs_f64() * 1000.0));
            return match c {
                fido::ERR_PIN_INVALID => {
                    let _ = tx.send_blocking(Msg::NeedPin { retries: dev.pin_retries(), wrong: true });
                }
                fido::ERR_PIN_AUTH_INVALID | fido::ERR_PIN_REQUIRED | fido::ERR_PIN_NOT_SET => {
                    let _ = tx.send_blocking(Msg::NeedPin { retries: dev.pin_retries(), wrong: false });
                }
                fido::ERR_PIN_AUTH_BLOCKED => fail("Too many wrong PINs in a row. Unplug the key, plug it back in, then try again.", true),
                fido::ERR_PIN_BLOCKED => fail("The PIN is blocked on this key. Open in browser to use another passkey.", true),
                fido::ERR_NO_CREDENTIALS => fail("This key isn't one of your passkeys. Open in browser to use another.", false),
                fido::ERR_ACTION_TIMEOUT => fail("No touch in time, so nothing was sent. Press Approve to try again.", false),
                fido::ERR_KEEPALIVE_CANCEL => fail("The key stopped waiting, so nothing was sent. Press Approve to try again.", false),
                fido::ERR_OPERATION_DENIED => fail("The key turned it down, so nothing was sent.", false),
                fido::ERR_UV_BLOCKED => fail("The key's own check is blocked. Open in browser instead.", true),
                fido::ERR_RX => fail("The key stopped answering. Check it's plugged in, then try again.", false),
                _ => fail(&format!("The key said: {msg}. Nothing was sent. Try again or open in browser."), false),
            };
        }
        Err(e) => {
            log(format!("key error {e:?}"));
            return fail("The key stopped answering. Try again or open in browser.", false);
        }
    };
    let touched = Instant::now();
    log(format!("key answered after {:.0} ms; sending to root", asked.elapsed().as_secs_f64() * 1000.0));
    let mut msg = proto::answer(&id, decision, &a.credential_id, &a.auth_data, &cdj, &a.signature);
    if want_prf {
        let secret = a.hmac_secret.as_ref().filter(|v| v.len() == 32);
        if secret.is_none() {
            return fail("This key gave no unlock secret, so it can't sign. Nothing was sent. Open in browser to use another passkey.", false);
        }
        if let Some(secret) = secret {
            match crate::seal::seal_prf(secret, s(&ask["prf"], "transport"), &id, &proto::b64url(&a.credential_id)) {
                Ok(v) => msg["prf"] = v,
                Err(e) => return fail(&format!("The unlock secret couldn't be sealed for root ({e}). Nothing was sent."), false),
            }
        }
    }
    drop(a);
    let posted = match proto::call(&msg) {
        Ok(v) if v["code"] == 200 => v,
        Ok(v) => return fail(&format!("Root's service refused it: {}.", s(&v, "error")), false),
        Err(e) => return fail(&format!("Root's service didn't answer ({e}). Open in browser instead."), false),
    };
    let _ = tx.send_blocking(Msg::Posted);
    let aid = s(&posted, "answer_id").to_string();
    log(format!("answer {aid} posted; waiting for root"));
    let until = Instant::now() + Duration::from_secs(20);
    while Instant::now() < until {
        std::thread::sleep(Duration::from_millis(150));
        let Ok(st) = proto::status(&id) else { continue };
        let rejected = st["rejected_answers"].as_array().is_some_and(|r| r.iter().any(|x| x.as_str() == Some(aid.as_str())));
        if st["state"] == "pending" && rejected {
            return fail("Your key's answer didn't check out, so nothing was done. Try again.", false);
        }
        if st["state"] != "pending" {
            log(format!("{decision}: root recorded {} {:.0} ms after the key answered", s(&st, "state"),
                        touched.elapsed().as_secs_f64() * 1000.0));
            let _ = tx.send_blocking(Msg::Outcome(st));
            return;
        }
    }
    fail("Root hasn't confirmed yet. It may still go through; check the Status page.", false);
}

/// Approve or Deny pressed, or Enter in the PIN field: with the PIN field showing, its text is the PIN.
fn act(app: &Shared, decision: &'static str) {
    {
        let mut st = app.1.borrow_mut();
        if st.busy || !signable(&st.ask) {
            log(format!("{decision} ignored: {}", if st.busy { "already working" } else { "this ask can't be signed here" }));
            return;
        }
        if st.pin_shown {
            let text = app.0.pin.text().to_string();
            app.0.pin.set_text("");
            if text.is_empty() {
                drop(st);
                log(format!("{decision} pressed with an empty PIN field"));
                app.0.ksub.set_text("Type the PIN first, then press Enter or Approve.");
                app.0.ksub.set_visible(true);
                app.0.pin.grab_focus();
                return;
            }
            st.pin = Some(text);
            log(format!("PIN submitted for {decision}"));
        }
        st.busy = true;
        st.pin_for = Some(decision);
    }
    buttons(app);
    panel(app, Panel::Working("Looking for your security key..."));
    let (tx, ask, pin) = { let st = app.1.borrow(); (app.2.clone(), st.ask.clone(), st.pin.clone()) };
    std::thread::spawn(move || worker(tx, ask, decision, pin));
}

fn finish(app: &Shared, wait_ms: u64) {
    if std::mem::replace(&mut app.1.borrow_mut().leaving, true) {
        return;
    }
    let a2 = app.clone();
    glib::timeout_add_local_once(Duration::from_millis(wait_ms), move || next(&a2));
}

/// The next open ask (oldest deadline first, never one this window already handled), or close.
fn next(app: &Shared) {
    let skip: HashSet<String> = { let st = app.1.borrow(); st.done.iter().cloned().chain([st.id.clone()]).collect() };
    for id in proto::open_ids() {
        if skip.contains(&id) {
            continue;
        }
        if let Ok(ask) = proto::ask(&id) {
            if ask["state"] == "pending" {
                log(format!("next open ask {}", &id[..8]));
                {
                    let mut st = app.1.borrow_mut();
                    let old = std::mem::take(&mut st.id);
                    st.done.insert(old);
                    st.id = id;
                    st.ask = ask;
                    st.busy = false;
                    st.leaving = false;
                }
                render(app);
                app.0.approve.grab_focus();
                return;
            }
        }
    }
    quit("no more open asks");
}

fn quit(why: &str) {
    log(format!("closed: {why}"));
    let waiting = WAITING_DEV.lock().unwrap(); // held across cancel: the worker clears it before the device is freed
    if let (Some(h), Ok(lib)) = (*waiting, fido_lib()) {
        fido::cancel(lib, h);
    }
    std::process::exit(0);
}

fn on_msg(app: &Shared, msg: Msg) {
    match msg {
        Msg::NeedPin { retries, wrong } => {
            {
                let mut st = app.1.borrow_mut();
                st.busy = false;
                st.pin = None;
            }
            buttons(app);
            panel(app, Panel::Pin { retries, wrong });
        }
        Msg::Touch => panel(app, Panel::Touch),
        Msg::Posted => panel(app, Panel::Working("Sent. Root is checking it...")),
        Msg::Outcome(st) => {
            let state = s(&st, "state").to_string();
            let ok = matches!(state.as_str(), "approved" | "applied" | "no-op");
            let head = if state == "denied" { "Denied".into() } else if ok { "Approved".to_string() } else {
                s(&st, "label").to_string()
            };
            panel(app, Panel::Done { ok, head, text: s(&st, "text").to_string() });
            {
                let mut a = app.1.borrow_mut();
                a.answered += 1;
                a.ask["state"] = Value::String(state);
            }
            buttons(app);
            finish(app, 900);
        }
        Msg::Refreshed(fresh) => {
            let open = signable(&fresh);
            {
                let mut st = app.1.borrow_mut();
                st.busy = false;
                st.pin = None;
                st.ask = fresh;
            }
            render(app);
            if open {
                panel(app, Panel::Note("This ask changed while it was open. Check it again, then press Approve.".into()));
            } else if app.1.borrow().ask["state"] != "pending" {
                finish(app, 2500);
            }
        }
        Msg::Failed { text, forget_pin } => {
            {
                let mut st = app.1.borrow_mut();
                st.busy = false;
                if forget_pin {
                    st.pin = None;
                }
            }
            panel(app, Panel::Failed(text));
            buttons(app);
        }
    }
}

/// Every second the time left; every 2 s whether the ask ended elsewhere (phone, web, expiry) while it is shown.
fn watch_status(app: &Shared) {
    let a2 = app.clone();
    glib::timeout_add_local(Duration::from_secs(1), move || {
        let (id, ask, busy) = { let st = a2.1.borrow(); (st.id.clone(), st.ask.clone(), st.busy) };
        tick_left(&a2.0, &ask);
        if busy || ask["state"] != "pending" || a2.1.borrow().leaving {
            return glib::ControlFlow::Continue;
        }
        if (now() as u64).is_multiple_of(2) || ask["expires"].as_f64().unwrap_or(0.0) <= now() {
            if let Ok(st) = proto::status_ui(&id) {
                if st["state"].is_string() && st["state"] != "pending" {
                    log(format!("ended elsewhere: {}", s(&st, "state")));
                    a2.1.borrow_mut().ask["state"] = st["state"].clone();
                    panel(&a2, Panel::Done { ok: matches!(s(&st, "state"), "applied" | "approved" | "no-op"),
                                             head: s(&st, "label").to_string(), text: s(&st, "text").to_string() });
                    buttons(&a2);
                    finish(&a2, 2500);
                }
            }
        }
        glib::ControlFlow::Continue
    });
}

/// `passive`: opened because an ask arrived, not by a click: shows without taking the keyboard, and takes it (into the
/// PIN field when one is up) once the owner clicks anywhere on it.
pub fn run(id: &str, review: bool, fallback_url: &str, passive: bool) -> i32 {
    let t0 = Instant::now();
    if !proto::valid_id(id) {
        eprintln!("window: bad id");
        return 64;
    }
    let _ = ID8.set(id[..8].to_string());
    let first = proto::ask(id).unwrap_or_else(|e| serde_json::json!({"id": id, "error": e}));
    if first.get("error").is_some() && fallback_url.starts_with("https://") {
        // root's local service is not there (not installed yet, or down): today's browser path, as if never here
        log(format!("{}; opening the approve page instead", s(&first, "error")));
        browser::open(&if review { fallback_url.to_string() } else { format!("{fallback_url}#approve") });
        return 0;
    }
    if gtk::init().is_err() {
        log("no display");
        return 2;
    }
    style("");
    let main = glib::MainLoop::new(None, false);
    let win = gtk::Window::new();
    win.add_css_class("ns-win");
    win.set_default_size(WIDTH, -1);
    crate::icons::set_default_window_icon();
    let outer = gtk::Box::new(gtk::Orientation::Vertical, 14);
    outer.set_margin_top(20);
    outer.set_margin_bottom(20);
    outer.set_margin_start(20);
    outer.set_margin_end(20);
    let head = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let brand = label("AICO APPROVAL", "ns-brand");
    brand.set_hexpand(true);
    let left = label("", "ns-left");
    left.set_xalign(1.0);
    head.append(&brand);
    head.append(&left);
    let title = label("", "ns-title");
    let lead = label("", "ns-lead");
    let details = gtk::Grid::new();
    details.set_column_spacing(16);
    details.set_row_spacing(6);
    details.set_margin_top(8);
    let details_box = gtk::Expander::new(Some("Details"));
    details_box.set_child(Some(&details));
    let body = gtk::Box::new(gtk::Orientation::Vertical, 12);
    for w in [title.upcast_ref::<gtk::Widget>(), lead.upcast_ref(), details_box.upcast_ref()] {
        body.append(w);
    }
    let scroll = gtk::ScrolledWindow::new();
    scroll.set_policy(gtk::PolicyType::Never, gtk::PolicyType::Automatic);
    scroll.set_propagate_natural_height(true);
    scroll.set_max_content_height(520);
    scroll.set_child(Some(&body));
    // the key panel: PIN, touch, sending, the result or what went wrong
    let key = gtk::Box::new(gtk::Orientation::Horizontal, 14);
    key.add_css_class("ns-key");
    let icon = gtk::Image::new();
    icon.add_css_class("ns-icon");
    icon.set_valign(gtk::Align::Start);
    let spinner = gtk::Spinner::new();
    spinner.set_size_request(32, 32);
    spinner.set_valign(gtk::Align::Start);
    let ktext = gtk::Box::new(gtk::Orientation::Vertical, 6);
    ktext.set_hexpand(true);
    let khead = label("", "ns-khead");
    let ksub = label("", "ns-ksub");
    for l in [&khead, &ksub] {
        l.set_width_chars(46); // a wide minimum, so the window's smallest height is the height at its real width
    }
    let pin = gtk::Entry::new();
    pin.add_css_class("ns-pin");
    pin.set_visibility(false);
    pin.set_input_purpose(gtk::InputPurpose::Pin);
    pin.set_placeholder_text(Some("PIN"));
    pin.set_max_width_chars(16);
    pin.set_halign(gtk::Align::Start);
    for w in [khead.upcast_ref::<gtk::Widget>(), ksub.upcast_ref(), pin.upcast_ref()] {
        ktext.append(w);
    }
    key.append(&icon);
    key.append(&spinner);
    key.append(&ktext);
    let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let approve = gtk::Button::with_label("Approve");
    approve.add_css_class("ns-go");
    let deny = gtk::Button::with_label("Deny");
    let browser_b = gtk::Button::with_label("Open in browser");
    browser_b.add_css_class("ns-flat");
    let close = gtk::Button::with_label("Close");
    close.add_css_class("ns-flat");
    let gap = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    gap.set_hexpand(true);
    for w in [approve.upcast_ref::<gtk::Widget>(), deny.upcast_ref(), gap.upcast_ref(), browser_b.upcast_ref(), close.upcast_ref()] {
        row.append(w);
    }
    for w in [head.upcast_ref::<gtk::Widget>(), scroll.upcast_ref(), key.upcast_ref(), row.upcast_ref()] {
        outer.append(w);
    }
    win.set_child(Some(&outer));
    let (tx, rx) = async_channel::unbounded::<Msg>(); // worker results to the GTK thread
    let ui = Ui { win: win.clone(), body, scroll, brand, left, title, lead, details_box, details, key, icon, spinner, khead,
                  ksub, pin, approve, deny, browser: browser_b };
    let state = State { id: id.into(), ask: first, first_url: fallback_url.into(), ..Default::default() };
    let app: Shared = Rc::new((ui, RefCell::new(state), tx));
    {
        let a2 = app.clone();
        glib::spawn_future_local(async move {
            while let Ok(m) = rx.recv().await {
                on_msg(&a2, m);
            }
        });
    }
    {
        let a2 = app.clone();
        app.0.approve.connect_clicked(move |_| {
            log("Approve pressed");
            act(&a2, "approve");
        });
        let a2 = app.clone();
        app.0.deny.connect_clicked(move |_| {
            log("Deny pressed");
            act(&a2, "deny");
        });
        let a2 = app.clone();
        app.0.browser.connect_clicked(move |_| {
            browser::open(&page_url(&a2.1.borrow()));
            quit("Open in browser");
        });
        close.connect_clicked(|_| quit("Close pressed"));
        let a2 = app.clone();
        app.0.pin.connect_activate(move |_| {
            log("Enter in the PIN field");
            let d = a2.1.borrow().pin_for.unwrap_or("approve");
            act(&a2, d);
        });
        win.connect_close_request(|_| {
            quit("window closed");
            glib::Propagation::Proceed
        });
        let keys = gtk::EventControllerKey::new();
        keys.set_propagation_phase(gtk::PropagationPhase::Capture); // before the PIN field sees it, as the window's own handler did
        keys.connect_key_pressed(|_, key, _, _| {
            if key == gtk::gdk::Key::Escape {
                quit("Escape pressed");
            }
            glib::Propagation::Proceed
        });
        win.add_controller(keys);
        let click_at = std::env::var("AICO_CLICK_AT").ok().and_then(|v| v.parse::<f64>().ok());
        win.connect_map(move |_| {
            let since = click_at.map(|c| format!(", {:.0} ms after the click", (now() - c) * 1000.0)).unwrap_or_default();
            log(format!("shown {:.0} ms after start{since}", t0.elapsed().as_secs_f64() * 1000.0));
        });
    }
    {
        let a2 = app.clone();
        app.0.details_box.connect_expanded_notify(move |e| {
            log(if e.is_expanded() { "Details opened" } else { "Details closed" });
            fit(&a2);
        });
    }
    // `passive`: never takes the keyboard from what the owner is typing
    crate::anchor::place(&win, crate::anchor::Opts { passive, ..Default::default() });
    render(&app);
    if app.1.borrow().ask.get("error").is_some() {
        let e = s(&app.1.borrow().ask, "error").to_string();
        log(format!("ask not loaded: {e}"));
        panel(&app, Panel::Failed(format!("Couldn't load this ask ({e}). Open in browser instead.")));
        buttons(&app);
    }
    {
        let a2 = app.clone();
        win.connect_is_active_notify(move |w| {
            // a click on the card: straight into the PIN field when the key wants one
            if w.is_active() && WidgetExt::is_visible(&a2.0.pin) && a2.0.pin.is_sensitive() {
                a2.0.pin.grab_focus();
            }
        });
    }
    if passive {
        log("shown without focus (an ask arrived)");
    } else {
        win.present();
    }
    app.0.approve.grab_focus();
    watch_status(&app);
    // An ask that arrived on its own never reaches for the security key: only the owner's click (tray or card) does.
    if !review && !passive && signable(&app.1.borrow().ask) {
        let a2 = app.clone();
        glib::idle_add_local_once(move || act(&a2, "approve"));
    }
    main.run();
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_ask_signs_only_when_it_reads_the_same() {
        let shown = serde_json::json!({"state": "pending", "title": "Install", "lead": "a", "challenges": {"approve": "aa"}});
        // a batch joining rebinds the challenges only: sign the fresh ones
        let mut fresh = shown.clone();
        fresh["challenges"]["approve"] = "bb".into();
        assert!(same_card(&shown, &fresh));
        // the batch also changes the text the owner reads: show it again instead of signing
        fresh["lead"] = "a, b".into();
        assert!(!same_card(&shown, &fresh));
        // no longer pending, or no longer allowed here: never signed
        let mut ended = shown.clone();
        ended["state"] = "approved".into();
        assert!(!same_card(&shown, &ended));
        let mut local = shown.clone();
        local["local"] = "Needs the browser.".into();
        assert!(!same_card(&shown, &local));
    }
}
