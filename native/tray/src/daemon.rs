//! The background notifier (user unit aico-tray). A new access request opens the approval card right
//! away in the bottom-right corner above the panel, without taking the keyboard (window --passive; a click on it
//! takes it, into the PIN field); a new other owner notification shows as the app's own corner card (toast.rs) that
//! hides by itself. No GNOME banners. Event-driven: inotify on Tether's feed and the tray's state directory; Aico's
//! tray door (`GET /api/tray`, off this thread) is read every 15 s and when those files change, for the badge, the push
//! log and the read marks; the grants service (host-steward's socket) is asked for open requests every few seconds.
//! The notifier itself never touches the key or signs anything; the tray (tray.rs) shows the icon with a dot while anything waits. In the owner's quiet hour (quiet.rs) no
//! card comes up except an ask about to expire; what waited comes up when it ends.

use crate::published;
use gtk::gio;
use gtk::glib;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::CString;
use std::os::fd::RawFd;
use std::rc::Rc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const GRANTS_EVERY_S: u32 = 5; // how often the grants service is asked for new access requests (it publishes no file)
const ITEMS_EVERY_S: u32 = 15; // how often Aico is read for the badge, the pushes and the read marks (published::SUMMARY_MAX_AGE_S is the floor it must beat)

pub fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

#[derive(Default)]
struct State {
    shown: HashSet<String>, // asks whose card came up once (closing it keeps it closed; the tray still lists it)
    window: Option<u32>,
    panel: bool, // the window is the inbox panel (asks arriving meanwhile get their card once it closes)
    shell: bool, // the GNOME Shell extension shows the moon: the inbox opens as its popover (shell.rs)
    toast: Option<u32>,
    toasts: VecDeque<String>, // notifications waiting for the corner (while the approval card is up)
    tray: Option<Rc<crate::tray::Tray>>,
    notice_shown: HashSet<String>,
    notice_since: f64,
    queued: bool,
    wake: f64, // a re-read is due then (wake_at)
    quiet_queue: bool, // cards queued up during a quiet hour (only the newest few come up after)
    summary: serde_json::Value, // the item store's tray summary with the read's time (items::tray_summary), Null: unknown
    log: serde_json::Value, // the push log from the last good store read (notices::log_of), Null before the first
    marks: serde_json::Value, // the read marks from that read (read_marks)
    first_read: bool, // the first good read came (and its first-run check ran)
    summary_why: Option<String>, // why it is unknown (logged when it changes)
    reading: bool, // a store read is running (off this thread)
    read_again: bool, // the stamp changed meanwhile: read once more when it is done
    items_tx: Option<async_channel::Sender<Result<serde_json::Value, String>>>,
}

/// Asks already shown, so a restart (deploy) does not bring back a card the owner closed (gone at logout).
fn notes_path() -> Option<std::path::PathBuf> {
    std::env::var_os("XDG_RUNTIME_DIR").map(|d| std::path::PathBuf::from(d).join("aico-tray-notes.json"))
}

fn load_notes() -> HashSet<String> {
    let v: serde_json::Value = notes_path().and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    // older runs kept {ask id: notification id}; either way the keys are the asks shown
    let keys: Vec<String> = match &v {
        serde_json::Value::Object(m) => m.keys().cloned().collect(),
        serde_json::Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        _ => Vec::new(),
    };
    keys.into_iter().filter(|k| crate::proto::valid_id(k)).collect()
}

fn save_notes(s: &State) {
    let Some(p) = notes_path() else { return };
    let tmp = p.with_extension("tmp");
    if let Ok(b) = serde_json::to_vec(&s.shown.iter().collect::<Vec<_>>()) {
        if std::fs::write(&tmp, b).is_ok() {
            let _ = std::fs::rename(&tmp, &p);
        }
    }
}

/// How far the last run read the log, and what it showed (gone at logout).
fn notices_path() -> Option<std::path::PathBuf> {
    std::env::var_os("XDG_RUNTIME_DIR").map(|d| std::path::PathBuf::from(d).join("aico-tray-notices.json"))
}

fn load_notices() -> (f64, HashSet<String>) {
    let v: serde_json::Value = notices_path().and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let shown = v["shown"].as_object().map(|m| m.keys().filter(|k| crate::notices::valid_entry_id(k)).cloned().collect())
        .unwrap_or_default();
    (v["since"].as_f64().unwrap_or(0.0), shown)
}

