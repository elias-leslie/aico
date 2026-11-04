//! An agent's question to the owner (a Tether ask, `tether ask create`): its push links Aico (`?ask=<id>`); on the
//! desktop the notification card shows the question and sends the answer itself, over the owner's Tether control
//! socket (GET /v1/asks/:id, POST /v1/asks/:id/answer, as Aico's drawer does). Tether hands the answer to the agent.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

/// The ask a notification is about: the 12-hex id in its Aico link (refs.open `...?ask=<id>`).
pub fn id_of(e: &Value) -> Option<String> {
    let url = e["refs"]["open"].as_str()?;
    let q = &url[url.find('?')? + 1..];
    let id = q.split(['&', '#']).find_map(|kv| kv.strip_prefix("ask="))?;
    (id.len() == 12 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).then(|| id.to_string())
}

/// The owner's Tether (default instance), found as the tether CLI finds it: TETHER_SOCKET, else
/// TETHER_RUNTIME_DIR or $XDG_RUNTIME_DIR/tether/default, control.sock.
fn socket() -> PathBuf {
    if let Some(s) = std::env::var_os("TETHER_SOCKET").filter(|s| !s.is_empty()) {
        return s.into();
    }
    let dir = std::env::var_os("TETHER_RUNTIME_DIR").filter(|s| !s.is_empty()).map(PathBuf::from).unwrap_or_else(|| {
        std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(format!("/run/user/{}", unsafe { libc::getuid() })))
            .join("tether/default")
    });
    dir.join("control.sock")
}

fn call(method: &str, path: &str, body: Option<&Value>) -> Result<(u16, Value), String> {
    call_at(&socket(), method, path, body)
}

fn call_at(sock: &std::path::Path, method: &str, path: &str, body: Option<&Value>) -> Result<(u16, Value), String> {
    let mut s = UnixStream::connect(sock).map_err(|e| format!("Tether isn't reachable ({e})"))?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(10)));
    let data = body.map(Value::to_string).unwrap_or_default();
    let req = format!("{method} {path} HTTP/1.1\r\nHost: tether\r\nConnection: close\r\nContent-Type: application/json\r\n\
                       Content-Length: {}\r\n\r\n{data}", data.len());
    s.write_all(req.as_bytes()).map_err(|e| format!("Tether: {e}"))?;
    let mut out = Vec::new();
    s.take(1 << 20).read_to_end(&mut out).map_err(|e| format!("Tether: {e}"))?;
    parse(&out)
}

fn parse(out: &[u8]) -> Result<(u16, Value), String> {
    let text = String::from_utf8_lossy(out);
    let (head, body) = text.split_once("\r\n\r\n").ok_or("Tether gave no answer")?;
    let status = head.split_whitespace().nth(1).and_then(|c| c.parse::<u16>().ok()).ok_or("Tether gave no answer")?;
    Ok((status, serde_json::from_str(body).unwrap_or(Value::Null)))
}

/// What a refusal means to the owner.
fn refused(status: u16, v: &Value) -> String {
    match (status, v["error"].as_str().unwrap_or("")) {
        (404, _) => "Tether no longer has this question".into(),
        (409, _) => format!("This question was closed meanwhile ({})", v["state"].as_str().unwrap_or("closed")),
        (400, _) => format!("Tether didn't accept the answer{}", v["detail"].as_str().map(|d| format!(": {d}")).unwrap_or_default()),
        (_, e) if !e.is_empty() => format!("Tether refused it ({e})"),
        _ => format!("Tether answered {status}"),
    }
}

fn ok(r: (u16, Value)) -> Result<Value, String> {
    if (200..300).contains(&r.0) && r.1.is_object() { Ok(r.1) } else { Err(refused(r.0, &r.1)) }
}

pub fn get(id: &str) -> Result<Value, String> {
    ok(call("GET", &format!("/v1/asks/{id}"), None)?)
}

