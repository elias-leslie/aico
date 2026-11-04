//! The tray icon (StatusNotifierItem over D-Bus, shown by GNOME's AppIndicator extension), with its menu (DBusMenu).
//! The icon shows how many things wait: approvals, open Status problems and agent reports nobody has read; it turns to
//! the attention icon while an approval waits; the icon is Aico's lantern, with a dot while anything waits. Its menu
//! says what waits, opens the inbox, lists open access grants with "End access now", the quiet hour and the Status page
//! with its problem count.
//! Menu clicks go to the notifier's main loop as `Click`s; the tray itself never touches the key or root.
//! With the GNOME Shell extension running (shell.rs) the item goes Passive, so the extension's moon is the only one.

use gtk::gio;
use gtk::glib::{self, Variant, VariantTy};
use gtk::prelude::ToVariant;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const ITEM_PATH: &str = "/StatusNotifierItem";
const MENU_PATH: &str = "/MenuBar";
const ITEM_IFACE: &str = "org.kde.StatusNotifierItem";
const MENU_IFACE: &str = "com.canonical.dbusmenu";

const ITEM_XML: &str = r#"<node><interface name="org.kde.StatusNotifierItem">
<property name="Category" type="s" access="read"/><property name="Id" type="s" access="read"/>
<property name="Title" type="s" access="read"/><property name="Status" type="s" access="read"/>
<property name="WindowId" type="i" access="read"/><property name="IconName" type="s" access="read"/>
<property name="IconThemePath" type="s" access="read"/><property name="AttentionIconName" type="s" access="read"/>
<property name="ToolTip" type="(sa(iiay)ss)" access="read"/><property name="ItemIsMenu" type="b" access="read"/>
<property name="Menu" type="o" access="read"/><property name="XAyatanaLabel" type="s" access="read"/>
<property name="XAyatanaLabelGuide" type="s" access="read"/>
<method name="Activate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
<method name="SecondaryActivate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
<method name="ContextMenu"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
<method name="Scroll"><arg name="delta" type="i" direction="in"/><arg name="orientation" type="s" direction="in"/></method>
<signal name="NewTitle"/><signal name="NewIcon"/><signal name="NewAttentionIcon"/><signal name="NewToolTip"/>
<signal name="NewStatus"><arg name="status" type="s"/></signal>
<signal name="XAyatanaNewLabel"><arg name="label" type="s"/><arg name="guide" type="s"/></signal>
</interface></node>"#;

const MENU_XML: &str = r#"<node><interface name="com.canonical.dbusmenu">
<property name="Version" type="u" access="read"/><property name="TextDirection" type="s" access="read"/>
<property name="Status" type="s" access="read"/><property name="IconThemePath" type="as" access="read"/>
<method name="GetLayout"><arg type="i" name="parentId" direction="in"/><arg type="i" name="recursionDepth" direction="in"/>
<arg type="as" name="propertyNames" direction="in"/><arg type="u" name="revision" direction="out"/>
<arg type="(ia{sv}av)" name="layout" direction="out"/></method>
<method name="GetGroupProperties"><arg type="ai" name="ids" direction="in"/><arg type="as" name="propertyNames" direction="in"/>
<arg type="a(ia{sv})" name="properties" direction="out"/></method>
<method name="GetProperty"><arg type="i" name="id" direction="in"/><arg type="s" name="name" direction="in"/>
<arg type="v" name="value" direction="out"/></method>
<method name="Event"><arg type="i" name="id" direction="in"/><arg type="s" name="eventId" direction="in"/>
<arg type="v" name="data" direction="in"/><arg type="u" name="timestamp" direction="in"/></method>
<method name="EventGroup"><arg type="a(isvu)" name="events" direction="in"/><arg type="ai" name="idErrors" direction="out"/></method>
<method name="AboutToShow"><arg type="i" name="id" direction="in"/><arg type="b" name="needUpdate" direction="out"/></method>
<method name="AboutToShowGroup"><arg type="ai" name="ids" direction="in"/><arg type="ai" name="updatesNeeded" direction="out"/>
<arg type="ai" name="idErrors" direction="out"/></method>
<signal name="ItemsPropertiesUpdated"><arg type="a(ia{sv})" name="updatedProps"/><arg type="a(ias)" name="removedProps"/></signal>
<signal name="LayoutUpdated"><arg type="u" name="revision"/><arg type="i" name="parent"/></signal>
</interface></node>"#;