fn save_notices(s: &State) {
    let Some(p) = notices_path() else { return };
    let shown: serde_json::Map<String, serde_json::Value> = s.notice_shown.iter().map(|k| (k.clone(), 1.into())).collect();
    let v = serde_json::json!({"since": s.notice_since, "shown": shown});
    let tmp = p.with_extension("tmp");
    if std::fs::write(&tmp, v.to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, &p);
    }
}

type Shared = Rc<RefCell<State>>;

const NOTICES_PER_PASS: usize = 5; // after a long absence only the newest few come up; /n lists the rest

fn refresh_notices(st: &Shared) {
    use crate::notices::{self, Cleared};
    let mut s = st.borrow_mut();
    if s.log.is_null() {
        return; // no store read yet: nothing is known about the log (the last run's place in it stays)
    }
    let log = std::mem::take(&mut s.log);
    let cl = Cleared::of_marks(&s.marks);
    let shown: HashMap<String, u32> = s.notice_shown.iter().map(|k| (k.clone(), 1)).collect();
    let fresh = notices::to_show(&log, s.notice_since, &shown, &cl);
    let skip = fresh.len().saturating_sub(NOTICES_PER_PASS);
    for e in fresh.into_iter().skip(skip) {
        let id = e["id"].as_str().unwrap_or("").to_string();
        let age = now() - e["ts"].as_f64().unwrap_or(0.0);
        eprintln!("notice {id} queued for the corner, {:.0} ms after it was logged ({})", age * 1000.0, e["result"].as_str().unwrap_or(""));
        s.notice_shown.insert(id.clone());
        s.toasts.push_back(id);
    }
    // a notice cleared elsewhere before its turn never comes up
    let entry = |id: &str| log.as_array().and_then(|a| a.iter().find(|e| e["id"].as_str() == Some(id)));
    let keep: Vec<String> = s.toasts.iter().filter(|id| entry(id).is_some_and(|e| !cl.of(e))).cloned().collect();
    s.toasts = keep.into();
    // everything up to the newest final entry is decided; a pending one keeps its place until its result lands
    let decided = log.as_array().map(|a| a.iter().take_while(|e| e["result"] != "pending")
        .filter_map(|e| e["ts"].as_f64()).fold(s.notice_since, f64::max)).unwrap_or(s.notice_since);
    s.notice_since = decided;
    s.notice_shown.retain(|id| log.as_array().is_some_and(|a| a.iter().any(|e| e["id"].as_str() == Some(id))));
    s.log = log;
    save_notices(&s);
    drop(s);
    show_toasts(st);
}

