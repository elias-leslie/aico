//! A plain owner notification as the app's own corner card (not a GNOME banner): bottom right above the panel, shown
//! without taking focus, gone after HIDE_S unless the pointer is on it. A click on the card opens it as its own card
//! (notice.rs) in the same place (an agent's push: the app link it carries, e.g. its Aico session), × dismisses it (its page on the board has Stop
//! these); each of those clears it everywhere (notices::mark_seen).
//! Hiding by itself clears nothing: it still reaches the phone later if it was waiting for that (push.release_held).

use crate::notices;
use gtk::glib;
use gtk::prelude::*;
use serde_json::Value;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

const HIDE_S: u64 = 9;
const CSS: &str = "
.ns-row { background-color: #181c25; border: 1px solid #2b3242; border-radius: 10px; padding: 10px 12px; }
.ns-win button.ns-small { padding: 2px 8px; min-height: 0; font-size: 0.9em; }
.ns-win label.ns-rtitle { font-weight: bold; }
.ns-win label.ns-rbody { color: #c3c9d6; font-size: 0.92em; }
.ns-win label.ns-rmeta { color: #a3abbc; font-size: 0.85em; }
.ns-dot { min-width: 8px; min-height: 8px; border-radius: 4px; background-color: #86b4ff; margin-top: 7px; }
.ns-dot.critical { background-color: #ff6f6f; }
.ns-dot.warning { background-color: #f2b552; }
.ns-dot.ok { background-color: #5fd08f; }
";
pub const MAX: usize = 3;

fn text(t: &str, class: &str) -> gtk::Label {
    let l = gtk::Label::new(Some(t));
    l.set_xalign(0.0);
    l.set_wrap(true);
    l.set_wrap_mode(gtk::pango::WrapMode::WordChar);
    l.set_max_width_chars(44);
    l.set_width_chars(if class == "ns-rmeta" { 0 } else { 34 }); // wrapped labels otherwise ask for their narrowest width and a tall window
    l.add_css_class(class);
    l
}

fn card(e: &Value, main: &glib::MainLoop, then: &Rc<RefCell<Option<String>>>) -> gtk::Box {
    let id = e["id"].as_str().unwrap_or("").to_string();
    let row = gtk::Box::new(gtk::Orientation::Horizontal, 10);
    row.add_css_class("ns-row");
    let dot = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    dot.add_css_class("ns-dot");
    dot.add_css_class(e["severity"].as_str().unwrap_or("info"));
    dot.set_valign(gtk::Align::Start);
    let col = gtk::Box::new(gtk::Orientation::Vertical, 2);
    col.set_hexpand(true);
    col.append(&text(e["title"].as_str().unwrap_or("Aico"), "ns-rtitle"));
    let body = notices::desk_body(e["body"].as_str().unwrap_or(""), crate::ask::id_of(e).is_some());
    if !body.is_empty() {
        col.append(&text(body.lines().take(3).collect::<Vec<_>>().join("\n").as_str(), "ns-rbody"));
    }
    let meta = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    meta.append(&text(&notices::ago(crate::daemon::now() - e["ts"].as_f64().unwrap_or(0.0)), "ns-rmeta"));
    col.append(&meta);
    let close = gtk::Button::with_label("\u{d7}");
    close.add_css_class("ns-small");
    close.set_valign(gtk::Align::Start);
    close.set_tooltip_text(Some("Dismiss"));
    let i3 = id.clone();
    let (row2, main2) = (row.clone(), main.clone());
    close.connect_clicked(move |_| {
        eprintln!("toast: dismissed {i3}");
        notices::mark_seen(&i3);
        row2.set_visible(false);
        let mut c = row2.parent().and_then(|p| p.first_child());
        let mut any = false;
        while let Some(w) = c {
            any |= w.is_visible();
            c = w.next_sibling();
        }
        if !any {
            main2.quit();
        } else if let Some(win) = row2.root().and_downcast::<gtk::Window>() {
            win.set_default_size(380, 1); // only as tall as the cards left
        }
    });
    row.append(&dot);
    row.append(&col);
    row.append(&close);
    // a click on the card itself opens its card (notice.rs), or the app an agent's push points at (its Aico
    // session or share; an agent's question opens its card); the × button claims its own click
    let link = notices::open_link(e).filter(|_| crate::ask::id_of(e).is_none()); // an agent's question: its card here
    let click = gtk::GestureClick::new();
    click.set_button(1);
    let (main3, then2) = (main.clone(), then.clone());
    click.connect_released(move |_, _, _, _| {
        match &link {
            Some(link) => {
                eprintln!("toast: opened {id}");
                notices::mark_seen(&id);
                crate::browser::open(link);
            }
            None => *then2.borrow_mut() = Some(id.clone()), // its card (notice.rs), in this same place
        }
        main3.quit();
    });
    row.add_controller(click);
    row
}

/// The pushes to show: as the notifier hands them over on stdin (`toast --stdin`, a JSON array from its last store
/// read), else read from the store by id.
fn to_show(args: &[String]) -> Vec<Value> {
    let got: Vec<Value> = if args.first().map(String::as_str) == Some("--stdin") {
        let mut b = Vec::new();
        let _ = std::io::Read::read_to_end(&mut std::io::stdin(), &mut b);
        serde_json::from_slice(&b).unwrap_or_default()
    } else {
        let ids: Vec<String> = args.iter().filter(|i| notices::valid_entry_id(i)).cloned().collect();
        notices::entries(&ids).unwrap_or_else(|e| {
            eprintln!("toast: {e}");
            Vec::new()
        })
    };
    got.into_iter().filter(|e| e["id"].as_str().is_some_and(notices::valid_entry_id)).take(MAX).collect()
}

pub fn run(args: &[String]) -> i32 {
    let entries = to_show(args);
    if entries.is_empty() {
        return 0;
    }
    if gtk::init().is_err() {
        eprintln!("toast: no display");
        return 2;
    }
    crate::window::style(CSS);
    let main = glib::MainLoop::new(None, false);
    let win = gtk::Window::new();
    win.add_css_class("ns-win");
    win.set_title(Some("Aico"));
    crate::icons::set_default_window_icon();
    win.set_default_size(380, -1);
    let list = gtk::Box::new(gtk::Orientation::Vertical, 8);
    list.set_margin_top(10);
    list.set_margin_bottom(10);
    list.set_margin_start(10);
    list.set_margin_end(10);
    let then: Rc<RefCell<Option<String>>> = Rc::default(); // the notification clicked, to open as its card
    for e in &entries {
        list.append(&card(e, &main, &then));
    }
    win.set_child(Some(&list));
    let hovered = Rc::new(Cell::new(false));
    let motion = gtk::EventControllerMotion::new();
    let h2 = hovered.clone();
    motion.connect_contains_pointer_notify(move |m| h2.set(m.contains_pointer()));
    win.add_controller(motion);
    // hides HIDE_S after it shows, or once the pointer leaves after that
    let left = Rc::new(Cell::new(HIDE_S));
    let m2 = main.clone();
    glib::timeout_add_local(Duration::from_secs(1), move || {
        if !hovered.get() {
            left.set(left.get().saturating_sub(1));
        }
        if left.get() == 0 {
            m2.quit();
            return glib::ControlFlow::Break;
        }
        glib::ControlFlow::Continue
    });
    let m3 = main.clone();
    win.connect_close_request(move |_| {
        m3.quit();
        glib::Propagation::Proceed
    });
    // a notification: never takes the keyboard from what the owner is typing
    crate::anchor::place(&win, crate::anchor::Opts { notification: true, passive: true, popover: false });
    win.set_visible(true);
    eprintln!("toast {}: showing {}", std::process::id(), entries.iter().filter_map(|e| e["id"].as_str()).collect::<Vec<_>>().join(" "));
    main.run();
    win.set_visible(false);
    let clicked = then.borrow_mut().take();
    clicked.map_or(0, |id| {
        let e = entries.iter().find(|e| e["id"].as_str() == Some(id.as_str())).cloned();
        crate::notice::run_with(&id, Ok(e))
    })
}