/// What a menu click asks the notifier to do.
#[derive(Debug, Clone, PartialEq)]
pub enum Click {
    /// "Open inbox", or a double / middle click on the icon: the inbox panel (panel.rs).
    Inbox,
    Board,
    EndAccess { kind: String },
    /// The newest Aico ask (Tether's feed), a vetted https link.
    Aico { url: String },
    /// "Quiet for 1 hour", or "End quiet now" while one is on (quiet.rs reads which when it is clicked).
    Quiet,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Ask {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub expires: f64,
}

#[derive(Default, Clone, PartialEq)]
pub struct View {
    pub asks: Vec<Ask>,
    pub unread: Option<usize>, // None: the tray has not read the store yet (never a made-up zero)
    pub grants: Vec<crate::published::Grant>,
    pub needs_you: Option<crate::published::NeedsYou>,
    pub aico: crate::published::AicoAsks,
    pub needs_you_at: f64, // when the web service wrote it: an old count reads as unknown when the menu opens
    pub health: Option<String>, // the web service's one-line health summary (same file, same age rule)
    pub quiet_until: f64, // the owner's quiet hour ends then (0: off)
}

#[derive(Default)]
struct Inner {
    view: View,
    revision: u32,
    shown: Vec<(i32, String)>, // the labels of the last layout sent, to see whether the clock changed one
    hidden: bool, // the shell extension shows the moon (shell.rs): this item is Passive
}

pub struct Tray {
    conn: gio::DBusConnection,
    inner: Arc<Mutex<Inner>>,
    _watch: gio::SignalSubscription, // dropping it would unsubscribe
}

const BOARD_ID: i32 = 2;
const HEAD_ID: i32 = 3;
const SEP_ID: i32 = 4;
const HEALTH_ID: i32 = 10;
const QUIET_NOTE_ID: i32 = 11;
const QUIET_ID: i32 = 12;
const AICO_ID: i32 = 13;
const INBOX_ID: i32 = 14;
const GRANT_BASE: i32 = 200;
const END_BASE: i32 = 300;

/// Passive while the shell extension shows the icon (GNOME's AppIndicator extension then hides this one).
fn status(v: &View, hidden: bool) -> &'static str {
    if hidden { "Passive" } else if v.asks.is_empty() { "Active" } else { "NeedsAttention" }
}

/// The icon, with a dot while anything waits (asks or new notifications); the count shows beside it.
pub fn icon_of(v: &View) -> &'static str {
    icon_at(v, crate::daemon::now())
}

fn icon_at(v: &View, now: f64) -> &'static str {
    if waiting_at(v, now) == 0 { crate::icons::TRAY } else { crate::icons::TRAY_DOT }
}

/// Approvals, open Status problems (when Aico's count is current) and unread agent reports: what the number beside the
/// icon counts.
fn waiting_at(v: &View, now: f64) -> usize {
    v.asks.len() + needs_count(v, now).unwrap_or(0) + v.unread.unwrap_or(0)
}

pub fn label_of(v: &View) -> String {
    label_at(v, crate::daemon::now())
}

fn label_at(v: &View, now: f64) -> String {
    let n = waiting_at(v, now);
    if n == 0 { String::new() } else { n.to_string() }
}

fn new_text(n: Option<usize>) -> String {
    match n {
        None => "notifications not read yet".into(),
        Some(0) => "nothing new".into(),
        Some(1) => "1 new notification".into(),
        Some(n) => format!("{n} new notifications"),
    }
}

pub fn tooltip_of(v: &View) -> String {
    tooltip_at(v, crate::daemon::now())
}

/// How many Needs you items wait, when the web summary is current (None: unknown, never a made-up zero).
fn needs_count(v: &View, now: f64) -> Option<usize> {
    match v.needs_you {
        Some(crate::published::NeedsYou::Count(n)) if now - v.needs_you_at <= crate::published::SUMMARY_MAX_AGE_S => Some(n),
        _ => None,
    }
}

fn needs_text(n: usize) -> String {
    if n == 1 { "1 needs you".into() } else { format!("{n} need you") }
}

fn tooltip_at(v: &View, now: f64) -> String {
    let asks = match v.asks.len() {
        0 => "no approvals waiting".to_string(),
        1 => "1 approval waiting".to_string(),
        n => format!("{n} approvals waiting"),
    };
    let needs = needs_count(v, now).filter(|n| *n > 0).map(|n| format!("{}, ", needs_text(n))).unwrap_or_default();
    let quiet = if v.quiet_until > 0.0 { format!(", quiet until {}", clock(v.quiet_until)) } else { String::new() };
    capital(&format!("{needs}{asks}, {}{quiet}", new_text(v.unread)))
}

fn capital(t: &str) -> String {
    let mut c = t.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}

/// Local wall-clock time, "14:10".
fn clock(ts: f64) -> String {
    let t = ts as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&t, &mut tm) }.is_null() {
        return "?".into();
    }
    format!("{:02}:{:02}", tm.tm_hour, tm.tm_min)
}