/// The next notifications into the corner, unless the approval card or a toast is up there.
fn show_toasts(st: &Shared) {
    let entries: Vec<serde_json::Value> = {
        let mut s = st.borrow_mut();
        if s.window.is_some() || s.toast.is_some() || s.toasts.is_empty() {
            return;
        }
        if crate::quiet::until(now()) > 0.0 {
            s.quiet_queue = true;
            return; // a quiet hour keeps them queued; when it ends only the newest few come up
        }
        if std::mem::take(&mut s.quiet_queue) {
            let extra = s.toasts.len().saturating_sub(NOTICES_PER_PASS);
            s.toasts.drain(..extra);
        }
        let n = s.toasts.len().min(crate::toast::MAX);
        let ids: Vec<String> = s.toasts.drain(..n).collect();
        let empty = Vec::new();
        let log = s.log.as_array().unwrap_or(&empty);
        ids.iter().filter_map(|i| log.iter().find(|e| e["id"].as_str() == Some(i))).cloned().collect()
    };
    if entries.is_empty() {
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    // the pushes go on stdin (their text stays out of the process list)
    match std::process::Command::new(exe).args(["toast", "--stdin"]).stdin(std::process::Stdio::piped()).spawn() {
        Ok(mut child) => {
            if let Some(mut w) = child.stdin.take() {
                let b = serde_json::to_vec(&entries).unwrap_or_default();
                std::thread::spawn(move || {
                    let _ = std::io::Write::write_all(&mut w, &b);
                });
            }
            let pid = child.id();
            st.borrow_mut().toast = Some(pid);
            let s2 = st.clone();
            glib::child_watch_add_local(glib::Pid(pid as i32), move |_, _| {
                s2.borrow_mut().toast = None;
                show_toasts(&s2);
            });
            std::mem::forget(child); // glib reaps it
        }
        Err(e) => eprintln!("could not show the notification card: {e}"),
    }
}

fn refresh(st: &Shared) {
    let t = now();
    let public = published::public();
    let list = published::waiting(&public, &st.borrow().log, t);
    let ids: HashSet<&str> = list.iter().map(|w| w.id.as_str()).collect();
    let quiet = crate::quiet::until(t);
    let mut s = st.borrow_mut();
    s.queued = false;
    s.shown.retain(|r| ids.contains(r.as_str()));
    // in a quiet hour an ask's card waits until it is about to expire (the tray lists it meanwhile)
    // while the inbox is open it lists a new ask under Approvals; its card comes up once the inbox closes
    let holding = s.window.is_some() && s.panel;
    let new: Vec<(String, String)> = list.iter().filter(|w| !holding && !s.shown.contains(&w.id))
        .filter(|w| crate::quiet::ask_may_show(quiet, w.expires, t)).map(|w| (w.id.clone(), w.kind.clone())).collect();
    if quiet > 0.0 {
        let near = list.iter().filter(|w| !s.shown.contains(&w.id) && w.expires - crate::quiet::ASK_NEAR_S > t)
            .map(|w| w.expires - crate::quiet::ASK_NEAR_S).fold(quiet, f64::min);
        wake_at(st, &mut s, near);
    }
    for (rid, _) in &new {
        s.shown.insert(rid.clone());
    }
    save_notes(&s);
    if let Some(tray) = s.tray.clone() {
        use crate::notices;
        let asks = list.iter().map(|w| crate::tray::Ask { id: w.id.clone(), kind: w.kind.clone(), title: w.title.clone(),
                                                           expires: w.expires }).collect();
        let (log, cl) = (&s.log, notices::Cleared::of_marks(&s.marks));
        let (summary, at) = (&s.summary, t);
        tray.set(crate::tray::View {
            asks,
            // the tray rule's items (the item store); every unread push while it is unknown; unknown before the
            // tray's first good read of the store
            unread: (!log.is_null()).then(|| published::unread_rows(summary, at)
                .map_or_else(|| notices::unread(log, &cl), |rows| notices::unread_items(&rows, log, &cl))),
            aico: {
                let feed = std::fs::read(published::aico_feed_path()).ok().and_then(|b| serde_json::from_slice(&b).ok());
                published::aico_asks(&feed.unwrap_or_default(),
                                     |u| notices::open_link(&serde_json::json!({"refs": {"open": u}})))
            },
            grants: published::grants(&public, &summary["grant_labels"], t),
            needs_you: Some(published::needs_you(summary, at)),
            needs_you_at: summary["at"].as_f64().unwrap_or(0.0),
            health: summary["health"].as_str().map(|h| if h.chars().count() <= 200 { h.to_string() } else {
                format!("{}…", h.chars().take(199).collect::<String>())
            }),
            quiet_until: quiet,
        });
    }
    drop(s);
    if let Some((rid, kind)) = new.first() {
        eprintln!("ask {} arrived: showing its card", &rid[..8]);
        open_window(st, rid, kind); // the card walks every open ask, the others included
    }
    refresh_notices(st);
}

/// Read everything again at `at` (a quiet hour ends, or an ask waiting through one gets close to expiring). Only the
/// soonest wake is kept; one that turns out early just re-reads.
fn wake_at(st: &Shared, s: &mut State, at: f64) {
    if s.wake > now() && s.wake <= at {
        return;
    }
    s.wake = at;
    let s2 = st.clone();
    glib::timeout_add_local_once(Duration::from_secs_f64((at - now()).max(0.0) + 0.5), move || {
        s2.borrow_mut().wake = 0.0;
        refresh(&s2);
    });
}

/// Read the item store's tray summary off this thread (the CLI may take a moment); one read at a time, and one more
/// if the stamp changed meanwhile.
fn read_items(st: &Shared) {
    let tx = {
        let mut s = st.borrow_mut();
        if s.reading {
            s.read_again = true;
            return;
        }
        let Some(tx) = s.items_tx.clone() else { return };
        s.reading = true;
        tx
    };
    std::thread::spawn(move || {
        let _ = tx.send_blocking(crate::items::read());
    });
}

fn on_items(st: &Shared, r: Result<serde_json::Value, String>) {
    let why = crate::items::tray_unknown_why(&r);
    let again = {
        let mut s = st.borrow_mut();
        s.reading = false;
        if why != s.summary_why {
            match &why {
                Some(w) => eprintln!("tray summary unknown: {w}"),
                None => eprintln!("tray summary current again"),
            }
        }
        s.summary = crate::items::tray_summary(&r);
        s.summary_why = why;
        if let Ok(v) = &r {
            let log = crate::notices::log_of(v);
            if !log.is_null() {
                s.log = log;
                s.marks = v["read_marks"].clone();
                if !std::mem::replace(&mut s.first_read, true) && first_run(&s.marks) {
                    eprintln!("first run on this store: everything logged so far counts as read");
                    let newest = newest_push(&s.marks);
                    std::thread::spawn(move || {
                        if let Err(e) = crate::notices::mark_read_up_to(newest) {
                            eprintln!("{e}");
                        }
                    });
                }
            }
        }
        std::mem::take(&mut s.read_again)
    };
    if again {
        read_items(st);
    }
    queue(st);
}

/// No Mark all read was ever recorded on this store (read_all_at 0): the tray's first run, when nothing logged
/// before counts as unread yet (as the old notify/desktop-seen rule did). An older store without read marks: no.
fn first_run(marks: &serde_json::Value) -> bool {
    marks["read_all_at"].as_f64() == Some(0.0)
}

/// The newest push in a read (its ts; 0 for none): the first run marks read up to it, so a push logged while the
/// tray read is still new.
fn newest_push(marks: &serde_json::Value) -> f64 {
    marks["pushes"].as_array().map_or(0.0, |p| p.iter().filter_map(|r| r["ts"].as_f64()).fold(0.0, f64::max))
}

fn queue(st: &Shared) {
    if std::mem::replace(&mut st.borrow_mut().queued, true) {
        return;
    }
    let s2 = st.clone();
    glib::timeout_add_local_once(Duration::from_millis(30), move || refresh(&s2)); // one read per burst of writes
}

/// An ask came in: its card, shown without the keyboard, unless a card is up (it walks every open ask). With the inbox
/// up, refresh holds new asks back (the inbox lists them) until it closes.
fn open_window(st: &Shared, rid: &str, kind: &str) {
    if st.borrow().window.is_some() {
        return;
    }
    if let Some(pid) = st.borrow_mut().toast.take() {
        unsafe { libc::kill(pid as i32, libc::SIGTERM) }; // the corner is the ask's now; /n lists the notice
    }
    let Ok(exe) = std::env::current_exe() else { return };
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("window").arg(rid).arg("--url").arg(crate::ask_url(kind, rid)).arg("--passive");
    spawn_card(st, cmd, false);
}

/// The inbox panel (panel.rs), in the approval card's place: it replaces corner cards and holds the corner until it
/// closes (or turns into the approval card when the owner presses Approve in it). An open approval card
/// stays (a key may be touching it), and an open inbox keeps what the owner opened or typed in it.
fn open_panel(st: &Shared) {
    if let Some(pid) = st.borrow().window {
        let (panel, shell) = (st.borrow().panel, st.borrow().shell);
        eprintln!("click inbox at {:.3}: {} {pid} is up, left as it is", now(), if panel { "inbox" } else { "card" });
        if panel && shell {
            // the extension let go of it (it was closing, or the extension restarted): it picks it up again
            let tray = st.borrow().tray.clone();
            if let Some(t) = tray {
                t.panel_opened(pid);
            }
        }
        return;
    }
    if let Some(pid) = st.borrow_mut().toast.take() {
        unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    }
    let Ok(exe) = std::env::current_exe() else { return };
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("panel").env(crate::anchor::FROM_TRAY, "1");
    let shell = st.borrow().shell;
    if shell {
        cmd.env(crate::anchor::POPOVER, "1"); // the extension places it under its moon
    }
    eprintln!("click inbox at {:.3}", now());
    if let Some(pid) = spawn_card(st, cmd, true).filter(|_| shell) {
        let tray = st.borrow().tray.clone();
        if let Some(t) = tray {
            t.panel_opened(pid);
        }
    }
}

fn spawn_card(st: &Shared, mut cmd: std::process::Command, panel: bool) -> Option<u32> {
    match cmd.spawn() {
        Ok(child) => {
            let pid = child.id();
            {
                let mut s = st.borrow_mut();
                s.window = Some(pid);
                s.panel = panel;
            }
            let s2 = st.clone();
            glib::child_watch_add_local(glib::Pid(pid as i32), move |_, _| {
                {
                    let mut s = s2.borrow_mut();
                    if s.window == Some(pid) {
                        s.window = None; // a card replaced by a tray click does not clear its replacement
                    }
                }
                if panel {
                    queue(&s2); // asks held back while the inbox was open get their card now
                }
                show_toasts(&s2);
            });
            std::mem::forget(child); // glib reaps it
            Some(pid)
        }
        Err(e) => {
            eprintln!("could not start the card: {e}");
            None
        }
    }
}

fn shell_present(st: &Shared, present: bool) {
    st.borrow_mut().shell = present;
    let tray = st.borrow().tray.clone();
    if let Some(t) = tray {
        t.set_hidden(present);
    }
}

fn watch(fd: RawFd, dir: &str, mask: u32) -> Option<i32> {
    let c = CString::new(dir).ok()?;
    let wd = unsafe { libc::inotify_add_watch(fd, c.as_ptr(), mask) };
    (wd >= 0).then_some(wd)
}

/// The watch whose file is told apart by directory: Tether's feed (another name than ours).
#[derive(Clone, Copy, Default)]
struct Wds {
    aico: Option<i32>,
}

/// What a batch of events touched: the quiet hour's file and Tether's feed (re-read both and Aico).
#[derive(Debug, Default, PartialEq)]
struct Hit {
    files: bool,
}

fn hit_of(h: &mut Hit, wds: Wds, wd: i32, mask: u32, name: &[u8], aico_name: &[u8]) {
    // a lost event (queue overflow) or one without a name could be ours: read again
    if mask & libc::IN_Q_OVERFLOW != 0 || name.is_empty() {
        h.files = true;
    } else if Some(wd) == wds.aico {
        h.files |= name == aico_name;
    } else if name == b"quiet.json" {
        h.files = true;
    }
}

fn drain(fd: RawFd, wds: Wds, aico_name: &[u8]) -> Hit {
    let mut buf = [0u8; 4096];
    let mut hit = Hit::default();
    loop {
        let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
        if n <= 0 {
            return hit;
        }
        let mut off = 0usize;
        while off + 16 <= n as usize {
            let wd = i32::from_ne_bytes(buf[off..off + 4].try_into().unwrap_or([0; 4]));
            let mask = u32::from_ne_bytes(buf[off + 4..off + 8].try_into().unwrap_or([0; 4]));
            let len = u32::from_ne_bytes(buf[off + 12..off + 16].try_into().unwrap_or([0; 4])) as usize;
            let name = &buf[off + 16..(off + 16 + len).min(n as usize)];
            let name = name.split(|b| *b == 0).next().unwrap_or(&[]);
            hit_of(&mut hit, wds, wd, mask, name, aico_name);
            off += 16 + len;
        }
    }
}

pub fn run() -> i32 {
    let (since, notice_shown) = load_notices();
    let start = now();
    // the last run's place in the log, unless it is a day old (then only what comes from now on)
    let notice_since = if since > start - 86400.0 && since <= start { since } else { start };
    let st: Shared = Rc::new(RefCell::new(State { shown: load_notes(), notice_shown, notice_since, ..Default::default() }));
    let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
    let mask = libc::IN_MOVED_TO | libc::IN_CLOSE_WRITE | libc::IN_CREATE | libc::IN_DELETE | libc::IN_MOVED_FROM;
    let state = published::state_dir();
    let _ = std::fs::create_dir_all(&state);
    let state = state.to_string_lossy().into_owned();
    if fd < 0 || watch(fd, &state, mask).is_none() {
        eprintln!("aico-tray: cannot watch {state}");
        return 2;
    }
    let wds = Wds {
        aico: published::aico_feed_path().parent().and_then(|d| d.to_str()).and_then(|dir| watch(fd, dir, mask)), // Tether's feed
    };
    let aico_name: Vec<u8> = published::aico_feed_path().file_name().map(|n| n.as_encoded_bytes().to_vec()).unwrap_or_default();
    {
        let (tx, rx) = async_channel::unbounded::<Result<serde_json::Value, String>>(); // store reads to this loop
        st.borrow_mut().items_tx = Some(tx);
        let s2 = st.clone();
        glib::spawn_future_local(async move {
            while let Ok(r) = rx.recv().await {
                on_items(&s2, r);
            }
        });
    }
    {
        let s2 = st.clone();
        glib_unix::unix_fd_add_local(fd, glib::IOCondition::IN, move |_, _| {
            if drain(fd, wds, &aico_name).files {
                read_items(&s2);
                queue(&s2);
            }
            glib::ControlFlow::Continue
        });
    }
    {
        let s2 = st.clone();
        glib::timeout_add_seconds_local(ITEMS_EVERY_S, move || {
            read_items(&s2);
            queue(&s2); // an old summary turns unknown even while no read comes back
            glib::ControlFlow::Continue
        });
    }
    match gio::bus_get_sync(gio::BusType::Session, None::<&gio::Cancellable>) {
        Ok(conn) => {
            let (tx, rx) = async_channel::unbounded::<crate::tray::Click>(); // D-Bus callbacks' clicks to this loop
            st.borrow_mut().tray = crate::tray::Tray::start(&conn, move |c| {
                let _ = tx.send_blocking(c);
            }).map(Rc::new);
            // the shell extension's moon (shell.rs): while it is there this item hides and the inbox is its popover
            let s3 = st.clone();
            let s4 = st.clone();
            gio::bus_watch_name_on_connection(&conn, crate::shell::SHELL_NAME, gio::BusNameWatcherFlags::NONE,
                move |_, _, _| shell_present(&s3, true), move |_, _| shell_present(&s4, false));
            let s2 = st.clone();
            glib::spawn_future_local(async move {
              while let Ok(c) = rx.recv().await {
                match c {
                    crate::tray::Click::Inbox => open_panel(&s2),
                    crate::tray::Click::EndAccess { kind } => match published::revoke(&kind) {
                        Ok(rid) => eprintln!("tray: ending {kind} access now (request {})", &rid[..8]),
                        Err(e) => eprintln!("tray: could not end {kind} access: {e}"),
                    },
                    crate::tray::Click::Quiet => {
                        let t = now();
                        if crate::quiet::until(t) > 0.0 {
                            crate::quiet::end(t);
                            eprintln!("tray: quiet hour ended");
                        } else {
                            crate::quiet::start(t);
                            eprintln!("tray: quiet for 1 hour");
                        }
                        refresh(&s2);
                    }
                    crate::tray::Click::Aico { url } => crate::browser::open(&url),
                    crate::tray::Click::Board => {
                        let host = crate::status_host();
                        if !host.is_empty() {
                            crate::browser::open(&format!("https://{host}/"));
                        }
                    }
                }
              }
            });
        }
        Err(e) => eprintln!("aico-tray: no session bus ({e}); no tray icon"),
    }
    {
        let s2 = st.clone();
        glib::timeout_add_seconds_local(GRANTS_EVERY_S, move || {
            queue(&s2);
            glib::ControlFlow::Continue
        });
    }
    read_items(&st);
    refresh(&st);
    let main = glib::MainLoop::new(None, false);
    for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        let m2 = main.clone();
        glib_unix::unix_signal_add_local(sig, move || {
            // an approval card stays up across a restart (deploy): the owner may be typing the PIN
            eprintln!("stopping");
            m2.quit();
            glib::ControlFlow::Break
        });
    }
    main.run();
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_run_is_a_store_with_no_mark_all_read() {
        assert!(first_run(&serde_json::json!({"read_all_at": 0.0, "pushes": []})));
        assert!(!first_run(&serde_json::json!({"read_all_at": 1793530000.0, "pushes": []})));
        assert!(!first_run(&serde_json::Value::Null));
        assert_eq!(newest_push(&serde_json::json!({"pushes": [{"ts": 5.0}, {"ts": 9.5}, {"ts": 7.0}]})), 9.5);
        assert_eq!(newest_push(&serde_json::json!({"pushes": []})), 0.0);
    }

    #[test]
    fn the_watched_files_say_when_to_read_again() {
        let wds = Wds { aico: Some(4) };
        let feed = b"needs-you.json";
        let hit = |wd: i32, mask: u32, name: &[u8]| {
            let mut h = Hit::default();
            hit_of(&mut h, wds, wd, mask, name, feed);
            h.files
        };
        assert!(hit(4, libc::IN_MOVED_TO, b"needs-you.json")); // Tether's feed
        assert!(!hit(1, libc::IN_MOVED_TO, b"needs-you.json")); // the same name elsewhere is not it
        assert!(!hit(1, libc::IN_MOVED_TO, b"changed"));
        assert!(!hit(1, libc::IN_CLOSE_WRITE, b"approvals.json")); // the old root list is no trigger any more
        assert!(hit(2, libc::IN_CLOSE_WRITE, b"quiet.json"));
        assert!(!hit(2, libc::IN_MOVED_TO, b"log.json"));
        assert!(hit(2, libc::IN_Q_OVERFLOW, b""));
    }
}
