//! "Open in browser": today's web path, unchanged. Chrome in the owner's own profile when Chrome is the default
//! browser and that profile exists (agents' browser work runs in another one), else xdg-open.

use std::path::PathBuf;
use std::process::{Command, Stdio};

const OWNER_PROFILE: &str = "Default"; // AICO_APPROVE_CHROME_PROFILE names another ("" = system default)

fn default_browser() -> String {
    Command::new("xdg-settings")
        .args(["get", "default-web-browser"])
        .stderr(Stdio::null())
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

fn which(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")?.to_str()?.split(':').map(|d| PathBuf::from(d).join(name)).find(|p| p.is_file())
}

pub fn argv(url: &str) -> Vec<String> {
    let profile = std::env::var("AICO_APPROVE_CHROME_PROFILE").unwrap_or_else(|_| OWNER_PROFILE.into());
    let home = std::env::var("HOME").unwrap_or_default();
    if let Some(chrome) = which("google-chrome") {
        if !profile.is_empty() && !profile.contains('/') && default_browser().starts_with("google-chrome")
            && PathBuf::from(&home).join(".config/google-chrome").join(&profile).join("Preferences").is_file() {
            return vec![chrome.to_string_lossy().into(), format!("--profile-directory={profile}"), url.into()];
        }
    }
    vec!["xdg-open".into(), url.into()]
}

pub fn open(url: &str) {
    if !url.starts_with("https://") {
        return;
    }
    let a = argv(url);
    let _ = Command::new(&a[0]).args(&a[1..]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
}
