# Aico

**Floating desktop widgets for terminal AI agents, shells, and click-to-context capture.**

Aico is a Linux desktop companion for people who work with terminal AI tools. It wraps Claude Code, Codex CLI, opencode, Gemini CLI, Pi, Hermes, and plain shells in small Electron widgets backed by persistent tmux sessions. Widgets can be reopened, moved between workspaces, fed selected browser/page/screen context, and left running while you work elsewhere.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/elias-leslie/aico/actions/workflows/ci.yml/badge.svg)](https://github.com/elias-leslie/aico/actions/workflows/ci.yml)
[![Linux](https://img.shields.io/badge/platform-Linux-2ea043.svg)](#requirements)
[![Electron](https://img.shields.io/badge/Electron-42-47848f.svg)](https://www.electronjs.org/)
[![xterm.js](https://img.shields.io/badge/xterm.js-6-green.svg)](https://xtermjs.org/)

![Aico — summon the command palette in a floating desktop lantern and launch a Claude Code agent into any workspace on Linux](docs/images/aico-demo.gif)

## What it does

- **Floating terminal widgets** — one or more compact Electron windows, each running a tmux-backed terminal with a WebGL renderer (DOM fallback), configurable font, animated "eyes" that track your cursor, and a "thinking" halo while the agent is working.
- **Persistent sessions** — each widget owns a named tmux session on a dedicated `aico` socket; closing a widget detaches (does not kill) so the same session reattaches across close/reopen/restart. Idle sessions are reaped after a TTL and orphaned sessions are re-adopted on launch.
- **Agent launcher menu** — start Claude Code, Codex, opencode, Gemini CLI, Pi, Hermes, or a plain shell from the same lantern menu, choosing the TUI and the workspace to launch it into; "Replace TUI" swaps the tool in the focused widget.
- **Command palette & pinned controls** — a searchable command palette (`Ctrl+Shift+P`) and a pinned, drag-reorderable titlebar cluster, both driven by one action registry. Rename widgets inline.
- **Context-mandate verification** — before launch, Aico checks that each agent family (Claude, Codex, Gemini, Hermes) is wired to its configured system-prompt/hooks and surfaces a green ✓ / red ⚠ badge. It verifies only — it never installs hooks for you.
- **Read-only scrollback overlay** — wheel up to browse tmux history (paged from the session) without disturbing the live view.
- **Workspace picker** — always includes a local Personal Workspace; optionally reads an `st projects` catalog when that tool is installed.
- **Click-to-context capture** — the loopback sidecar accepts local browser/extension and desktop captures and inserts a compact reference into the focused widget's prompt (single, batch, or an image+OCR "package").
- **Attach external tmux sessions** — detects A-Term/SummitFlow tmux sessions and offers to attach them as widgets from the tray or palette.
- **Optional desktop capture hotkeys** — when local `st ui` capture tooling is available, GNOME shortcuts (or in-app grab actions) can package a focused window, a picked window, a drag-selected region, or text-only OCR into Aico.
- **Optional voice dictation** — when `AICO_VOICE_WS` points at a compatible local Whisper websocket, push-to-talk streams microphone audio and inserts the transcript.

## How it compares

Aico's distinctive move is **context, on demand**: right-click a page or selection
in your browser, or tag any desktop window, and it lands directly in your *running
terminal agent's* session. Everything else either records your whole screen and
makes you search it, routes capture into its own chat, or only runs on macOS.

| | Aico | Raycast "Send to AI" | Warp | Screenpipe |
|---|:---:|:---:|:---:|:---:|
| Tag a browser page/selection → into the agent | ✅ | — | — | history search |
| Tag any desktop window/region → into the agent | ✅ | macOS only | paste image yourself | always-on recording |
| Target is your own terminal CLI agent (Claude Code, Codex…) | ✅ | its own chat | built-in agent | MCP query |
| Persistent tmux-backed sessions | ✅ | — | — | — |
| Runs on Linux | ✅ | — | ✅ | ✅ |

Deliberate, on-demand tagging into a persistent terminal agent on Linux is the
combination no other tool ships.

## Requirements

Aico currently targets a **single-user Linux desktop**.

Required:

- Node.js 22+ and npm
- Python 3.13+
- [uv](https://docs.astral.sh/uv/) for the Python sidecar environment
- `tmux`
- common native build tools for `node-pty` (`python3`, `make`, `g++` on Debian/Ubuntu)
- Electron runtime libraries (`libgtk-3-0`, `libnss3`, `libatk1.0-0`, `libatk-bridge2.0-0`, `libcups2`, `libgbm1`, `libasound2t64`, and related X11/desktop libraries on Debian/Ubuntu)

Recommended for the full desktop experience:

- X11/Xorg. The app can run under Wayland, but global shortcuts and desktop capture are more limited there.
- Chrome/Chromium if you want to load the optional browser extension.
- Any terminal AI CLIs you want to launch (`claude`, `codex`, `opencode`, `gemini`, `pi`, `hermes`). Aico does not provide accounts or API keys for those tools.

## Quickstart

### Download and run

Download the latest self-contained `Aico-*.AppImage` from the
[Releases](https://github.com/elias-leslie/aico/releases/latest) page — it bundles
the FastAPI sidecar, so it needs no Python, `uv`, or `.venv` at runtime:

```bash
chmod +x Aico-*.AppImage
./Aico-*.AppImage
```

Each release also ships `SHA256SUMS.txt`; verify with `sha256sum -c SHA256SUMS.txt`.
`tmux` and whichever terminal AI CLIs you launch (`claude`, `codex`, …) remain
runtime prerequisites — Aico hosts them.

### Build from source

```bash
git clone https://github.com/elias-leslie/aico.git
cd aico
scripts/aico-install.sh
scripts/aico-launch.sh
```

The installer performs a source install in the current checkout:

- `npm install`
- `uv venv --python 3.13`
- `uv pip install -e '.[dev]'`
- installs a desktop launcher at `~/.local/share/applications/aico.desktop`
- optionally installs GNOME capture hotkeys when `gsettings` is available
- configures Electron's Linux `chrome-sandbox` helper when passwordless `sudo` is available, or prints the manual commands
- optionally loads an AppArmor profile for Electron's sandbox on Ubuntu 24.04+

Stop Aico with:

```bash
scripts/aico-stop.sh
```

For a one-off foreground run during development:

```bash
npm start
```

## Standalone AppImage (no Python at runtime)

The source install above runs the sidecar from a `uv` virtualenv. To produce a
**self-contained AppImage** that bundles the sidecar — so the packaged app needs
no Python, `uv`, or `.venv` at runtime — build a distributable from a dev checkout:

```bash
npm run dist
```

This bundles the FastAPI sidecar into a standalone executable (PyInstaller),
builds the Electron app, and emits `dist/electron/Aico-<version>.AppImage`. Run it
directly:

```bash
chmod +x dist/electron/Aico-*.AppImage
./dist/electron/Aico-*.AppImage
```

`tmux` and whichever terminal AI CLIs you launch (`claude`, `codex`, …) remain
runtime prerequisites — Aico hosts them. The browser-driven context capture works
through the bundled sidecar with no extra setup; the desktop window/region *grab*
gesture additionally uses the `st` capture CLI when it is installed.

## Configuration

Copy `.env.example` only if you want to override defaults:

```bash
cp .env.example .env
```

Important variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AICO_SIDECAR_HOST` | `127.0.0.1` | FastAPI sidecar bind host. Keep loopback unless you know why remote access is safe. |
| `AICO_SIDECAR_PORT` | `8005` | Sidecar HTTP port for health, selection, and widget event APIs. |
| `AICO_STATE_DIR` | `~/.local/state/aico` | Local logs, SQLite state, pidfile, and launcher logs. |
| `AICO_CONFIG_DIR` | `~/.config/aico` | Reserved for user config. |
| `AICO_VOICE_WS` | `ws://127.0.0.1:8003/api/voice/ws?user_id=aico&app=aico` | Optional compatible speech-to-text websocket. If absent/unreachable, voice dictation fails without crashing the app. |
| `AICO_SELECTION_HOTKEY` | `CommandOrControl+Shift+Space` | Electron global shortcut for selection indication. |
| `AICO_VOICE_HOTKEY` | `CommandOrControl+Shift+M` | Electron global shortcut for push-to-talk toggle. |

Aico intentionally does not store third-party AI provider secrets. Authenticate each AI CLI with its own documented login/config flow.

## Test, lint, typecheck, build

After `scripts/aico-install.sh`:

```bash
npm run lint
npm run typecheck
npm test
npm run test:sidecar
npm run build
```

Or run the combined public gate:

```bash
npm run check
```

## Sidecar API

The Python sidecar starts on `127.0.0.1:8005` by default.

```bash
.venv/bin/python -m aico_sidecar
curl http://127.0.0.1:8005/health
```

Main endpoints:

- `GET /health` — liveness check.
- `POST /widgets/{widget_id}/events` — append bounded JSONL widget events under the local state directory.
- `POST /selection` and `POST /selection/send` — local selection/capture bus used by the web helper and browser extension.
- `GET /selection/current`, `GET /selection/history` — read recent captures.
- `GET /selection/events` — Server-Sent Events stream of delivery events (the Wayland-safe path for routing captures into a widget).

The sidecar is loopback-only by default and rejects non-local browser origins.

## Optional browser extension

The `extension/` directory contains a development MV3 extension that can send selected text, links, images, or page context to the local sidecar.

1. Start Aico so the sidecar is listening on `127.0.0.1:8005`.
2. Open Chrome/Chromium `chrome://extensions`.
3. Enable **Developer mode**.
4. **Load unpacked** and select this repo's `extension/` directory.

See [`extension/README.md`](extension/README.md) for details.

## Architecture

```text
Electron main process
  ├─ owns widget windows, global shortcuts, tray, tmux lifecycle, and sidecar lifecycle
  ├─ attaches each widget to an isolated tmux server/socket
  └─ starts Python sidecar and health-checks it

Electron renderer
  ├─ xterm.js terminal UI
  ├─ lantern action menu and workspace picker
  └─ optional voice dictation client

Python sidecar
  ├─ FastAPI loopback service
  ├─ SQLite ring buffer for recent selection captures
  └─ per-widget JSONL event logs under local state
```

Aico degrades when optional tools are missing: unavailable agent CLIs simply fail in their pane, missing `st` project/capture tooling leaves Personal Workspace and core widgets working, and missing voice websocket disables dictation only.

## Current limitations

- Linux desktop is the supported path. macOS and Windows packaging are not implemented.
- X11 is the best-supported session for global shortcuts and screen capture.
- Pre-built `Aico-*.AppImage` downloads are available on the [Releases](https://github.com/elias-leslie/aico/releases/latest) page (built in CI with a SHA256 checksum and a build-provenance attestation); `npm run dist` reproduces one locally. `.deb` packaging is not implemented yet.
- Voice dictation requires a separately running compatible speech-to-text websocket.
- The browser extension is loaded unpacked for development; it is not published in a browser store.

## License

Aico is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for copyright notice and [assets/fonts/README.md](assets/fonts/README.md) for vendored font license notes.