fn props(label: &str, extra: &[(&str, Variant)]) -> Variant {
    let mut m: HashMap<String, Variant> = HashMap::new();
    if !label.is_empty() {
        m.insert("label".into(), label.to_variant());
    }
    for (k, v) in extra {
        m.insert((*k).into(), v.clone());
    }
    m.to_variant()
}

fn node(id: i32, p: Variant, children: Vec<Variant>) -> Variant {
    let kids = Variant::array_from_iter_with_type(VariantTy::VARIANT, children.iter().map(Variant::from_variant));
    Variant::tuple_from_iter([id.to_variant(), p, kids])
}

/// One menu row: its id, label, whether it can be clicked, and its submenu rows.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub id: i32,
    pub label: String,
    pub enabled: bool,
    pub kids: Vec<Row>,
}

fn row(id: i32, label: impl Into<String>) -> Row {
    Row { id, label: label.into(), enabled: true, kids: vec![] }
}

fn note(id: i32, label: impl Into<String>) -> Row {
    Row { id, label: label.into(), enabled: false, kids: vec![] }
}

fn sep(id: i32) -> Row {
    Row { id, label: String::new(), enabled: true, kids: vec![] }
}

pub(crate) fn is_sep(id: i32) -> bool {
    id == SEP_ID
}

/// The menu at `now`, in order: health, what waits (an unknown part says unknown, never zero), Open inbox (the panel
/// lists and answers everything), Aico's asks, open access with its End button, then the board and the quiet hour.
pub fn rows_at(v: &View, now: f64) -> Vec<Row> {
    let mut out = Vec::new();
    let current = now - v.needs_you_at <= crate::published::SUMMARY_MAX_AGE_S;
    let health = v.health.as_deref().filter(|_| current).unwrap_or("Health unknown: no current status");
    out.push(note(HEALTH_ID, health.to_string()));
    let quiet = v.quiet_until > now;
    if quiet {
        out.push(note(QUIET_NOTE_ID, format!("Quiet until {}: only approvals about to expire come up", clock(v.quiet_until))));
    }
    let needs = needs_count(v, now);
    // what the board waits on leads, so the header never reads as all clear while something needs the owner
    let lead = needs.filter(|n| *n > 0).map(|n| format!("{} · ", needs_text(n))).unwrap_or_default();
    let asks = v.asks.iter().filter(|a| a.expires > now).count();
    let waiting = match asks {
        0 => "no approvals waiting".to_string(),
        1 => "1 approval waiting".to_string(),
        n => format!("{n} approvals waiting"),
    };
    out.push(note(HEAD_ID, capital(&format!("{lead}{waiting} · {}", new_text(v.unread)))));
    let n = label_at(v, now); // the number beside the icon
    out.push(row(INBOX_ID, if n.is_empty() { "Open inbox".into() } else { format!("Open inbox ({n})") }));
    // Aico's own asks (questions agents put to the owner there): hidden at 0, unknown when Tether stopped writing
    if now - v.aico.at > crate::published::AICO_MAX_AGE_S {
        out.push(note(AICO_ID, "Questions unknown (Tether not reporting)"));
    } else if v.aico.open > 0 {
        let blocking = if v.aico.blocking > 0 { format!(", {} blocking an agent", v.aico.blocking) } else { String::new() };
        out.push(Row { enabled: v.aico.url.is_some(), ..row(AICO_ID, format!("Questions: {} waiting{blocking}", v.aico.open)) });
    }
    // open access stays one click from ending it
    let open = v.grants.iter().filter(|g| g.expires > now).count();
    for (i, g) in v.grants.iter().enumerate().filter(|(_, g)| g.expires > now) {
        let mut label = g.label.clone();
        if let Some(c) = label.get(..1) {
            label = format!("{}{}", c.to_uppercase(), &label[1..]);
        }
        out.push(note(GRANT_BASE + i as i32, format!("{label} access open until {}", clock(g.expires))));
        let end = if open == 1 { "End access now".to_string() } else { format!("End {} access now", g.label) };
        out.push(row(END_BASE + i as i32, end));
    }
    out.push(sep(SEP_ID));
    use crate::published::NeedsYou;
    let board = match v.needs_you.as_ref().filter(|_| current) {
        Some(NeedsYou::Count(0)) => "Status: nothing needs you".to_string(),
        Some(NeedsYou::Count(n)) => format!("Status: {}", needs_text(*n)),
        Some(NeedsYou::Stale) => "Status: out of date".to_string(),
        _ => "Open Status".to_string(),
    };
    out.push(row(BOARD_ID, board));
    out.push(row(QUIET_ID, if quiet { "End quiet now" } else { "Quiet for 1 hour" }));
    out
}

