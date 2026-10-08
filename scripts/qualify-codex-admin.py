#!/usr/bin/env python3
"""Installed TUI qualification in a private tmux server and network namespace.

Only synthetic input is used. stdout contains assertions/metadata, never text.
Run: unshare -Urn python3 scripts/qualify-codex-admin.py [--raw]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import sqlite3
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def wait_for(probe, label, timeout=8):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        value = probe()
        if value:
            return value
        time.sleep(0.025)
    raise AssertionError(label)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", default=str(Path.home() / ".local/bin/codex-real"),
                        help="installed binary, bypassing contextual launcher wrappers")
    parser.add_argument("--raw", action="store_true", help="assert raw text + immediate Enter delivery (expected red)")
    parser.add_argument("--human-draft", action="store_true", help="stage a concurrent draft (expected exact-text red)")
    parser.add_argument("--human-input", action="store_true", help="inject human input between paste and Enter (expected red)")
    parser.add_argument("--leading-escape", action="store_true", help="assert a leading Escape leaks literal paste framing")
    args = parser.parse_args()
    # Refuse to run where external traffic or a shared daemon could be reached.
    routes = json.loads(subprocess.run(["ip", "-json", "route", "show"], check=True,
                                      capture_output=True).stdout)
    links = json.loads(subprocess.run(["ip", "-json", "link", "show"], check=True,
                                     capture_output=True).stdout)
    assert routes == [] and [link["ifname"] for link in links] == ["lo"], \
        "run inside a fresh unshare -Urn network namespace"
    subprocess.run(["ip", "link", "set", "lo", "up"], check=True, capture_output=True)
    receipts = []
    request_shapes = []

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            pass

        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            assert length <= 1024 * 1024
            request = json.loads(self.rfile.read(length))
            messages = [item for item in request.get("input", []) if item.get("role") == "user"]
            text = "".join(part.get("text", "") for part in messages[-1].get("content", []))
            title_request = set(request.get("text", {}).get("format", {}).get("schema", {}).get("properties", {})) == {"title"}
            if not title_request:
                receipts.append(hashlib.sha256(text.encode()).hexdigest())
            request_shapes.append({"path": self.path, "title": title_request,
                                   "user_items": len(messages), "last_user_bytes": len(text.encode())})
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            events = [
                {"type": "response.created", "response": {"id": "fixture-response"}},
                {"type": "response.output_item.done", "output_index": 0,
                 "item": {"type": "message", "id": "fixture-message", "role": "assistant",
                          "content": [{"type": "output_text", "text": '{"title":"Fixture"}' if title_request else "Fixture complete."}]}},
                {"type": "response.completed", "response": {"id": "fixture-response",
                 "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}},
            ]
            for event in events:
                self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
            self.wfile.flush()

    provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="aico-codex-admin-") as directory:
            root = Path(directory)
            codex_state = root / "codex"
            codex_state.mkdir()
            work = root / "work"
            work.mkdir()
            config = f'''model = "fixture"
model_provider = "fixture"
check_for_update_on_startup = false
approval_policy = "never"
sandbox_mode = "read-only"
[model_providers.fixture]
name = "Fixture"
base_url = "http://127.0.0.1:{provider.server_port}/v1"
wire_api = "responses"
requires_openai_auth = false
[projects.{json.dumps(str(work))}]
trust_level = "trusted"
'''
            (codex_state / "config.toml").write_text(config)
            tmux_socket = str(root / "tmux.sock")

            def tmux(*command):
                return subprocess.run(["tmux", "-S", tmux_socket, *command],
                                      capture_output=True, check=True, timeout=3).stdout.decode()

            def submit(text, human_input=False, leading_escape=False):
                # Exercise the owning production framing helper, not a fixture copy.
                module = (Path(__file__).resolve().parents[1] / "electron/main/tmux.ts").as_uri()
                source = (f"import {{bracketedSubmitTextTargetArgs}} from {json.dumps(module)};"
                          "process.stdout.write(JSON.stringify(bracketedSubmitTextTargetArgs("
                          "{socket:process.argv[1],session:process.argv[2]},process.argv[3])))")
                argv = json.loads(subprocess.run(["node", "--experimental-strip-types", "--input-type=module", "-e", source,
                                                  tmux_socket, "%0", text], check=True, capture_output=True).stdout)
                if leading_escape:
                    argv[2:2] = ["send-keys", "-t", "%0", "Escape", ";"]
                if human_input:
                    argv[-4:-4] = ["send-keys", "-t", "%0", "-l", "\x1b[200~H\x1b[201~", ";"]
                subprocess.run(["tmux", *argv], capture_output=True, check=True, timeout=3)

            environment = {key: os.environ[key] for key in ("PATH", "USER", "LANG") if key in os.environ}
            environment.update(CODEX_HOME=str(codex_state), TERM="xterm-256color")
            launch = [args.codex, "--no-daemon", "--no-alt-screen", "-C", str(work)]
            command = shlex.join(["env", "-i", *[f"{key}={value}" for key, value in environment.items()], *launch])
            tmux("-f", "/dev/null", "new-session", "-d", "-s", "fixture", "-x", "120", "-y", "40", command,
                 ";", "set-window-option", "-t", "fixture", "remain-on-exit", "on")
            try:
                def screen():
                    return tmux("capture-pane", "-p", "-t", "fixture")

                wait_for(lambda: "Ask Codex" in screen(), "installed TUI did not reach composer")
                # The startup placeholder can render before input framing is enabled.
                time.sleep(0.3)
                version = subprocess.run([args.codex, "--version"], check=True, capture_output=True).stdout.decode().strip()
                print(json.dumps({"version": version, "fixture": "network_namespace_private_tmux", "ready": True}), flush=True)
                if args.leading_escape:
                    submit("Synthetic framing probe.", leading_escape=True)
                    wait_for(lambda: "[200~Synthetic framing probe." in screen(),
                             "leading Escape did not reproduce literal paste framing", timeout=2)
                    assert not receipts, "malformed framing unexpectedly delivered a message"
                    print(json.dumps({"qualified": False, "reason": "leading_escape_consumed_paste_opener",
                                      "literal_frame": True, "provider_calls": 0}), flush=True)
                    return
                payload = "Synthetic fixture submission with punctuation ; $() and Unicode café.\nSecond line\twith tabs."
                expected = hashlib.sha256(payload.encode()).hexdigest()
                if args.human_draft:
                    tmux("send-keys", "-t", "fixture", "-l", "Synthetic human draft. ")
                    time.sleep(0.2)
                if args.raw:
                    tmux("send-keys", "-t", "fixture", "-l", payload, ";", "send-keys", "-t", "fixture", "Enter")
                else:
                    submit(payload, args.human_input)
                wait_for(lambda: receipts, "text + immediate Enter was not accepted", timeout=2)
                if args.human_draft:
                    assert receipts == [hashlib.sha256(("Synthetic human draft. " + payload).encode()).hexdigest()], \
                        "unexpected existing-draft behavior"
                    raise AssertionError("existing human draft merged into accepted text")
                if args.human_input:
                    assert receipts == [hashlib.sha256((payload + "H").encode()).hexdigest()], \
                        "unexpected interleaved-input behavior"
                    raise AssertionError("human paste between framing and Enter merged into accepted text")
                assert receipts == [expected], "accepted content differs or duplicate delivery"
                print(json.dumps({"submission": "raw" if args.raw else "bracketed", "accepted": 1, "exact_text": True}), flush=True)
                wait_for(lambda: "Fixture complete." in (value := screen()) and "esc to interrupt" not in value,
                         "fixture turn did not complete")

                def threads():
                    databases = list(codex_state.glob("state_*.sqlite"))
                    if not databases:
                        return []
                    with sqlite3.connect(f"file:{databases[0]}?mode=ro", uri=True) as database:
                        return database.execute("SELECT id, sandbox_policy, approval_mode FROM threads ORDER BY created_at, id").fetchall()

                previous = wait_for(threads, "no native thread metadata")
                assert len(previous) == 1
                identity = tmux("display-message", "-p", "-t", "%0", "#{pid}:#{pane_id}:#{pane_pid}")
                submit("/clear")
                wait_for(lambda: "Fixture complete." not in (value := screen()) and "Ask Codex" in value,
                         "/clear did not reset the installed TUI")
                assert receipts == [expected], json.dumps({"clear_provider_calls": len(receipts),
                    "initial_matches": receipts.count(expected),
                    "literal_clear_matches": receipts.count(hashlib.sha256(b"/clear").hexdigest()),
                    "shapes": request_shapes})
                before_turn = len(threads())
                assert tmux("display-message", "-p", "-t", "%0", "#{pid}:#{pane_id}:#{pane_pid}") == identity
                submit("/status")
                current_status = wait_for(lambda: re.search(r"Session:\s+([0-9a-f-]{36})", screen()),
                                          "native /status did not identify the fresh thread")
                assert current_status[1] != previous[0][0], "/clear kept the old active native thread"
                # Native thread metadata is persisted lazily, after its first user turn.
                submit("Synthetic post-clear receipt.")
                wait_for(lambda: len(receipts) == 2, "post-clear text was not accepted")
                current = wait_for(lambda: rows if len(rows := threads()) == 2 else None,
                                   "/clear did not create a fresh native thread")
                old = previous[0]
                new = next(row for row in current if row[0] != old[0])
                assert new[0] == current_status[1], "persisted and active thread receipts differ"
                assert old[1:] == new[1:], "effective permissions changed after /clear"
                print(json.dumps({"clear": "fresh_thread", "old_thread": old[0], "new_thread": new[0],
                                  "new_thread_persisted_before_first_turn": before_turn == 2,
                                  "active_thread_receipt": "native_status_before_first_turn",
                                  "tmux_identity_preserved": True,
                                  "permissions_preserved": True, "sandbox_policy": json.loads(new[1]),
                                  "approval_policy": new[2], "provider_calls": len(receipts)}), flush=True)
            finally:
                subprocess.run(["tmux", "-S", tmux_socket, "kill-server"], capture_output=True, timeout=3)
    finally:
        provider.shutdown()
        provider.server_close()


if __name__ == "__main__":
    try:
        main()
    except AssertionError as error:
        print(json.dumps({"qualified": False, "reason": str(error)}), flush=True)
        raise SystemExit(1) from None
