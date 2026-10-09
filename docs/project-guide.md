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
- renders `scripts/systemd/aico-shell.service` and `aico-owner.service` into `${XDG_CONFIG_HOME:-~/.config}/systemd/user/` (substituting the checkout path, as `st service rebuild aico` does) and runs `systemctl --user daemon-reload`; the units are not enabled, and `scripts/aico-launch.sh` starts `aico-shell.service`
- optionally installs GNOME capture hotkeys when `gsettings` is available
- configures Electron's Linux `chrome-sandbox` helper (root-owned, setuid) when you opt in
- on kernels with `kernel.apparmor_restrict_unprivileged_userns=1`, installs an AppArmor profile for Electron's sandbox when you opt in

Privileged steps never reuse cached `sudo` credentials. The installer prints each command first and runs it only when you answer yes in an interactive shell or set `AICO_INSTALL_PRIVILEGED=1`; otherwise you run the printed commands yourself. Rerun the installer after moving the checkout so the units and desktop entry point at the new path.

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

Aico reads configuration from process environment variables only. Nothing
loads a `.env` file: `.env.example` is a reference list of the variables and
their defaults, not a file the app reads.

The desktop runtime runs as the `aico-shell.service` user unit, so it sees the
systemd user manager's environment, not your interactive shell's
(`scripts/aico-launch.sh` imports only display variables). Set overrides with a
drop-in, then restart Aico:

```bash
systemctl --user edit aico-shell.service
# [Service]
# Environment=AICO_VOICE_WS=ws://127.0.0.1:9000/ws
```

Give `aico-owner.service` the same `AICO_STATE_DIR` if you change it. For a
directly-run AppImage or `npm start`, export the variables in the launching shell.

Important variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AICO_SIDECAR_HOST` | `127.0.0.1` | FastAPI sidecar bind host. Keep loopback unless you know why remote access is safe. |
| `AICO_SIDECAR_PORT` | `8005` | Sidecar HTTP port for health, selection, and widget event APIs. |
| `AICO_STATE_DIR` | `~/.local/state/aico` | App and sidecar state: selection SQLite, widget event JSONL, and widget/session state. The launcher pidfile, lock, and `launcher.log` always live in `${XDG_STATE_HOME:-~/.local/state}/aico` and do not follow this variable. |
| `AICO_VOICE_WS` | `ws://127.0.0.1:8003/api/voice/ws?user_id=aico&app=aico` | Speech-to-text websocket for push-to-talk dictation. Unset uses this local default; there is no off switch. If nothing answers at the URL, only dictation fails and the rest of the app keeps working. |
| `AICO_SIDECAR_ALLOW_REMOTE` | unset | Set to `1` to allow a non-loopback `AICO_SIDECAR_HOST` and to accept any `Host` header. Applies only to a standalone sidecar (`python -m aico_sidecar`); Aico never passes it to the sidecar it starts, which stays loopback-only. The sidecar is unauthenticated, so leave this unset. |
| `AICO_EXTENSION_IDS` | `oejadbpdecaenbbihglcnchnkmlilmjf` | Comma-separated Chrome extension IDs the sidecar trusts as browser origins. The default is the stable ID derived from the `key` in `extension/manifest.json`; set this only for a fork or re-keyed extension. |
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

The sidecar is loopback-only by default. It rejects browser origins other than local pages and the trusted extension IDs (`AICO_EXTENSION_IDS`), and rejects requests whose `Host` header is not `localhost` or a loopback IP such as `127.0.0.1` or `[::1]`, which blocks DNS-rebinding pages. `AICO_SIDECAR_ALLOW_REMOTE=1` lifts the bind and `Host` restrictions for a standalone sidecar; Aico does not pass it to the sidecar it starts.

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