fn row_props(r: &Row) -> Variant {
    let mut extra: Vec<(&str, Variant)> = Vec::new();
    if is_sep(r.id) {
        extra.push(("type", "separator".to_variant()));
    }
    if !r.enabled {
        extra.push(("enabled", false.to_variant()));
    }
    if !r.kids.is_empty() {
        extra.push(("children-display", "submenu".to_variant()));
    }
    props(&r.label.replace('_', "__"), &extra) // a single _ would be read as a mnemonic and vanish
}

/// Every row with its properties, submenu rows included (GetGroupProperties).
pub fn items_at(v: &View, now: f64) -> Vec<(i32, Variant)> {
    fn walk(rows: &[Row], out: &mut Vec<(i32, Variant)>) {
        for r in rows {
            out.push((r.id, row_props(r)));
            walk(&r.kids, out);
        }
    }
    let mut out = Vec::new();
    walk(&rows_at(v, now), &mut out);
    out
}

fn labels_at(v: &View, now: f64) -> Vec<(i32, String)> {
    fn walk(rows: &[Row], out: &mut Vec<(i32, String)>) {
        for r in rows {
            out.push((r.id, r.label.clone()));
            walk(&r.kids, out);
        }
    }
    let mut out = Vec::new();
    walk(&rows_at(v, now), &mut out);
    out
}

/// The layout from `parent` down, as dbusmenu asks for it: the whole menu for 0, else that row (an unknown id gets an
/// empty node, never the whole menu again).
fn layout_at(v: &View, now: f64, parent: i32) -> Variant {
    fn build(r: &Row) -> Variant {
        node(r.id, row_props(r), r.kids.iter().map(build).collect())
    }
    fn find(rows: &[Row], id: i32) -> Option<&Row> {
        rows.iter().find_map(|r| if r.id == id { Some(r) } else { find(&r.kids, id) })
    }
    let rows = rows_at(v, now);
    match find(&rows, parent).filter(|_| parent != 0) {
        Some(r) => build(r),
        None if parent != 0 => node(parent, props("", &[]), vec![]), // gone since the menu was drawn
        None => node(0, props("", &[("children-display", "submenu".to_variant())]), rows.iter().map(build).collect()),
    }
}

pub(crate) fn click_for(v: &View, id: i32) -> Option<Click> {
    match id {
        INBOX_ID => Some(Click::Inbox),
        BOARD_ID => Some(Click::Board),
        QUIET_ID => Some(Click::Quiet),
        AICO_ID => v.aico.url.clone().map(|url| Click::Aico { url }),
        i if i >= END_BASE => v.grants.get((i - END_BASE) as usize).map(|g| Click::EndAccess { kind: g.kind.clone() }),
        _ => None,
    }
}

fn emit(conn: &gio::DBusConnection, path: &str, iface: &str, signal: &str, args: Option<Variant>) {
    let _ = conn.emit_signal(None, path, iface, signal, args.as_ref());
}

