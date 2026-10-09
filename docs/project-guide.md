# Aico project guide

[Project overview](../README.md). This guide retains detailed setup, operating contracts, and verification notes. Run shell commands from the repository root unless a step changes directory.

## What it does

- **Floating terminal widgets** — one or more compact Electron windows, each running a tmux-backed terminal with a WebGL renderer (DOM fallback), configurable font, animated "eyes" that track your cursor, and a "thinking" halo while the agent is working.
- **Persistent, owned sessions** — each widget owns stable server-generation, session, and pane IDs. Closing a widget only detaches, so work reattaches across close/reopen/restart; Aico never retires durable work merely because it is old or unattached. New panes carry widget/project/agent ownership metadata and run in a narrow per-pane scope. Historical sessions remain on the canonical `aico` socket and are preserved read-only from lifecycle mutation.
- **Lifecycle diagnostics** — “Copy session diagnostics” reports the owning widget/project/session, tmux target, command, scope, age, CPU time, memory, swap, process/task counts, and containment warnings without broad process-name scans.
- **Agent launcher menu** — start Claude Code, Codex, Gemini CLI, Pi, or a plain shell from the same lantern menu, choosing the TUI and the workspace to launch it into; "Replace TUI" swaps the tool in the focused widget.
- **Command palette & pinned controls** — a searchable command palette (`Ctrl+Shift+P`) and a pinned, drag-reorderable titlebar cluster, both driven by one action registry. Rename widgets inline.
- **Context-mandate verification** — before launch, Aico checks that each agent family (Claude, Codex, Gemini, Hermes) is wired to its configured system-prompt/hooks and surfaces a green ✓ / red ⚠ badge. It verifies only — it never installs hooks for you.
- **Read-only scrollback overlay** — wheel up to browse tmux history (paged from the session) without disturbing the live view.
- **Workspace picker** — always includes a local Personal Workspace; optionally reads an `st projects` catalog when that tool is installed.
- **Click-to-context capture** — the loopback sidecar accepts local browser/extension and desktop captures and inserts a compact reference into the focused widget's prompt (single, batch, or an image+OCR "package").
- **Attach external tmux sessions** — detects A-Term/SummitFlow tmux sessions and offers to attach them as widgets from the tray or palette.
- **Optional desktop capture hotkeys** — when local `st ui` capture tooling is available, GNOME shortcuts (or in-app grab actions) can package a focused window, a picked window, a drag-selected region, or text-only OCR into Aico.
- **Optional voice dictation** — when `AICO_VOICE_WS` points at a compatible local Whisper websocket, push-to-talk streams microphone audio and inserts the transcript.

## Requirements

Aico currently targets a **single-user Linux desktop**.

The AppImage bundles Electron and the Python sidecar; it does not require Node.js, Python, `uv`, or a virtualenv at runtime.

Required for both packaged and source installs:

- `tmux`
- a systemd 254+ user manager with cgroup v2 and a tmux build that assigns each pane
  a `tmux-spawn-<uuid>.scope`
- user lingering (`loginctl show-user "$UID" -p Linger`) so the durable tmux
  service and pane scopes survive a normal graphical logout; the source
  installer enables and verifies it
- Electron runtime libraries (`libgtk-3-0`, `libnss3`, `libatk1.0-0`, `libatk-bridge2.0-0`, `libcups2`, `libgbm1`, `libasound2t64`, and related X11/desktop libraries on Debian/Ubuntu)

Source installs and release builds additionally need Node.js 22+, npm, Python 3.13+, `uv`, and native `node-pty` build tools such as `make` and `g++`.

Recommended for the full desktop experience:

- X11/Xorg. The app can run under Wayland, but global shortcuts and desktop capture are more limited there.
- Chrome/Chromium if you want to load the optional browser extension.
- Any terminal AI CLIs you want to launch (`claude`, `codex`, `agy`, `pi`). Aico does not provide accounts or API keys for those tools.

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

