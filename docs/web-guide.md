# Web app guide

The web app is Aico in a browser or on a phone: the same Tether sessions as the desktop, one session on screen at a time. [Project overview](../README.md). Run shell commands from the repository root unless a step changes directory.

## Quickstart

```bash
git clone https://github.com/elias-leslie/aico.git
cd aico
scripts/install.sh --start
```

Then open **http://localhost:3002**.

The web app targets **Linux with systemd** and needs **Tether**, the session daemon that owns every session (API version 1 or newer, `tether@default.service`). One Node process, `aico-web.service`, serves the page, its API (`/api`), the terminal sockets (`/ws`) and `/health` on port 3002. `scripts/install.sh` builds the front end and the server and installs Tether and the user units; `--start` starts Tether and `aico-web`. There is no database server to install. See [install](INSTALL.md).

Projects come from Tether: by default its local list (`~/.config/tether/projects.json`).

See the [Changelog](../CHANGELOG.md) for shipped changes.

## Features

**`persistent sessions`** — Sessions live in Tether, not in the web app, so they survive browser closes, web app restarts, and network drops. Reconnect exactly where you left off. The same sessions show up in the desktop app, and sessions started there show up here.

**`stable scrollback rendering`** — Terminal panes render with the xterm.js WebGL renderer with DOM fallback, so history keeps font metrics, wrap points, and columns aligned.

**`one session at a time`** — The session bar's title opens every running session in the order they started, with any that need you on top (each row says whether it is working, idle or finished); pick one to switch. Ctrl+Tab and Ctrl+Shift+Tab step through them and Ctrl+1 to Ctrl+9 jump to one (not while you are typing in a text box). New session starts an agent or a shell in a project you pick. In a wide desktop window the list sits beside the session; its Hide session list button tucks it away and the session bar's Show session list brings it back (remembered on that device). The session menu's Redraw remounts the view without restarting the session. Several devices can show one session; the one you use last claims the session's window size.

**`check-ins`** — The session menu's Check in later has an agent session (Claude Code, Codex or Pi) report back at a time you pick: In 1 hour, Tonight, Tomorrow morning or your own. The session list shows a Check-in chip with the next time; the menu lists each pending one with Cancel. Closing the page changes nothing, and Tether wakes the session when it is idle and its input line is empty. End session cancels its check-ins; End, keep check-in resumes the conversation in a new session at the time, and a Kept check-ins list at the bottom of the session list cancels those.

**`files browser`** — Browse the session's working directory. Preview files, copy paths, insert paths into prompts — without leaving the terminal.

**`files and shares`** — The session bar's Files opens Shared and Project. Shared lists what agents handed you with `tether share`, newest first: each file opens in a preview (text and images) and each folder opens to browse, read where they are, never copied. Project browses the session's folder. A file path in the terminal (absolute or starting with `~/`) is a link: click it to open that file or folder in Files. A notice pops up for each new share; its Open goes to the share in Shared.

**`prompt cleaning`** — With Agent Hub connected, the web app can clean a draft prompt, show an original-vs-cleaned diff, take follow-up refinement instructions, let you edit the result before sending, and fall back to the original prompt if the cleaner is unavailable.

**`voice input`** — Dictate commands and prompts via browser speech-to-text when your browser and microphone permissions support it. It merges cumulative browser speech chunks so dictated phrases do not repeat as interim text becomes final.

On a phone, tap Talk to start dictating. Words appear while you speak, and pauses in speech keep it listening. Tap the same button to pause, then review or edit the transcript. Resume continues the same draft; Send submits it to the terminal. The Talk button only controls listening. Browser permission, microphone, or network failures still stop recording and show an error.

**`project deep links`** — Open `/?project=myapp&dir=/path` to jump straight into a project workspace. Bookmark your setups.

**`dual mode`** — Switch any session between raw shell and your configured AI agent with one click. Supports Claude Code, Codex, Antigravity CLI, and Pi out of the box.

**`agent tools`** — New session offers the enabled tools in Tether's shared registry: Claude Code, Codex, Antigravity CLI and Pi by default, plus any you add there. Antigravity launches as `agy --dangerously-skip-permissions`, its explicit auto-approval mode. Claude Code's slug is `claude-code` (`claude` still works as an alias).

**`scrollback`** — Each session is attached in tmux control mode, which seeds its history into xterm.js. Scroll up and the view holds still while output keeps arriving; a Latest button returns you to the bottom.

**`mobile workspace controls`** — On a phone you type with the phone's own keyboard into a compose box that stays above a key row (Tab, Shift, voice, Esc, Ctrl, arrow keys). The first key shows or hides the phone keyboard. The visible bottom row stays in view as the keyboard opens, and a touch-friendly session switcher jumps into any session.

**`compose box`** — In a desktop browser the compose box is hidden until you press Compose in the session bar; this browser then remembers whether it is open. Write a message there and send it to the session in one go.

Expand the arrow controls to find Enter, which activates a TUI selection without typing a draft. Terminal keys keep the phone keyboard and arrow controls open. With a draft focused, Left and Right move its caret; Up and Down navigate the terminal. Send submits the draft, while the toolbox's Enter sends only the Enter key and leaves the draft intact.

**`text size`** — Settings change the terminal text size, remembered per project in this browser.