impl Tray {
    /// Export the item and its menu and register with the tray host; re-registers when the host restarts.
    /// None when the session has no D-Bus name for it (the notifier works on without a tray icon).
    pub fn start(conn: &gio::DBusConnection, clicks: impl Fn(Click) + Send + Sync + 'static) -> Option<Tray> {
        let inner = Arc::new(Mutex::new(Inner::default()));
        let name = format!("org.kde.StatusNotifierItem-{}-1", std::process::id());
        let item = gio::DBusNodeInfo::for_xml(ITEM_XML).ok()?.lookup_interface(ITEM_IFACE)?;
        let menu = gio::DBusNodeInfo::for_xml(MENU_XML).ok()?.lookup_interface(MENU_IFACE)?;
        let i2 = inner.clone();
        let clicks: Arc<dyn Fn(Click) + Send + Sync> = Arc::new(clicks);
        let c2 = clicks.clone();
        conn.register_object(ITEM_PATH, &item)
            .method_call(move |_, _, _, _, method, params, inv| {
                if matches!(method, "Activate" | "SecondaryActivate" | "ContextMenu") {
                    let (x, y) = (params.child_value(0).get::<i32>().unwrap_or(0), params.child_value(1).get::<i32>().unwrap_or(0));
                    crate::anchor::record(x, y); // windows open beside the moon
                }
                if matches!(method, "Activate" | "SecondaryActivate") {
                    eprintln!("tray: {method}");
                    c2(Click::Inbox); // a double or middle click (GNOME's single click opens the menu)
                }
                inv.return_value(None);
            })
            .property(move |_, _, _, _, prop| {
                let g = i2.lock().unwrap();
                let v = &g.view;
                match prop {
                    "Category" => "Communications".to_variant(),
                    "Id" => "aico".to_variant(),
                    "Title" => "Aico".to_variant(),
                    "Status" => status(v, g.hidden).to_variant(),
                    "WindowId" => 0i32.to_variant(),
                    "IconName" => icon_of(v).to_variant(),
                    "IconThemePath" => crate::icons::dir().to_string_lossy().to_variant(),
                    "AttentionIconName" => crate::icons::TRAY_DOT.to_variant(),
                    "ToolTip" => (icon_of(v), Vec::<(i32, i32, Vec<u8>)>::new(), "Aico", tooltip_of(v)).to_variant(),
                    "ItemIsMenu" => false.to_variant(),
                    "Menu" => glib::variant::ObjectPath::try_from(MENU_PATH.to_string()).map(|p| p.to_variant())
                        .unwrap_or_else(|_| "/".to_variant()),
                    "XAyatanaLabel" => label_of(v).to_variant(),
                    "XAyatanaLabelGuide" => "99".to_variant(),
                    _ => "".to_variant(),
                }
            })
            .set_property(|_, _, _, _, _, _| false)
            .build().ok()?;
        let i3 = inner.clone();
        let i4 = inner.clone();
        let shell_clicks = clicks.clone();
        conn.register_object(MENU_PATH, &menu)
            .method_call(move |_, _, _, _, method, params, inv| {
                let mut g = i3.lock().unwrap();
                let now = crate::daemon::now();
                match method {
                    "GetLayout" => {
                        let parent: i32 = params.child_value(0).get().unwrap_or(0);
                        g.shown = labels_at(&g.view, now);
                        inv.return_value(Some(&Variant::tuple_from_iter([g.revision.to_variant(), layout_at(&g.view, now, parent)])))
                    }
                    "GetGroupProperties" => {
                        let ids: Vec<i32> = params.child_value(0).get().unwrap_or_default();
                        let all = items_at(&g.view, now);
                        let rows: Vec<Variant> = all.into_iter().filter(|(id, _)| ids.is_empty() || ids.contains(id))
                            .map(|(id, p)| Variant::tuple_from_iter([id.to_variant(), p])).collect();
                        let arr = Variant::array_from_iter_with_type(VariantTy::new("(ia{sv})").unwrap(), rows);
                        inv.return_value(Some(&Variant::tuple_from_iter([arr])));
                    }
                    "GetProperty" => inv.return_value(Some(&Variant::tuple_from_iter([Variant::from_variant(&"".to_variant())]))),
                    "Event" => {
                        let id: i32 = params.child_value(0).get().unwrap_or(-1);
                        let ev: String = params.child_value(1).get().unwrap_or_default();
                        let click = (ev == "clicked").then(|| click_for(&g.view, id)).flatten();
                        drop(g);
                        if let Some(c) = click {
                            eprintln!("tray: menu {c:?}");
                            clicks(c);
                        }
                        inv.return_value(None);
                    }
                    "EventGroup" => {
                        let evs = params.child_value(0);
                        let mut todo = Vec::new();
                        for i in 0..evs.n_children() {
                            let e = evs.child_value(i);
                            let (id, ev) = (e.child_value(0).get::<i32>().unwrap_or(-1), e.child_value(1).get::<String>().unwrap_or_default());
                            if ev == "clicked" {
                                todo.extend(click_for(&g.view, id));
                            }
                        }
                        drop(g);
                        for c in todo {
                            eprintln!("tray: menu {c:?}");
                            clicks(c);
                        }
                        inv.return_value(Some(&(Vec::<i32>::new(),).to_variant()));
                    }
                    "AboutToShow" => {
                        // the menu opens: times ("12 min left", "3 h ago") read as of now, so a changed one re-lays it out
                        let stale = labels_at(&g.view, now) != g.shown;
                        if stale {
                            g.revision += 1;
                        }
                        inv.return_value(Some(&(stale,).to_variant()))
                    }
                    "AboutToShowGroup" => inv.return_value(Some(&(Vec::<i32>::new(), Vec::<i32>::new()).to_variant())),
                    _ => inv.return_value(None),
                }
            })
            .property(move |_, _, _, _, prop| match prop {
                "Version" => 3u32.to_variant(),
                "TextDirection" => "ltr".to_variant(),
                "Status" => "normal".to_variant(),
                "IconThemePath" => Vec::<String>::new().to_variant(),
                _ => { let _ = &i4; "".to_variant() }
            })
            .set_property(|_, _, _, _, _, _| false)
            .build().ok()?;
        let owned = conn.call_sync(Some("org.freedesktop.DBus"), "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
            Some(&(name.as_str(), 4u32).to_variant()), None, gio::DBusCallFlags::NONE, 3000, None::<&gio::Cancellable>);
        if owned.is_err() {
            eprintln!("tray: could not take the name {name}");
            return None;
        }
        let register = {
            let (c, n) = (conn.clone(), name.clone());
            move || {
                let r = c.call_sync(Some("org.kde.StatusNotifierWatcher"), "/StatusNotifierWatcher", "org.kde.StatusNotifierWatcher",
                    "RegisterStatusNotifierItem", Some(&(n.as_str(),).to_variant()), None, gio::DBusCallFlags::NONE, 3000,
                    None::<&gio::Cancellable>);
                match r {
                    Ok(_) => eprintln!("tray: icon registered"),
                    Err(e) => eprintln!("tray: no tray host yet ({e}); the icon shows when one starts"),
                }
            }
        };
        register();
        let i5 = inner.clone();
        if crate::shell::export(conn, move || i5.lock().unwrap().view.clone(), shell_clicks).is_some() {
            eprintln!("tray: shell interface {} ready", crate::shell::NAME);
        }
        let watch = conn.subscribe_to_signal(Some("org.freedesktop.DBus"), Some("org.freedesktop.DBus"), Some("NameOwnerChanged"),
            Some("/org/freedesktop/DBus"), Some("org.kde.StatusNotifierWatcher"), gio::DBusSignalFlags::NONE,
            move |sig| {
                if !sig.parameters.child_value(2).get::<String>().unwrap_or_default().is_empty() {
                    register(); // the tray host (GNOME Shell's extension) came back: show the icon again
                }
            });
        Some(Tray { conn: conn.clone(), inner, _watch: watch })
    }