/// The owner's answer from the panel's list (the store's questions): sent only while Tether still has the ask open,
/// and a choice as the text the owner saw, so an agent re-filing the ask with other options in between can't change
/// what is recorded, and an ask answered elsewhere meanwhile is not answered again.
pub fn answer_shown(id: &str, option: Option<usize>, shown: &[Value], text: &str, note: &str) -> Result<Value, String> {
    let a = get(id)?;
    match a["state"].as_str().unwrap_or("") {
        "open" => {}
        s => return Err(format!("This question was {} meanwhile", if s.is_empty() { "closed" } else { s })),
    }
    let text = match option {
        Some(i) => shown.get(i).and_then(Value::as_str).ok_or("no such choice")?.to_string(),
        None => text.to_string(),
    };
    answer(id, None, &text, note)
}

/// The owner's answer: one of its choices (by index) or their own words, and an optional note.
pub fn answer(id: &str, option: Option<usize>, text: &str, note: &str) -> Result<Value, String> {
    ok(call("POST", &format!("/v1/asks/{id}/answer"), Some(&body(option, text, note)))?)
}

fn body(option: Option<usize>, text: &str, note: &str) -> Value {
    let mut b = json!({});
    match option {
        Some(i) => b["option"] = i.into(),
        None if !text.trim().is_empty() => b["text"] = text.trim().into(),
        None => {}
    }
    if !note.trim().is_empty() {
        b["note"] = note.trim().into();
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_ask_in_its_aico_link_only() {
        assert_eq!(id_of(&json!({"refs": {"open": "https://aico.example/?ask=e0062e61c89f"}})).as_deref(), Some("e0062e61c89f"));
        assert_eq!(id_of(&json!({"refs": {"open": "https://aico.example/?x=1&ask=e0062e61c89f#a"}})).as_deref(), Some("e0062e61c89f"));
        for bad in ["https://aico.example/?share=e0062e61c89f", "https://aico.example/?ask=E0062E61C89F",
                    "https://aico.example/?ask=e0062e61c89f00", "https://aico.example/ask=e0062e61c89f"] {
            assert_eq!(id_of(&json!({"refs": {"open": bad}})), None, "{bad}");
        }
        assert_eq!(id_of(&json!({"refs": {}})), None);
    }

    #[test]
    fn sends_a_choice_or_words_never_both() {
        assert_eq!(body(Some(1), "ignored", " why "), json!({"option": 1, "note": "why"}));
        assert_eq!(body(None, " Later ", ""), json!({"text": "Later"}));
        assert_eq!(body(None, " ", "just a note"), json!({"note": "just a note"}));
    }

    #[test]
    fn reads_tethers_reply_and_says_why_it_refused() {
        let r = parse(b"HTTP/1.1 409 Conflict\r\ncontent-type: application/json\r\n\r\n{\"error\":\"ask_closed\",\"state\":\"done\"}").unwrap();
        assert_eq!(ok(r).unwrap_err(), "This question was closed meanwhile (done)");
        let r = parse(b"HTTP/1.1 200 OK\r\n\r\n{\"id\":\"e0062e61c89f\",\"state\":\"answered\"}").unwrap();
        assert_eq!(ok(r).unwrap()["state"], "answered");
        assert!(parse(b"garbage").is_err());
    }

    #[test]
    fn talks_to_a_tether_socket() {
        let dir = std::env::temp_dir().join(format!("ns-ask-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("control.sock");
        let _ = std::fs::remove_file(&path);
        let l = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let t = std::thread::spawn(move || {
            let (mut c, _) = l.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = c.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            c.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 34\r\n\r\n{\"id\":\"e0062e61c89f\",\"state\":\"answered\"}").unwrap();
            req
        });
        let v = ok(call_at(&path, "POST", "/v1/asks/e0062e61c89f/answer", Some(&body(Some(0), "", ""))).unwrap()).unwrap();
        let req = t.join().unwrap();
        assert!(req.starts_with("POST /v1/asks/e0062e61c89f/answer HTTP/1.1\r\n") && req.ends_with("{\"option\":0}"), "{req}");
        assert_eq!(v["state"], "answered");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
