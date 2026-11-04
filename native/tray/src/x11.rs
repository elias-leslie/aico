//! The X11 side of window placement. GTK4 dropped the window calls the app's dropdown windows relied on (move, keep
//! above, gravity), and the process runs on X11 (XWayland on GNOME Wayland) precisely so that placement keeps working,
//! so they are done here over a small X connection of our own (x11rb): the window's position, its above/notification
//! hints, and the pointer's root position. Everything is best effort: no X connection, nothing moves.

use gtk::{gdk, glib};
use gtk::prelude::*;
use std::rc::Rc;
use x11rb::connection::Connection;
use x11rb::properties::{WmSizeHints, WmSizeHintsSpecification};
use x11rb::protocol::xproto::{
    AtomEnum, ChangeWindowAttributesAux, ClientMessageEvent, ConfigureWindowAux, ConnectionExt, EventMask, PropMode, Window,
    CLIENT_MESSAGE_EVENT,
};
use x11rb::protocol::Event;
use std::os::fd::AsRawFd;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

pub struct X {
    conn: RustConnection,
    root: Window,
}

fn atom(x: &X, name: &str) -> Option<u32> {
    Some(x.conn.intern_atom(false, name.as_bytes()).ok()?.reply().ok()?.atom)
}

impl X {
    /// The X connection for this GDK display (None when it is not an X11 one or the server doesn't answer).
    pub fn connect(display: &gdk::Display) -> Option<Rc<X>> {
        display.clone().downcast::<gdk4_x11::X11Display>().ok()?;
        let (conn, screen) = x11rb::connect(Some(display.name().as_str())).ok()?;
        let root = conn.setup().roots.get(screen)?.root;
        Some(Rc::new(X { conn, root }))
    }

    /// The pointer in root window (device pixel) coordinates.
    pub fn pointer(&self) -> Option<(i32, i32)> {
        let p = self.conn.query_pointer(self.root).ok()?.reply().ok()?;
        Some((i32::from(p.root_x), i32::from(p.root_y)))
    }

    /// Before the window is shown: it is a notification (no focus, no frame) and starts above the others.
    pub fn prepare(&self, win: Window, notification: bool) {
        let (Some(wtype), Some(note), Some(state), Some(above)) = (
            atom(self, "_NET_WM_WINDOW_TYPE"), atom(self, "_NET_WM_WINDOW_TYPE_NOTIFICATION"),
            atom(self, "_NET_WM_STATE"), atom(self, "_NET_WM_STATE_ABOVE"),
        ) else { return };
        if notification {
            let _ = self.conn.change_property32(PropMode::REPLACE, win, wtype, AtomEnum::ATOM, &[note]);
        }
        let _ = self.conn.change_property32(PropMode::REPLACE, win, state, AtomEnum::ATOM, &[above]);
        let _ = self.conn.flush();
    }

    /// Once shown: ask the window manager to keep the window above the others (_NET_WM_STATE_ABOVE).
    pub fn keep_above(&self, win: Window) {
        let (Some(state), Some(above)) = (atom(self, "_NET_WM_STATE"), atom(self, "_NET_WM_STATE_ABOVE")) else { return };
        let ev = ClientMessageEvent { response_type: CLIENT_MESSAGE_EVENT, format: 32, sequence: 0, window: win,
                                      type_: state, data: [1u32, above, 0, 1, 0].into() };
        let _ = self.conn.send_event(false, self.root, EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY, ev);
        let _ = self.conn.flush();
    }

    /// Put the window's top-left at (x, y) in root coordinates. `hint` also tells the window manager the position is
    /// the program's own (USPosition), for a window it has not placed yet.
    pub fn move_to(&self, win: Window, x: i32, y: i32, hint: bool) {
        if hint {
            let mut h = WmSizeHints::new();
            h.position = Some((WmSizeHintsSpecification::UserSpecified, x, y));
            let _ = h.set_normal_hints(&self.conn, win);
        }
        let _ = self.conn.configure_window(win, &ConfigureWindowAux::new().x(x).y(y));
        let _ = self.conn.flush();
    }

    /// Call `f(width, height)` (device pixels) with the window's size now and each time it changes. The size comes
    /// from the X server's own ConfigureNotify events, which GDK's signals don't give for a window that was resized
    /// before it was mapped.
    pub fn on_resize(self: &Rc<X>, win: Window, f: impl Fn(i32, i32) + 'static) {
        let _ = self.conn.change_window_attributes(win, &ChangeWindowAttributesAux::new().event_mask(EventMask::STRUCTURE_NOTIFY));
        if let Some(g) = self.conn.get_geometry(win).ok().and_then(|c| c.reply().ok()) {
            f(i32::from(g.width), i32::from(g.height));
        }
        let _ = self.conn.flush();
        let x = self.clone();
        glib_unix::unix_fd_add_local(self.conn.stream().as_raw_fd(), glib::IOCondition::IN, move |_, _| {
            while let Ok(Some(ev)) = x.conn.poll_for_event() {
                if let Event::ConfigureNotify(c) = ev {
                    if c.window == win {
                        f(i32::from(c.width), i32::from(c.height));
                    }
                }
            }
            glib::ControlFlow::Continue
        });
    }
}