    /// Show this view; signals the host only for what changed.
    pub fn set(&self, view: View) {
        let mut g = self.inner.lock().unwrap();
        if g.view == view {
            return;
        }
        let old = std::mem::replace(&mut g.view, view);
        g.revision += 1;
        let (rev, v, hidden) = (g.revision, g.view.clone(), g.hidden);
        drop(g);
        if status(&old, hidden) != status(&v, hidden) {
            emit(&self.conn, ITEM_PATH, ITEM_IFACE, "NewStatus", Some((status(&v, hidden),).to_variant()));
        }
        crate::shell::changed(&self.conn, &old, &v);
        if icon_of(&old) != icon_of(&v) {
            emit(&self.conn, ITEM_PATH, ITEM_IFACE, "NewIcon", None);
        }
        if label_of(&old) != label_of(&v) {
            emit(&self.conn, ITEM_PATH, ITEM_IFACE, "XAyatanaNewLabel", Some((label_of(&v), "99").to_variant()));
        }
        emit(&self.conn, ITEM_PATH, ITEM_IFACE, "NewToolTip", None);
        emit(&self.conn, MENU_PATH, MENU_IFACE, "LayoutUpdated", Some((rev, 0i32).to_variant()));
    }

    /// The shell extension came (true) or went (false): this item hides behind its icon, or shows again.
    pub fn set_hidden(&self, hidden: bool) {
        let mut g = self.inner.lock().unwrap();
        if std::mem::replace(&mut g.hidden, hidden) == hidden {
            return;
        }
        let s = status(&g.view, hidden);
        drop(g);
        eprintln!("tray: {}", if hidden { "the shell extension shows the moon; this icon hides" } else { "no shell extension; this icon shows" });
        emit(&self.conn, ITEM_PATH, ITEM_IFACE, "NewStatus", Some((s,).to_variant()));
    }

