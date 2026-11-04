//! The lantern in GNOME's top bar (shell-extension/nightshift-tray@summitflow.dev: the extension keeps its id and bus
//! names, since GNOME Shell on Wayland loads a renamed extension only after the next login; only its words are Aico's). The extension only draws the
//! icon, its count and tooltip, and asks this app for the rest over D-Bus, so all rich UI stays here and a crash here
//! never takes GNOME Shell down. This side exports dev.summitflow.NightshiftTray next to the StatusNotifierItem
//! (tray.rs): the icon file, count, attention and tooltip as properties (PropertiesChanged when they change), Open (the
//! inbox), Menu / MenuClick (the tray menu's rows, for a right click) and PanelOpened(pid), so the extension can drop
//! that window from the icon as a popover. While the extension holds SHELL_NAME the StatusNotifierItem goes Passive
//! (GNOME's AppIndicator extension hides it): one icon, and the other is back as soon as the extension is gone.

use crate::tray::{Click, View};
use gtk::gio;
use gtk::glib::{Variant, VariantTy};
use gtk::prelude::ToVariant;
use std::collections::HashMap;
use std::sync::Arc;

pub const NAME: &str = "dev.summitflow.NightshiftTray";
pub const PATH: &str = "/dev/summitflow/NightshiftTray";
pub const IFACE: &str = "dev.summitflow.NightshiftTray";
/// Held by the extension while it shows the icon.
pub const SHELL_NAME: &str = "dev.summitflow.NightshiftTray.Shell";

const XML: &str = r#"<node><interface name="dev.summitflow.NightshiftTray">
<property name="Icon" type="s" access="read"/><property name="Label" type="s" access="read"/>
<property name="Attention" type="b" access="read"/><property name="ToolTip" type="s" access="read"/>
<method name="Open"/>
<method name="Menu"><arg name="rows" type="a(isb)" direction="out"/></method>
<method name="MenuClick"><arg name="id" type="i" direction="in"/></method>
<signal name="PanelOpened"><arg name="pid" type="u"/></signal>
</interface></node>"#;

/// The properties for `v`: the icon file (the icon, with a dot while anything waits), the number beside it, whether an
/// approval waits, and the tooltip; the same values the StatusNotifierItem shows.
pub fn props(v: &View) -> Vec<(&'static str, Variant)> {
    let icon = crate::icons::dir().join(format!("{}.png", crate::tray::icon_of(v)));
    vec![
        ("Icon", icon.to_string_lossy().to_variant()),
        ("Label", crate::tray::label_of(v).to_variant()),
        ("Attention", (!v.asks.is_empty()).to_variant()),
        ("ToolTip", crate::tray::tooltip_of(v).to_variant()),
    ]
}

/// The tray menu's rows as of `now`: id, label (empty: a separator), whether it can be clicked.
pub fn menu(v: &View, now: f64) -> Vec<(i32, String, bool)> {
    crate::tray::rows_at(v, now).into_iter()
        .map(|r| if crate::tray::is_sep(r.id) { (r.id, String::new(), false) } else { (r.id, r.label, r.enabled) })
        .collect()
}