**`in-terminal search`** — Search the live buffer and scrollback for a string and step through matches, without leaving the session.

**`clickable links and clipboard`** — URLs in terminal output are clickable (web-links addon) and copy/paste flows use the xterm clipboard addon, including bracketed-paste support.

**`file upload`** — Drag and drop images and docs (PNG/JPG/GIF/WebP/Markdown/text/JSON/PDF, up to 10 MB) into a session; the web app validates the file by magic bytes and returns a `~`-relative path you can drop straight into a command.

**`install as a PWA`** — The web app ships a manifest, so you can install it to your phone or desktop and run it standalone.

**`locked down by default`** — The server listens on loopback only and answers only `localhost`, `127.0.0.1` and the configured public host. Writes and terminal sockets must come from a trusted origin, uploads are rate limited, and pages carry a CSP that allows only the export's own scripts (by hash). There is no login of its own: put an identity-aware gateway such as Cloudflare Access in front of any public host.

**`self-maintaining`** — A background loop drops tab links to sessions that ended, prunes long-empty tabs, cleans up old uploads, and prunes settings for projects that no longer exist; it also follows Tether's event stream so an ended session leaves its tab promptly. `/health` reports the server and Tether.

## Advanced Setup

For install smoke or CI validation on Linux hosts without a user systemd session, run `scripts/install.sh --skip-systemd`.

For any deployment beyond localhost, put an identity-aware gateway in front first (the web app has no login of its own); see [remote access](remote-access.md).

<details>
<summary><strong>Environment variables</strong></summary>

Copy what you need from `web/.env.example` to `~/.config/credstore/a-term/env` (mode 0600, outside the repo); `aico-web.service` reads it when present. Everything is optional:

```bash
# Tether control socket (default: $XDG_RUNTIME_DIR/tether/default/control.sock)
TETHER_SOCKET=/run/user/1000/tether/default/control.sock

# Where the web app keeps its tabs and project settings (default: ~/.local/state/aico/web.db)
AICO_WEB_DB=/home/you/.local/state/aico/web.db

# Listener (loopback only; the port defaults to runtime.backend_port, 3002)
AICO_WEB_PORT=3002

# Uploads and maintenance
MAX_FILE_SIZE_MB=10
MAINTENANCE_INTERVAL_SECONDS=900
MAINTENANCE_SESSION_PURGE_DAYS=7

# Optional Agent Hub (the web app works without it)
AGENT_HUB_URL=http://localhost:8003
```


</details>

<details>
<summary><strong>Terminal launchers</strong></summary>

`web/scripts/tclaude`, `tcodex` and `tsession` (Node, sharing the server's code and `web.db`) open a project's agent session from a terminal: they reuse the most recently used Tether session for that project and tool, or create one (it also appears in the web app and the desktop), then attach with `tether sessions attach`. Run outside tmux, it attaches directly. Inside a tmux client on the same Tether server it switches the client. Inside a different tmux server (for example your default one), tmux cannot switch across servers, so it attaches nested after printing a notice; detach the inner client with its prefix key then `d`. `tsession open --tool codex --project myapp --attach --print` prints Tether's attach target instead. The `tether` CLI must be on `PATH` (or set `TETHER_BIN`).

</details>

<details>
<summary><strong>Daily commands</strong></summary>

```bash
systemctl --user restart aico-web.service
systemctl --user status aico-web.service
journalctl --user -u aico-web.service -f
```

</details>

## Remote Access

The web app answers on `localhost`, plus one public hostname through a Cloudflare tunnel. LAN, Tailscale and other reverse-proxy setups are refused by the Host guard. See the [Remote Access guide](remote-access.md). Put Cloudflare Access in front of the public host.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Server | Node.js 22+ (`node:http`, `ws`, `node:sqlite`), one esbuild bundle |
| Frontend | Next.js 16 static export, React 19, TypeScript, Tailwind CSS 4 |
| Terminal | xterm.js 6 with WebGL renderer (DOM fallback), tmux client attached to Tether's sessions |
| Sessions | Tether (local daemon, Unix-socket HTTP API v1) |
| View state | SQLite (`~/.local/state/aico/web.db`) |
| Quality | Vitest, Biome, tsc |

<details>
<summary><strong>Architecture</strong></summary>

- `server/src/` — the Node server: `api.ts` (REST), `terminal.ts` (terminal WebSocket), `static.ts` (the page), `background.ts` (Tether events, maintenance), `db.ts` (tabs and project settings), `cli.ts` (`tsession`)
- `frontend/app/`, `frontend/components/`, `frontend/lib/` — the Next.js UI, built as a static export into `frontend/out/`
- `web/scripts/` — launchers and verification; the installer and units are in the root `scripts/`

</details>

<details>
<summary><strong>Optional companion integrations</strong></summary>

All core features work without any external service.

**SummitFlow project catalog** — Tether reads SummitFlow's projects when SummitFlow is installed, and the web app shows those. Without SummitFlow, Tether uses its local list.

**Agent Hub** (`AGENT_HUB_URL`) — Adds model catalog and prompt cleaning/refinement proxies. Browser-native voice input works standalone; Agent Hub provides an optional enhanced path.

</details>

## License

Apache License 2.0 — see [LICENSE](../LICENSE) and [NOTICE](../NOTICE).
