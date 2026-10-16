# Aico project guide

[Project overview](../README.md). This guide retains detailed setup, operating contracts, and verification notes. Run shell commands from the repository root unless a step changes directory.

## What it does

- **Floating terminal widgets** — one or more compact Electron windows, each running a tmux-backed terminal with a WebGL renderer (DOM fallback), configurable font, animated "eyes" that track your cursor, and a "thinking" halo while the agent is working.
- **Persistent sessions, owned by Tether** — every session lives in [Tether](https://github.com/elias-leslie/tether), the per-user session daemon; each widget is a view of one Tether session, keyed by its 8-hex session ID. Closing a widget only detaches its `tmux attach` client, so work reattaches across close/reopen/restart, and Aico restarts never touch sessions. Aico stores only window geometry and open state per session; titles (`displayTitle`, `Project — Task`) and the coordinator chip (`badge`) come from the Tether descriptor as they are.
- **Lifecycle diagnostics** — “Copy session diagnostics” copies Tether's report for the session: ownership, tmux target, command, scope, age, CPU time, memory, swap, process/task counts, and containment warnings.
- **Agent launcher menu** — start any tool Tether has enabled (Claude Code, Codex, Antigravity, Pi, a plain shell, …) from the same lantern menu, choosing the TUI and the workspace to launch it into; "Replace TUI" swaps the tool in the focused widget.
- **Command palette & pinned controls** — a searchable command palette (`Ctrl+Shift+P`) and a pinned, drag-reorderable titlebar cluster, both driven by one action registry. Rename widgets inline.
- **Native scrollback** — each widget is a tmux control-mode client, so the terminal itself holds the pane's history: wheel, drag-select and copy reach as far back as it goes. Plain `tmux attach` stays as a fallback (palette: "Switch to plain tmux attach", or `AICO_TERMINAL_TRANSPORT=attach`).
- **Workspace picker** — always includes a local Personal Workspace, plus the projects Tether serves (SummitFlow's catalog when installed, else Tether's local list).
- **Click-to-context capture** — the loopback sidecar accepts local browser/extension and desktop captures and inserts a compact reference into the focused widget's prompt (single, batch, or an image+OCR "package").
- **Every session, one list** — the tray and palette list every Tether session, whether started from Aico, A-Term, the `tether` CLI or a SummitFlow root, and open any of them as a widget.
- **Optional desktop capture hotkeys** — when local `st ui` capture tooling is available, GNOME shortcuts (or in-app grab actions) can package a focused window, a picked window, a drag-selected region, or text-only OCR into Aico.

## Requirements

Aico currently targets a **single-user Linux desktop**.

The AppImage bundles Electron and the Python sidecar; it does not require Node.js, Python, `uv`, or a virtualenv at runtime.

Required for both packaged and source installs:

- a running [Tether](https://github.com/elias-leslie/tether) daemon, API v1 or later (`tether --json version`). Tether's installer checks its own durable-session prerequisites: a systemd 254+ user manager, cgroup v2, per-pane tmux scopes and user lingering
- `tmux` (Aico runs `tmux attach` for each window)
- Electron runtime libraries (`libgtk-3-0`, `libnss3`, `libatk1.0-0`, `libatk-bridge2.0-0`, `libcups2`, `libgbm1`, `libasound2t64`, and related X11/desktop libraries on Debian/Ubuntu)

Source installs and release builds additionally need Node.js 22+, npm, Python 3.13+, `uv`, and native `node-pty` build tools such as `make` and `g++`.

Recommended for the full desktop experience:

- X11/Xorg. The app can run under Wayland, but global shortcuts and desktop capture are more limited there.
- Chrome/Chromium if you want to load the optional browser extension.
- Any terminal AI CLIs you want to launch (`claude`, `codex`, `agy`, `pi`). Aico does not provide accounts or API keys for those tools.

## Quickstart

### Released AppImages

The AppImages on the [Releases](https://github.com/elias-leslie/aico/releases) page (latest v0.1.1, June 2026) predate the move to Tether: they manage tmux sessions themselves and do not match this guide. The current code has no AppImage release yet, so install from source ([INSTALL.md](INSTALL.md)), or build an AppImage locally as described under [Standalone AppImage](#standalone-appimage-no-python-at-runtime). Tether, `tmux` and whichever terminal AI CLIs you launch remain runtime prerequisites either way.

### Build from source

```bash
git clone https://github.com/elias-leslie/aico.git
cd aico
scripts/aico-install.sh
scripts/aico-launch.sh
```

Install and start Tether first (`scripts/install.sh --start default` in its
checkout). The installer performs a source install in the current checkout:

- requires `tether --json version` to report API v1 or later; otherwise it prints the Tether install steps and exits
- `npm ci`
- `uv sync --frozen --python 3.13 --extra dev`
- installs a desktop launcher at `~/.local/share/applications/aico.desktop`
- renders `scripts/systemd/aico-shell.service` into `${XDG_CONFIG_HOME:-~/.config}/systemd/user/` (substituting the checkout path, as `st service rebuild aico` does) and runs `systemctl --user daemon-reload`; the unit is not enabled, and `scripts/aico-launch.sh` starts `aico-shell.service`
- optionally installs GNOME capture hotkeys when `gsettings` is available
- configures Electron's Linux `chrome-sandbox` helper (root-owned, setuid) when you opt in
- on kernels with `kernel.apparmor_restrict_unprivileged_userns=1`, installs an AppArmor profile for Electron's sandbox when you opt in

Privileged steps never reuse cached `sudo` credentials. The installer prints each command first and runs it only when you answer yes in an interactive shell or set `AICO_INSTALL_PRIVILEGED=1`; otherwise you run the printed commands yourself. Rerun the installer after moving the checkout so the unit and desktop entry point at the new path.

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

Tether, `tmux` and whichever terminal AI CLIs you launch (`claude`, `codex`, …)
remain runtime prerequisites. The browser-driven context capture works
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
# Environment=AICO_SELECTION_HOTKEY=CommandOrControl+Shift+F9
```

For a directly-run AppImage or `npm start`, export the variables in the launching shell.

Important variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AICO_SIDECAR_HOST` | `127.0.0.1` | FastAPI sidecar bind host. Keep loopback unless you know why remote access is safe. |
| `AICO_SIDECAR_PORT` | `8005` | Sidecar HTTP port for the health and selection APIs. |
| `AICO_STATE_DIR` | `~/.local/state/aico` | App and sidecar state: selection SQLite and `aico.db` (window views and settings; sessions live in Tether). The launcher pidfile, lock, and `launcher.log` always live in `${XDG_STATE_HOME:-~/.local/state}/aico` and do not follow this variable. |
| `AICO_SIDECAR_ALLOW_REMOTE` | unset | Set to `1` to allow a non-loopback `AICO_SIDECAR_HOST` and to accept any `Host` header. Applies only to a standalone sidecar (`python -m aico_sidecar`); Aico never passes it to the sidecar it starts, which stays loopback-only. The sidecar is unauthenticated, so leave this unset. |
| `AICO_EXTENSION_IDS` | `oejadbpdecaenbbihglcnchnkmlilmjf` | Comma-separated Chrome extension IDs the sidecar trusts as browser origins. The default is the stable ID derived from the `key` in `extension/manifest.json`; set this only for a fork or re-keyed extension. |
| `AICO_SELECTION_HOTKEY` | `CommandOrControl+Shift+Space` | Electron global shortcut for selection indication. |
| `TETHER_SOCKET` | unset | Tether control socket. Wins over `TETHER_INSTANCE`. |
| `TETHER_INSTANCE` | `default` | Tether instance; the socket is `$XDG_RUNTIME_DIR/tether/<instance>/control.sock`. |

Aico intentionally does not store third-party AI provider secrets. Authenticate each AI CLI with its own documented login/config flow.

### Agent launch admission

Admission (memory and PSI thresholds) moved to Tether with the rest of the
session lifecycle; configure it there. A deferred launch reaches Aico as a
create failure and is shown in the widget.

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
- `POST /selection` and `POST /selection/send` — local selection/capture bus used by the web helper and browser extension.
- `GET /selection/current`, `GET /selection/history` — read recent captures.
- `GET /selection/events` — Server-Sent Events stream of delivery events (the Wayland-safe path for routing captures into a widget).

The sidecar is loopback-only by default. It rejects every browser origin except the trusted extension IDs (`AICO_EXTENSION_IDS`), local pages included, for writes and cross-origin reads of captured selections, and rejects requests whose `Host` header is not `localhost` or a loopback IP such as `127.0.0.1` or `[::1]`, which blocks DNS-rebinding pages. `AICO_SIDECAR_ALLOW_REMOTE=1` lifts the bind and `Host` restrictions for a standalone sidecar; Aico does not pass it to the sidecar it starts.

## Optional browser extension

The `extension/` directory contains a development MV3 extension that can send selected text, links, images, or page context to the local sidecar.

1. Start Aico so the sidecar is listening on `127.0.0.1:8005`.
2. Open Chrome/Chromium `chrome://extensions`.
3. Enable **Developer mode**.
4. **Load unpacked** and select this repo's `extension/` directory.

See [`extension/README.md`](../extension/README.md) for details.

## Mobile access

Every session is a tmux session on a Tether-managed absolute socket, so any
tmux-capable client on the same machine can attach: `tether sessions attach <id>`
(or `--print` for the exact argv). [A-term](../../a-term) is another Tether
client with an authenticated WebSocket, so opening the A-term PWA on a phone
gives live, two-way access to the same sessions Aico shows.

What you get on mobile is the terminal itself; Aico's desktop chrome (eyes, lantern menu, capture gestures) stays on the desktop.

## Architecture

```text
Tether (separate daemon; owns sessions)
  ├─ tmux servers, panes, agent launch, admission, End, roots, context hooks
  ├─ API v1 on $XDG_RUNTIME_DIR/tether/<instance>/control.sock
  └─ legacy /run/user/<uid>/aico/{control,gui-control}.sock for `st aico` and SummitFlow

Electron main process (a Tether client)
  ├─ owns widget windows, global shortcuts, tray, and sidecar lifecycle
  ├─ mirrors Tether's session list and follows /v1/events (reconnects, resyncs on gaps)
  ├─ holds the GUI channel (/v1/gui/channel) and applies show/position/title/coordinator
  ├─ runs Tether's exact `tmux attach` argv in a PTY per window and claims resize on focus
  ├─ stores views (geometry, open state) and settings in aico.db
  ├─ writes ids-only `[aico:event]` journal lines (push results, retired sessions)
  └─ starts Python sidecar and health-checks it

Electron renderer
  ├─ xterm.js terminal UI
  └─ lantern action menu and workspace picker

Python sidecar
  ├─ FastAPI loopback service
  └─ SQLite ring buffer for recent selection captures
```

Aico degrades when optional tools are missing: unavailable agent CLIs simply fail in their pane, and missing `st` capture tooling leaves core widgets working. When Tether is unreachable, open windows keep their terminals and the tray says session control is unavailable; Aico reconnects on its own.

The `st aico` extension's client lives in Tether; `scripts/aico-root-watch.py` here is the entry SummitFlow runs and execs Tether's installed copy. See [root control](root-control.md). For the process-containment design and recovery, see Tether's `docs/LIFECYCLE_HARNESS.md` and [the July 2026 incident report](INCIDENT-2026-07-PROCESS-ESCAPES.md). The cutover from the old in-process owner is in [cutover-aico.md](cutover-aico.md); known Tether API gaps are in [tether-api-gaps.md](tether-api-gaps.md).

## Current limitations

- Linux desktop is the supported path. macOS and Windows packaging are not implemented.
- X11 is the best-supported session for global shortcuts and screen capture.
- The published `Aico-*.AppImage` releases (built in CI with a SHA256 checksum and a build-provenance attestation) predate Tether; `npm run dist` builds one from current code. `.deb` packaging is not implemented yet.
- The browser extension is loaded unpacked for development; it is not published in a browser store.

## License

Aico is licensed under the [Apache License 2.0](../LICENSE). See [NOTICE](../NOTICE) for copyright notice and [assets/fonts/README.md](../assets/fonts/README.md) for vendored font license notes.
