//! Where the app's windows open: next to the tray moon, like a dropdown from the panel. The tray records where the
//! owner clicked it (StatusNotifierItem Activate x, y); every window (approval, from a notification too) opens
//! on that monitor, in the panel's corner at the right edge, inside the monitor's work area (never centred). Without a click yet, the
//! panel's side comes from the work area (_NET_WORKAREA against the monitor; the owner's panel is at the bottom), and
//! the window sits in that corner at the right.

use crate::x11::X as X11;
use gtk::gdk;
use gtk::prelude::*;
use std::cell::Cell;
use std::path::PathBuf;

const MARGIN: i32 = 8;
/// Set on a window started from the tray (its icon or menu): the pointer is then beside the icon.
pub const FROM_TRAY: &str = "AICO_FROM_TRAY";
/// Set on the inbox when the GNOME Shell extension shows the icon (shell.rs): it opens as the icon's popover.
pub const POPOVER: &str = "AICO_POPOVER";

fn path() -> PathBuf {
    std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("aico-tray-anchor")
}

/// The tray was clicked here (root window coordinates).
pub fn record(x: i32, y: i32) {
    if x > 0 || y > 0 {
        let _ = std::fs::write(path(), format!("{x} {y}\n"));
    }
}

pub fn recorded() -> Option<(i32, i32)> {
    let s = std::fs::read_to_string(path()).ok()?;
    let mut it = s.split_whitespace().map(|v| v.parse::<i32>().ok());
    Some((it.next()??, it.next()??))
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// Top-left for a window of `size` on a monitor (`mon` geometry, `work` its work area); the click says which side
/// the panel is on.
pub fn spot(mon: Rect, work: Rect, click: Option<(i32, i32)>, size: (i32, i32)) -> (i32, i32) {
    let (w, h) = (size.0.min(work.w - 2 * MARGIN), size.1.min(work.h - 2 * MARGIN));
    let bottom_gap = (mon.y + mon.h) - (work.y + work.h);
    let top_gap = work.y - mon.y;
    let bottom = match click {
        Some((_, cy)) => cy > mon.y + mon.h / 2,
        None => bottom_gap >= top_gap,
    };
    // flush right, whatever the click's x: on an ultrawide the centre, where the owner works, stays clear
    let x = work.x + work.w - MARGIN - w;
    let y = if bottom { work.y + work.h - MARGIN - h } else { work.y + MARGIN };
    (x, y)
}

fn rect(r: &gdk::Rectangle) -> Rect {
    Rect { x: r.x(), y: r.y(), w: r.width(), h: r.height() }
}

/// How a window sits: `notification` marks a card that is not a normal window (the toast); `passive` keeps it from
/// taking the keyboard when it shows; `popover` is the inbox dropping from the shell extension's icon.
#[derive(Clone, Copy, Default)]
pub struct Opts {
    pub notification: bool,
    pub passive: bool,
    pub popover: bool,
}

fn monitor_at(display: &gdk::Display, x: i32, y: i32) -> Option<gdk::Monitor> {
    let list = display.monitors();
    (0..list.n_items()).filter_map(|i| list.item(i).and_downcast::<gdk::Monitor>()).find(|m| {
        let g = rect(&m.geometry());
        x >= g.x && x < g.x + g.w && y >= g.y && y < g.y + g.h
    })
}

fn primary_monitor(display: &gdk::Display) -> Option<gdk::Monitor> {
    display.clone().downcast::<gdk4_x11::X11Display>().ok().map(|d| d.primary_monitor())
        .or_else(|| display.monitors().item(0).and_downcast::<gdk::Monitor>())
}

/// The monitor's work area (the part the panel leaves free: _NET_WORKAREA) on X11, else its whole geometry.
fn workarea(monitor: &gdk::Monitor) -> Rect {
    match monitor.clone().downcast::<gdk4_x11::X11Monitor>() {
        Ok(m) => rect(&m.workarea()),
        Err(_) => rect(&monitor.geometry()),
    }
}

/// Make `win` a popover-like window at the tray: no title bar, above others, out of the taskbar, placed beside the
/// icon. Call after its children are added and before showing it. GTK4 has no window move, keep-above or gravity, so
/// on X11 (the backend this app runs on) they are done over X (x11.rs); the window keeps its right edge and its
/// panel-side edge where they are when its size changes (a wider ask, Details, the PIN field).
pub fn place(win: &gtk::Window, opts: Opts) {
    if opts.popover {
        popover(win);
        return;
    }
    win.set_decorated(false);
    WidgetExt::realize(win);
    let Some(display) = gdk::Display::default() else { return };
    let Some(surface) = win.surface().and_then(|s| s.downcast::<gdk4_x11::X11Surface>().ok()) else { return };
    surface.set_skip_taskbar_hint(true);
    if opts.passive {
        surface.set_user_time(0); // no focus when it maps
    }
    let Some(x11) = X11::connect(&display) else { return };
    let xid = surface.xid() as u32;
    let scale = surface.scale_factor().max(1);
    // opened from the tray menu: the pointer is on the menu, just beside the icon (the menu sends no position)
    if std::env::var_os(FROM_TRAY).is_some() {
        if let Some((x, y)) = x11.pointer() {
            record(x / scale, y / scale);
        }
    }
    let click = recorded();
    let monitor = click.and_then(|(x, y)| monitor_at(&display, x, y)).or_else(|| primary_monitor(&display));
    let Some(monitor) = monitor else { return };
    let (mon, work) = (rect(&monitor.geometry()), workarea(&monitor));
    let width = win.default_size().0.max(1);
    let (x, y) = spot(mon, work, click, (width, 0));
    let bottom = y > work.y + MARGIN;
    // GTK3's gravity put the east and south edges MARGIN beyond spot()'s (flush with the work area; measured under
    // mutter and openbox against the GTK3 build); the north edge sits at spot()'s. Kept, so windows sit where they did.
    let (right, edge) = (x + width + MARGIN, if bottom { y + MARGIN } else { y });
    x11.prepare(xid, opts.notification);
    x11.move_to(xid, x * scale, y * scale, true);
    // a size change (the first one included) moves the window so the right edge and the panel-side edge stay put
    let x2 = x11.clone();
    let last = Cell::new((i32::MIN, i32::MIN));
    x11.on_resize(xid, move |w, h| {
        let (w, h) = (w / scale, h / scale);
        let to = (right - w, if bottom { edge - h } else { edge });
        if last.replace(to) != to {
            x2.move_to(xid, to.0 * scale, to.1 * scale, false);
        }
    });
    let x3 = x11;
    win.connect_map(move |_| x3.keep_above(xid));
}

/// The inbox as the icon's popover: rounded, with a shadow and no title bar (client-side decorations with an empty
/// title bar draw both, and tell the compositor where the visible edge is). The shell extension puts it under the icon,
/// keeps it above, focuses it and closes it on a click elsewhere; Escape is the panel's own.
fn popover(win: &gtk::Window) {
    win.set_titlebar(Some(&gtk::Box::new(gtk::Orientation::Horizontal, 0)));
    win.set_resizable(false);
    win.add_css_class("ns-popover");
    WidgetExt::realize(win);
    if let Some(surface) = win.surface().and_then(|s| s.downcast::<gdk4_x11::X11Surface>().ok()) {
        surface.set_skip_taskbar_hint(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MON: Rect = Rect { x: 0, y: 0, w: 8192, h: 3456 };
    const WORK_BOTTOM_PANEL: Rect = Rect { x: 0, y: 0, w: 8192, h: 3396 };

    #[test]
    fn opens_just_above_the_moon_on_a_bottom_panel() {
        let (x, y) = spot(MON, WORK_BOTTOM_PANEL, Some((7142, 3420)), (600, 400));
        assert_eq!((x, y), (8192 - 8 - 600, 3396 - 8 - 400));
    }

    #[test]
    fn without_a_click_the_work_area_shows_the_panel_side() {
        assert_eq!(spot(MON, WORK_BOTTOM_PANEL, None, (600, 400)), (8192 - 8 - 600, 3396 - 8 - 400));
        let top = Rect { x: 0, y: 32, w: 1920, h: 1048 };
        assert_eq!(spot(Rect { x: 0, y: 0, w: 1920, h: 1080 }, top, None, (600, 400)), (1920 - 8 - 600, 40));
    }

    #[test]
    fn stays_on_its_monitor() {
        let second = Rect { x: 1920, y: 0, w: 1920, h: 1080 };
        let (x, _) = spot(second, second, Some((3830, 1070)), (600, 400));
        assert_eq!(x, 1920 + 1920 - 8 - 600);
        let (x, y) = spot(second, second, Some((1925, 10)), (600, 400));
        assert_eq!((x, y), (1920 + 1920 - 8 - 600, 8)); // a top panel: below it
    }
}
