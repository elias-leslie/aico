//! Aico's lantern: the web app's own icon (packages/web-frontend/public/icons), written by the install to
//! ~/.local/lib/aico/icons (native/tray/install.sh). The tray shows it, with a dot while anything waits; windows and
//! notifications show it too. The app draws nothing itself, so the mark has one source.

use std::path::PathBuf;

pub const TRAY: &str = "aico-tray";
pub const TRAY_DOT: &str = "aico-tray-dot";

/// The icon directory (the tray's IconThemePath).
pub fn dir() -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(d) = std::env::var_os("AICO_ICON_DIR") {
        return PathBuf::from(d);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join(".local/lib/aico/icons")
}

/// The app icon's file (notification app_icon, window icon), when the install wrote it.
pub fn app_icon() -> Option<PathBuf> {
    Some(dir().join("aico.png")).filter(|p| p.is_file())
}

/// Windows get the icon (title bar, Alt+Tab): GTK4 takes window icons by theme name, so the icon directory joins the
/// search path (its plain aico.png is found there as an unthemed icon).
pub fn set_default_window_icon() {
    if app_icon().is_some() {
        if let Some(display) = gtk::gdk::Display::default() {
            gtk::IconTheme::for_display(&display).add_search_path(dir());
        }
        gtk::Window::set_default_icon_name("aico");
    }
}
