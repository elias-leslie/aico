//! aico-web's tray door (packages/web-server/src/tray.ts): plain HTTP/1.1 on loopback, one request per connection.
//! GET /api/tray is the panel's data (built from Aico's Status, asks and
//! notices), POST /api/tray/seen records reads, GET /api/tray/notice/<id> is a notice's card. No TLS, no auth: the
//! door answers this machine only.

use serde_json::Value;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

const DEFAULT_PORT: u16 = 3002;
const TIMEOUT: Duration = Duration::from_secs(8);

fn port() -> u16 {
    std::env::var("AICO_WEB_PORT").ok().and_then(|p| p.trim().parse().ok()).unwrap_or(DEFAULT_PORT)
}

/// The body of a chunked response.
fn unchunk(mut raw: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let eol = raw.windows(2).position(|w| w == b"\r\n")?;
        let size = usize::from_str_radix(std::str::from_utf8(&raw[..eol]).ok()?.split(';').next()?.trim(), 16).ok()?;
        raw = &raw[eol + 2..];
        if size == 0 {
            return Some(out);
        }
        out.extend_from_slice(raw.get(..size)?);
        raw = raw.get(size + 2..)?;
    }
}

/// (status, body) of one parsed response.
fn parse(raw: &[u8]) -> Result<(u16, Vec<u8>), String> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("Aico answered with something that is not HTTP")?;
    let head = String::from_utf8_lossy(&raw[..split]).to_lowercase();
    let status = head.split_whitespace().nth(1).and_then(|c| c.parse().ok()).ok_or("Aico gave no status")?;
    let body = &raw[split + 4..];
    let body = if head.contains("transfer-encoding: chunked") {
        unchunk(body).ok_or("Aico's answer was cut off")?
    } else {
        body.to_vec()
    };
    Ok((status, body))
}

fn request(method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
    let port = port();
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, TIMEOUT).map_err(|e| format!("Aico isn't answering on port {port} ({e})"))?;
    let _ = s.set_read_timeout(Some(TIMEOUT));
    let _ = s.set_write_timeout(Some(TIMEOUT));
    let payload = body.map(Value::to_string).unwrap_or_default();
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nConnection: close\r\n");
    if body.is_some() {
        req += &format!("Content-Type: application/json\r\nContent-Length: {}\r\n", payload.len());
    }
    req += "\r\n";
    req += &payload;
    s.write_all(req.as_bytes()).map_err(|e| format!("Aico didn't take the request ({e})"))?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).map_err(|e| format!("Aico stopped answering ({e})"))?;
    let (status, body) = parse(&raw)?;
    let v: Value = serde_json::from_slice(&body).map_err(|_| format!("Aico answered {status} without a reading"))?;
    if status >= 400 {
        return Err(v["detail"].as_str().or_else(|| v["error"].as_str()).map_or_else(|| format!("Aico answered {status}"), str::to_string));
    }
    Ok(v)
}

pub fn get(path: &str) -> Result<Value, String> {
    request("GET", path, None)
}

pub fn post(path: &str, body: &Value) -> Result<Value, String> {
    request("POST", path, Some(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_and_chunked_answers_parse() {
        let (s, b) = parse(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").unwrap();
        assert_eq!((s, b.as_slice()), (200, b"{}".as_slice()));
        let (s, b) = parse(b"HTTP/1.1 403 Forbidden\r\nTransfer-Encoding: chunked\r\n\r\n3\r\n{\"a\r\n4\r\n\":1}\r\n0\r\n\r\n").unwrap();
        assert_eq!((s, String::from_utf8(b).unwrap().as_str()), (403, "{\"a\":1}"));
        assert!(parse(b"nonsense").is_err());
    }
}