    /// The inbox started as `pid` (the extension places it under its icon).
    pub fn panel_opened(&self, pid: u32) {
        crate::shell::panel_opened(&self.conn, pid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::published::{Grant, NeedsYou};

    const NOW: f64 = 1_000_000.0;

    fn view(n: usize, unread: usize) -> View {
        View { asks: (0..n).map(|i| Ask { id: format!("{i:032x}"), kind: "elevate".into(), title: format!("Open GitHub admin {i}?"),
                                          expires: NOW + 720.0 }).collect(),
               unread: Some(unread), aico: crate::published::AicoAsks { at: NOW, ..Default::default() }, ..Default::default() }
    }

    fn labels(v: &View) -> Vec<String> {
        rows_at(v, NOW).into_iter().map(|r| r.label).collect()
    }

    #[test]
    fn quiet_hour_shows_until_when_and_how_to_end_it() {
        let mut v = view(0, 0);
        assert_eq!(labels(&v).last().unwrap(), "Quiet for 1 hour");
        assert_eq!(click_for(&v, QUIET_ID), Some(Click::Quiet));
        v.quiet_until = NOW + 1800.0;
        let rows = rows_at(&v, NOW);
        assert_eq!(rows[1].id, QUIET_NOTE_ID);
        assert!(!rows[1].enabled);
        let until = clock(NOW + 1800.0);
        assert_eq!(rows[1].label, format!("Quiet until {until}: only approvals about to expire come up"));
        assert_eq!(rows.last().unwrap().label, "End quiet now");
        assert_eq!(tooltip_of(&v), format!("No approvals waiting, nothing new, quiet until {until}"));
        assert_eq!(labels(&View { quiet_until: NOW - 1.0, ..v }).last().unwrap(), "Quiet for 1 hour"); // ended
    }

    #[test]
    fn the_number_counts_approvals_problems_and_unread_reports() {
        let mut v = view(1, 2);
        v.needs_you = Some(NeedsYou::Count(2));
        v.needs_you_at = NOW - 30.0;
        assert_eq!(label_at(&v, NOW), "5");
        assert_eq!(icon_at(&v, NOW), "aico-tray-dot");
        v.needs_you_at = NOW - 3600.0; // an old count is unknown, not counted
        assert_eq!(label_at(&v, NOW), "3");
        let mut only = view(0, 0);
        only.needs_you = Some(NeedsYou::Count(2));
        only.needs_you_at = NOW - 30.0;
        assert_eq!((label_at(&only, NOW).as_str(), icon_at(&only, NOW)), ("2", "aico-tray-dot")); // problems alone show
        only.needs_you = Some(NeedsYou::Count(0));
        assert_eq!((label_at(&only, NOW).as_str(), icon_at(&only, NOW)), ("", "aico-tray")); // all clear: no number
    }

    #[test]
    fn label_and_tooltip_count_asks_and_new_notifications() {
        assert_eq!(label_of(&view(0, 0)), "");
        assert_eq!(label_of(&view(2, 3)), "5");
        assert_eq!(tooltip_of(&view(1, 0)), "1 approval waiting, nothing new");
        assert_eq!(tooltip_of(&view(0, 2)), "No approvals waiting, 2 new notifications");
        assert_eq!(status(&view(0, 5), false), "Active");
        assert_eq!(status(&view(1, 0), false), "NeedsAttention");
        assert_eq!(status(&view(1, 0), true), "Passive"); // the shell extension's moon shows instead
        assert_eq!(icon_of(&view(0, 0)), "aico-tray");
        assert_eq!(icon_of(&view(0, 1)), "aico-tray-dot");
    }

    #[test]
    fn menu_leads_with_the_inbox_and_maps_clicks() {
        let mut v = view(2, 1);
        v.grants = vec![Grant { kind: "github-admin".into(), label: "GitHub admin".into(), expires: NOW + 1800.0 }];
        v.needs_you = Some(NeedsYou::Count(4));
        v.needs_you_at = NOW - 30.0;
        let rows = rows_at(&v, NOW);
        let ids: Vec<i32> = rows.iter().map(|r| r.id).collect();
        assert_eq!(ids, vec![HEALTH_ID, HEAD_ID, INBOX_ID, GRANT_BASE, END_BASE, SEP_ID, BOARD_ID, QUIET_ID]);
        assert!(rows.iter().all(|r| r.kids.is_empty())); // no submenus: GNOME's tray never opened them
        assert_eq!(rows[1].label, "4 need you · 2 approvals waiting · 1 new notification");
        assert!(!rows[1].enabled);
        assert_eq!(rows[2].label, "Open inbox (7)"); // the number beside the icon: 2 approvals, 4 problems, 1 report
        assert!(rows[3].label.starts_with("GitHub admin access open until ") && !rows[3].enabled);
        assert_eq!(rows[4].label, "End access now");
        assert_eq!(rows[6].label, "Status: 4 need you");
        assert_eq!(labels(&view(0, 0))[2], "Open inbox");
        assert_eq!(click_for(&v, INBOX_ID), Some(Click::Inbox));
        assert_eq!(click_for(&v, BOARD_ID), Some(Click::Board));
        assert_eq!(click_for(&v, END_BASE), Some(Click::EndAccess { kind: "github-admin".into() }));
        assert_eq!(click_for(&v, GRANT_BASE), None); // the grant line itself is only a note
        assert_eq!(click_for(&v, HEAD_ID), None);
        assert_eq!(click_for(&v, END_BASE + 1), None);
        assert_eq!(layout_at(&v, NOW, 0).type_().as_str(), "(ia{sv}av)");
        // asked for one row by its id: that row, not the whole menu again; an unknown id gets an empty node
        let one = layout_at(&v, NOW, INBOX_ID);
        assert_eq!(one.child_value(0).get::<i32>(), Some(INBOX_ID));
        assert_eq!(layout_at(&v, NOW, 999).child_value(2).n_children(), 0);
        assert!(items_at(&v, NOW).iter().any(|(id, _)| *id == INBOX_ID));
        // an ask that ran out is not counted as waiting
        let mut a = view(1, 0);
        a.asks[0].expires = NOW - 1.0;
        assert_eq!(labels(&a)[1], "No approvals waiting · nothing new");
    }

    #[test]
    fn header_is_honest_when_no_approval_waits() {
        let l = labels(&view(0, 13));
        assert_eq!(l[0], "Health unknown: no current status");
        assert_eq!(l[1], "No approvals waiting · 13 new notifications");
        assert!(l.contains(&"Open Status".to_string())); // count unknown: never a made-up zero
        assert_eq!(labels(&view(0, 0))[1], "No approvals waiting · nothing new");
        let mut v = view(0, 0);
        v.needs_you_at = NOW - 30.0;
        v.needs_you = Some(NeedsYou::Stale);
        assert!(labels(&v).contains(&"Status: out of date".to_string()));
        v.needs_you = Some(NeedsYou::Count(4));
        assert_eq!(labels(&v)[1], "4 need you · no approvals waiting · nothing new"); // never all clear while the board waits
        assert_eq!(tooltip_at(&v, NOW), "4 need you, no approvals waiting, nothing new");
        v.needs_you = Some(NeedsYou::Count(1));
        assert_eq!(labels(&v)[1], "1 needs you · no approvals waiting · nothing new");
        v.needs_you = Some(NeedsYou::Count(0));
        v.health = Some("Disk 44G free · backup 2 h ago · all services up".into());
        assert!(labels(&v).contains(&"Status: nothing needs you".to_string()));
        assert_eq!(labels(&v)[0], "Disk 44G free · backup 2 h ago · all services up");
        let health = rows_at(&v, NOW).into_iter().next().unwrap();
        assert!(!health.enabled && click_for(&v, health.id).is_none()); // a line to read, not a button
        v.needs_you_at = NOW - 3600.0; // the web service stopped writing it: unknown, not the old count or health
        assert!(labels(&v).contains(&"Open Status".to_string()));
        assert_eq!(labels(&v)[0], "Health unknown: no current status");
        v.needs_you = Some(NeedsYou::Count(4));
        assert_eq!(labels(&v)[1], "No approvals waiting · nothing new"); // an old count is not repeated
        assert_eq!(tooltip_at(&v, NOW), "No approvals waiting, nothing new");
        v.unread = None; // the tray has not read the store yet: not a made-up zero
        assert_eq!(tooltip_at(&v, NOW), "No approvals waiting, notifications not read yet");
        v.unread = Some(0);
        // Aico: hidden at 0, a count with the blocking ones, unknown when Tether's feed is old
        let mut a = view(0, 0);
        a.aico = crate::published::AicoAsks { open: 0, blocking: 0, url: None, at: NOW - 30.0 };
        assert!(!labels(&a).iter().any(|l| l.starts_with("Questions")));
        a.aico = crate::published::AicoAsks { open: 2, blocking: 1, url: Some("https://aico.example/?ask=e0062e61c89f".into()), at: NOW - 30.0 };
        assert!(labels(&a).contains(&"Questions: 2 waiting, 1 blocking an agent".to_string()));
        assert_eq!(click_for(&a, AICO_ID), Some(Click::Aico { url: "https://aico.example/?ask=e0062e61c89f".into() }));
        a.aico.at = NOW - 600.0;
        let row = rows_at(&a, NOW).into_iter().find(|r| r.id == AICO_ID).unwrap();
        assert!(row.label == "Questions unknown (Tether not reporting)" && !row.enabled);
    }

    #[test]
    fn several_grants() {
        let mut v = view(0, 0);
        v.grants = vec![Grant { kind: "github-admin".into(), label: "GitHub admin".into(), expires: NOW + 60.0 },
                        Grant { kind: "owner-chrome".into(), label: "your main Chrome".into(), expires: NOW + 600.0 }];
        let l = labels(&v);
        assert!(l.iter().any(|x| x.starts_with("Your main Chrome access open until ")));
        assert!(l.contains(&"End your main Chrome access now".to_string()) && l.contains(&"End GitHub admin access now".to_string()));
        // one ran out since the last refresh: its rows go, the other keeps its own id and says just "End access now"
        let later = rows_at(&v, NOW + 120.0);
        assert!(!later.iter().any(|r| r.id == GRANT_BASE || r.id == END_BASE));
        assert_eq!(later.iter().find(|r| r.id == END_BASE + 1).unwrap().label, "End access now");
        // a single underscore is a dbusmenu mnemonic: doubled so "aico_web" shows as written
        let p = row_props(&row(INBOX_ID, "aico_web"));
        assert_eq!(p.get::<HashMap<String, Variant>>().unwrap()["label"].str(), Some("aico__web"));
        // the clock moves the label, so the next menu open re-lays it out
        let mut q = view(0, 0);
        q.quiet_until = NOW + 1800.0;
        assert_ne!(labels_at(&q, NOW), labels_at(&q, NOW + 1800.0));
    }
}