- `npm ci`
- `uv sync --frozen --python 3.13 --extra dev`
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
uv sync --frozen --python 3.13 --extra dev --extra release
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
| `AICO_AGENT_MIN_AVAILABLE_GIB` | `6` | Defer a new agent launch while `/proc/meminfo` MemAvailable is below this many GiB. |
| `AICO_AGENT_MAX_PSI_SOME_AVG60` | `10` | Defer while memory PSI `some avg60` is at or above this percentage. |
| `AICO_AGENT_MAX_PSI_FULL_AVG60` | `2` | Defer while memory PSI `full avg60` is at or above this percentage. |
| `AICO_AGENT_MAX_PSI_FULL_AVG10` | `5` | Defer while memory PSI `full avg10` is at or above this percentage. |
| `AICO_AGENT_MAX_ACTIVE` | unset | Optional emergency ceiling on concurrently active agent panes. Unset means no ceiling. |
| `AICO_AGENT_ADMISSION_OVERRIDE` | unset | Set to `1` to bypass admission only. Ownership and scope validation still apply. |

Aico intentionally does not store third-party AI provider secrets. Authenticate each AI CLI with its own documented login/config flow.

### Agent launch admission

Aico checks host memory before it allocates a new agent pane, dispatches a
recovered launch gate, or replaces a running agent. It defers the launch, and
shows the reason in the widget, only while MemAvailable or memory PSI crosses
the thresholds above. Admission never limits healthy concurrency by default,
never kills existing work, and is skipped for bare shells and reconnects to a
live session. A replacement is never counted against itself. Malformed or
unreadable host data defers the launch with a retryable reason. Each decision
logs one `[aico:admission]` JSON line with MemAvailable, PSI, the active agent
count and the outcome, for tuning; it never contains prompt or session content.

New durable sessions fail closed if user linger or narrow tmux pane containment
cannot be verified. Existing sessions are preserved. To enable linger manually:

```bash
sudo loginctl enable-linger "$USER"
```

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

See [`extension/README.md`](../extension/README.md) for details.

## Mobile access

Every Aico widget is a plain `aico-<id>` tmux session on a catalogued absolute socket, so any tmux-capable client on the same machine can attach — no Aico-side server, auth, or port exposure is needed. [A-term](../../a-term) reads Aico's server catalog in SQLite read-only mode, preserves the historical `aico` source, and exposes managed generations with generation-qualified identities over its authenticated WebSocket. Opening the A-term PWA on a phone therefore gives live, two-way access to both historical and newly managed widgets.

What you get on mobile is the terminal itself; Aico's desktop chrome (eyes, lantern menu, capture gestures) stays on the desktop. Without A-term, copy **Session diagnostics** and use its exact `tmux.socket` and stable session target with `tmux -S <absolute-socket> attach -t <session>`. Historical lifecycle-v0 sessions still use `/tmp/tmux-$(id -u)/aico`. The absolute path is deliberate: it cannot be redirected by an inherited `TMUX_TMPDIR`.

## Architecture

```text
Electron main process
  ├─ owns widget windows, global shortcuts, tray, tmux lifecycle, and sidecar lifecycle
  ├─ adopts `/tmp/tmux-<uid>/aico` read-only and provisions managed generations on private absolute sockets
  ├─ asks the user manager to spawn each tmux server in a clean-FD durable service; each pane gets its own scope
  ├─ watches generation-specific `pane-exited` events so detached failures reconcile while Aico stays open
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

For the process-containment design, regression harness, and targeted recovery
procedure, see [the July 2026 incident report](../docs/INCIDENT-2026-07-PROCESS-ESCAPES.md)
and [lifecycle harness guide](../docs/LIFECYCLE_HARNESS.md).

## Current limitations

- Linux desktop is the supported path. macOS and Windows packaging are not implemented.
- X11 is the best-supported session for global shortcuts and screen capture.
- Pre-built `Aico-*.AppImage` downloads are available on the [Releases](https://github.com/elias-leslie/aico/releases/latest) page (built in CI with a SHA256 checksum and a build-provenance attestation); `npm run dist` reproduces one locally. `.deb` packaging is not implemented yet.
- Voice dictation requires a separately running compatible speech-to-text websocket.
- The browser extension is loaded unpacked for development; it is not published in a browser store.

## License

Aico is licensed under the [Apache License 2.0](../LICENSE). See [NOTICE](../NOTICE) for copyright notice and [assets/fonts/README.md](../assets/fonts/README.md) for vendored font license notes.