/// Export the interface; `view` reads the tray's current view, `clicks` is the tray's own click handler.
pub fn export(conn: &gio::DBusConnection, view: impl Fn() -> View + Send + Sync + 'static,
              clicks: Arc<dyn Fn(Click) + Send + Sync>) -> Option<()> {
    let iface = gio::DBusNodeInfo::for_xml(XML).ok()?.lookup_interface(IFACE)?;
    let view = Arc::new(view);
    let v2 = view.clone();
    conn.register_object(PATH, &iface)
        .method_call(move |_, _, _, _, method, params, inv| match method {
            "Open" => {
                eprintln!("shell: Open");
                clicks(Click::Inbox);
                inv.return_value(None);
            }
            "Menu" => {
                let rows = menu(&view(), crate::daemon::now()).into_iter().map(|r| r.to_variant());
                let arr = Variant::array_from_iter_with_type(VariantTy::new("(isb)").unwrap(), rows);
                inv.return_value(Some(&Variant::tuple_from_iter([arr])));
            }
            "MenuClick" => {
                let id: i32 = params.child_value(0).get().unwrap_or(-1);
                let click = crate::tray::click_for(&view(), id);
                inv.return_value(None);
                if let Some(c) = click {
                    eprintln!("shell: menu {c:?}");
                    clicks(c);
                }
            }
            _ => inv.return_value(None),
        })
        .property(move |_, _, _, _, prop| {
            props(&v2()).into_iter().find(|(k, _)| *k == prop).map_or_else(|| "".to_variant(), |(_, v)| v)
        })
        .set_property(|_, _, _, _, _, _| false)
        .build().ok()?;
    let owned = conn.call_sync(Some("org.freedesktop.DBus"), "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
        Some(&(NAME, 4u32).to_variant()), None, gio::DBusCallFlags::NONE, 3000, None::<&gio::Cancellable>);
    // 1: ours; 4: ours already; 3: another instance has it (an overlapping restart): the extension talks to that one
    match owned.map(|r| r.child_value(0).get::<u32>()) {
        Ok(Some(1 | 4)) => Some(()),
        Ok(reply) => {
            eprintln!("shell: {NAME} is held by another instance ({reply:?})");
            None
        }
        Err(e) => {
            eprintln!("shell: could not take the name {NAME} ({e})");
            None
        }
    }
}

/// Tell the extension what changed between `old` and `new` (nothing when nothing did).
pub fn changed(conn: &gio::DBusConnection, old: &View, new: &View) {
    let before = props(old);
    let diff: HashMap<String, Variant> = props(new).into_iter().zip(before)
        .filter(|((_, a), (_, b))| a != b).map(|((k, v), _)| (k.to_string(), v)).collect();
    if diff.is_empty() {
        return;
    }
    let args = (IFACE, diff, Vec::<String>::new()).to_variant();
    let _ = conn.emit_signal(None, PATH, "org.freedesktop.DBus.Properties", "PropertiesChanged", Some(&args));
}

/// The inbox panel started as `pid`: the extension places its window under the icon.
pub fn panel_opened(conn: &gio::DBusConnection, pid: u32) {
    let _ = conn.emit_signal(None, PATH, IFACE, "PanelOpened", Some(&(pid,).to_variant()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn properties_follow_the_tray() {
        let quiet = View { unread: Some(0), ..Default::default() };
        let p: HashMap<_, _> = props(&quiet).into_iter().collect();
        assert!(p["Icon"].str().unwrap().ends_with("/aico-tray.png"));
        assert_eq!(p["Label"].str(), Some(""));
        assert_eq!(p["Attention"].get::<bool>(), Some(false));
        assert_eq!(p["ToolTip"].str(), Some("No approvals waiting, nothing new"));
        let busy = View { unread: Some(3), ..Default::default() };
        let q: HashMap<_, _> = props(&busy).into_iter().collect();
        assert!(q["Icon"].str().unwrap().ends_with("/aico-tray-dot.png"));
        assert_eq!(q["Label"].str(), Some("3"));
        // what PropertiesChanged would carry: only the changed ones
        let diff: Vec<&str> = props(&busy).into_iter().zip(props(&quiet))
            .filter(|((_, a), (_, b))| a != b).map(|((k, _), _)| k).collect();
        assert_eq!(diff, vec!["Icon", "Label", "ToolTip"]);
    }

    #[test]
    fn menu_is_the_tray_menu() {
        let v = View { unread: Some(2), ..Default::default() };
        let rows = menu(&v, 1_000_000.0);
        let tray = crate::tray::rows_at(&v, 1_000_000.0);
        assert_eq!(rows.len(), tray.len());
        assert!(rows.iter().any(|(_, l, on)| l == "Open inbox (2)" && *on));
        assert!(rows.iter().any(|(_, l, on)| l.is_empty() && !*on)); // the separator
        assert!(rows.iter().any(|(_, l, _)| l == "Quiet for 1 hour"));
        assert_eq!(Variant::array_from_iter_with_type(VariantTy::new("(isb)").unwrap(), rows.iter().map(|r| r.to_variant()))
                       .type_().as_str(), "a(isb)");
    }
}
