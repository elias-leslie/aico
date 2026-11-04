//! Aico tray. `aico-tray` runs the notifier (user unit aico-tray);
//! `aico-tray window <id> [--review] [--url URL]` is the approval window it starts on a button press;
//! `aico-tray toast <log id>...` is the corner card for new notifications;
//! `aico-tray notice <log id>` is one notification's card (a tray row or corner card clicked);
//! `aico-tray panel` is the inbox (Open inbox in the tray): needs you, approvals, questions, notifications;
//! `aico-tray probe [id]` says which security key is plugged in and whether it needs a PIN (touches nothing).

mod aico;
mod anchor;
mod ask;
mod browser;
mod daemon;
mod fido;
mod icons;
mod items;
mod key;
mod notice;
mod notices;
mod panel;
mod proto;
mod published;
mod quiet;
mod seal;
mod shell;
mod toast;
mod tray;
mod window;
mod x11;

/// The approve origin's host from Nightshift's site file (siteconf urls.approve_host): the approval path stays on
/// Nightshift's executor until the grants move (M5b), for the browser fallback link.
pub fn approve_host() -> String {
    std::fs::read("/etc/nightshift/site.json")
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v["urls"]["approve_host"].as_str().map(str::to_string))
        .filter(|h| !h.is_empty() && h.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-'))
        .unwrap_or_default()
}

static AICO_HOST: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

/// Aico's host, as aico-web's links name it (items::read keeps it); empty until the first read answers.
pub fn status_host() -> String {
    AICO_HOST.lock().map(|h| h.clone()).unwrap_or_default()
}

/// Keep the host of a link from aico-web (https://host/...) as Aico's, when it is a plain host name.
pub fn set_status_host(link: &str) {
    let host = link.strip_prefix("https://").and_then(|r| r.split(['/', '?', '#']).next()).unwrap_or("");
    if !host.is_empty() && host.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-') {
        if let Ok(mut h) = AICO_HOST.lock() {
            *h = host.to_string();
        }
    }
}

pub fn ask_url(kind: &str, id: &str) -> String {
    let path = match kind {
        "elevate" => "e", "passkey" => "k", "signing" => "g",
        _ => "",
    };
    let host = approve_host();
    if host.is_empty() || path.is_empty() || !proto::valid_id(id) {
        return if host.is_empty() { String::new() } else { format!("https://{host}/") };
    }
    format!("https://{host}/{path}/{id}")
}

fn probe(id: Option<&String>) -> i32 {
    let lib = match fido::Fido::load() {
        Ok(l) => l,
        Err(e) => {
            println!("libfido2: {e:?}");
            return 1;
        }
    };
    let paths = lib.devices().unwrap_or_default();
    if paths.is_empty() {
        println!("no security key found");
        return 1;
    }
    for p in paths {
        match lib.open(&p) {
            Ok(d) => {
                println!("{p}: fido2={} pin_set={} builtin_uv={} pin_retries={:?}", d.is_fido2(), d.has_pin(), d.has_uv(),
                         d.pin_retries());
                if let Some(ask) = id.and_then(|i| proto::ask(i).ok()) {
                    // silent (no touch, no PIN): does this key hold one of the credentials root accepts for the ask?
                    let creds: Vec<Vec<u8>> = ask["creds"].as_array().cloned().unwrap_or_default().iter()
                        .filter_map(|c| c.as_str().and_then(proto::unb64url)).collect();
                    let host = approve_host();
                    let rp = host.as_str();
                    match d.assert(rp, &[0u8; 32], &creds, None, false, false, None) {
                        Ok(a) => println!("  holds registered credential {} for {rp}", proto::b64url(&a.credential_id)),
                        Err(e) => println!("  silent check for {rp} ({} credentials): {e:?}", creds.len()),
                    }
                }
            }
            Err(e) => println!("{p}: cannot open: {e:?}"),
        }
    }
    0
}

fn main() {
    // the windows need no input method (a PIN and buttons): GTK's built-in one, so nothing auto-starts ibus
    std::env::set_var("GTK_IM_MODULE", "gtk-im-context-simple");
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        None => daemon::run(),
        Some("toast") => toast::run(&args[1..]),
        Some("notice") if args.len() >= 2 => notice::run(&args[1]),
        Some("panel") => panel::run(),
        Some("probe") => probe(args.get(1)),
        Some("window") if args.len() >= 2 => {
            let url = args.iter().position(|a| a == "--url").and_then(|i| args.get(i + 1)).cloned().unwrap_or_default();
            window::run(&args[1], args.iter().any(|a| a == "--review"), &url, args.iter().any(|a| a == "--passive"))
        }
        _ => {
            eprintln!("usage: aico-tray [window <id> [--review] [--passive] [--url URL] | toast <log id>... | notice <log id> | panel | probe]");
            64
        }
    };
    std::process::exit(code);
}
