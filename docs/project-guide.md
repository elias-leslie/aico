# Aico project guide

[Project overview](../README.md). This guide retains detailed setup, operating contracts, and verification notes. Run shell commands from the repository root unless a step changes directory.

## What it does

- **Floating terminal widgets** — one or more compact Electron windows, each running a tmux-backed terminal with a WebGL renderer (DOM fallback), configurable font, animated "eyes" that track your cursor, and a "thinking" halo while the agent is working.
- **Persistent sessions, owned by Tether** — every session lives in [Tether](https://github.com/elias-leslie/tether), the per-user session daemon; each widget is a view of one Tether session, keyed by its 8-hex session ID. Closing a widget only detaches its tmux client, so work reattaches across close/reopen/restart, and Aico restarts never touch sessions. Aico stores only window geometry and open state per session; titles (`displayTitle`, `Project — Task`) and the coordinator chip (`badge`) come from the Tether descriptor as they are.
- **Lifecycle diagnostics** — “Copy session diagnostics” copies Tether's report for the session: ownership, tmux target, command, scope, age, CPU time, memory, swap, process/task counts, and containment warnings.
- **Agent launcher menu** — start any tool Tether has enabled (Claude Code, Codex, Antigravity, Pi, a plain shell, …) from the same lantern menu, choosing the TUI and the workspace to launch it into; "Restart with another tool" swaps the tool in the focused widget.
- **Command palette & pinned controls** — a searchable command palette (`Ctrl+Shift+P`) and a pinned, drag-reorderable titlebar cluster, both driven by one action registry. A pin whose feature is unavailable (a tool or project Tether did not list, games not loaded) is hidden, not deleted, and comes back with it. Rename widgets inline.
- **Native scrollback** — each widget is a tmux control-mode client, so the terminal itself holds the pane's history: wheel, drag-select and copy reach as far back as it goes.
- **Workspace picker** — always includes a local Personal Workspace, plus the projects Tether serves (SummitFlow's catalog when installed, else Tether's local list). Claude Code, Codex and Pi also offer **Blank Slate** at the top: a new empty workspace with no first-party context ([root-control.md](root-control.md#blank-slate)). Those tools also show **Instructions** at the top: pick an Agent Hub prompt, then one of its revisions (the one marked current holds its content now), and the next session you start from that picker gets it on top of its usual context, or alone in a Blank Slate ([root-control.md](root-control.md#chosen-instructions)).
- **Every session, one list** — the tray and **Open session** (in the lantern menu, the palette or as a pin) list every Tether session, whether started from the desktop, the web app, the `tether` CLI or a SummitFlow root, and open any of them as a widget.

## Requirements

Aico currently targets a **single-user Linux desktop**.

Required:

- a running [Tether](https://github.com/elias-leslie/tether) daemon, API v1 or later (`tether --json version`). Tether's installer checks its own durable-session prerequisites: a systemd 254+ user manager, cgroup v2, per-pane tmux scopes and user lingering
- `tmux` (each window is a tmux client of its session)
- Electron runtime libraries (`libgtk-3-0`, `libnss3`, `libatk1.0-0`, `libatk-bridge2.0-0`, `libcups2`, `libgbm1`, `libasound2t64`, and related X11/desktop libraries on Debian/Ubuntu)

Source installs additionally need Node.js 22+, npm and Python 3.

Recommended for the full desktop experience:

- A Wayland desktop (GNOME 50 on the reference host). Aico runs as a native Wayland client; window tiling, saved positions and focus need the desktop bridge extension, and without it windows open where the compositor puts them.
- Any terminal AI CLIs you want to launch (`claude`, `codex`, `agy`, `pi`). Aico does not provide accounts or API keys for those tools.

## Quickstart

Aico installs from source; there is no packaged build. The old AppImages on the [Releases](https://github.com/elias-leslie/aico/releases) page (v0.1.0 and v0.1.1, June 2026) predate the move to Tether: they manage tmux sessions themselves and do not match this guide.

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
- installs a desktop launcher at `~/.local/share/applications/aico.desktop`
- renders `scripts/systemd/aico-shell.service` into `${XDG_CONFIG_HOME:-~/.config}/systemd/user/` (substituting the checkout path, as `st service rebuild aico` does) and runs `systemctl --user daemon-reload`; the unit is not enabled, and `scripts/aico-launch.sh` starts `aico-shell.service`
- on kernels with `kernel.apparmor_restrict_unprivileged_userns=1`, installs an AppArmor profile for Electron's sandbox when you opt in
- only when user namespaces stay unavailable (restricted with no profile installed, or turned off), configures Electron's Linux `chrome-sandbox` helper (root-owned, setuid) when you opt in

Privileged steps never reuse cached `sudo` credentials. The installer prints each command first and runs it only when you answer yes in an interactive shell or set `AICO_INSTALL_PRIVILEGED=1`; otherwise you run the printed commands yourself. Rerun the installer after moving the checkout so the unit and desktop entry point at the new path.

Stop Aico with:

```bash
scripts/aico-stop.sh
```

For a one-off foreground run during development:

```bash
npm start
```

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
# Environment=AICO_PASTED_IMAGES_KEEP_HOURS=48
```

For `npm start`, export the variables in the launching shell.

Important variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AICO_STATE_DIR` | `~/.local/state/aico` | App state: `aico.db` (window views and settings; sessions live in Tether). The launcher pidfile, lock, and `launcher.log` always live in `${XDG_STATE_HOME:-~/.local/state}/aico` and do not follow this variable. |
| `AICO_PASTED_IMAGES_DIR` | `/srv/workspaces/handoffs/pasted-images` | Where Aico writes a pasted clipboard image (`paste-<time>-<random>.png`, mode `0640` in a `0750` folder) so a program running as another user, such as the agent's Tether instance, can read it. The pasted text is the file's path. Must be readable by that user. |
| `AICO_PASTED_IMAGES_KEEP_HOURS` | `24` | Pasted images older than this are deleted whenever a new one is written. |
| `AICO_OZONE_PLATFORM` | `wayland` | Electron display backend used by the managed foreground runner. Native Wayland keeps typing smooth on NVIDIA; `x11` forces Xwayland. Window placement on native Wayland needs the desktop bridge extension (see Desktop bridge). Does not change the desktop session or terminal environment. |
| `TETHER_SOCKET` | unset | Tether control socket. Wins over `TETHER_INSTANCE`. |
| `TETHER_INSTANCE` | `default` | Tether instance; the socket is `$XDG_RUNTIME_DIR/tether/<instance>/control.sock`. |

Aico intentionally does not store third-party AI provider secrets. Authenticate each AI CLI with its own documented login/config flow.

### Desktop bridge (native Wayland)

GNOME never tells a Wayland client where its windows are, and Electron's own
position, cursor and always-on-top calls do nothing there. Aico gets geometry,
placement, raise and the pointer from the desktop bridge GNOME Shell extension
(`dev.summitflow.DesktopBridge` on the session bus; the desktop-automation
repo's `docs/desktop-bridge.md` is the contract). All of it lives behind
`electron/main/compositor.ts`; no other module knows which compositor runs.
With `AICO_OZONE_PLATFORM=x11` the same interface uses Electron's own calls.

- Coordinates are global logical pixels (what layout.json, `st aico widget
  position` and saved bounds use). Electron sizes are DIP, which are logical
  pixels divided by the device scale factor the launcher sets from GNOME's text
  scaling; `toDip` and `fromDip` are the only conversion.
- Every window's title carries a token, `[aico w<id>]`, set before its first
  show. The bridge finds the window by process id and that token, so a new
  window is placed (`Expect`) before it is mapped and never jumps.
- The cache refreshes on the bridge's signals and resyncs when the extension
  appears. Without the bridge Aico still runs: windows open where GNOME puts
  them, tiling is off, `st aico widget position` fails with
  `compositor_unavailable`, and `layout.json` has `"boundsReliable": false`.
- Window edges resize through Chromium's own frameless handling on Wayland (the
  custom edge handles were removed).

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
npm run build
```

Or run the combined public gate:

```bash
npm run check
```

## Mobile access

Every session is a tmux session on a Tether-managed absolute socket, so any
tmux-capable client on the same machine can attach: `tether sessions attach <id>`
(or `--print` for the exact argv). The [web app](../web) is another Tether
client with an authenticated WebSocket, so opening its PWA on a phone
gives live, two-way access to the same sessions Aico shows.

What you get on mobile is the terminal itself; Aico's desktop chrome (eyes, lantern menu) stays on the desktop.

## Architecture

```text
Tether (separate daemon; owns sessions)
  ├─ tmux servers, panes, agent launch, admission, End, roots, context hooks
  └─ API v1 on $XDG_RUNTIME_DIR/tether/<instance>/control.sock (also `st aico` and SummitFlow)

Electron main process (a Tether client)
  ├─ owns widget windows, global shortcuts, and tray
  ├─ mirrors Tether's session list and follows /v1/events (reconnects, resyncs on gaps)
  ├─ holds the GUI channel (/v1/gui/channel) and applies show/position/title/coordinator
  ├─ runs a tmux control-mode client per window and claims resize on focus
  ├─ stores views (geometry, open state) and settings in aico.db
  └─ writes ids-only `[aico:event]` journal lines (push results, retired sessions)

Electron renderer
  ├─ xterm.js terminal UI
  └─ lantern action menu and workspace picker
```

Aico degrades when optional tools are missing: unavailable agent CLIs simply fail in their pane. When Tether is unreachable, open windows keep their terminals and the tray says session control is unavailable; Aico reconnects on its own.

The `st aico` extension's client is `tether/scripts/aico-root-watch.py`; SummitFlow runs it from this checkout. The root contract lives in Tether's `docs/root-control.md` ([pointer](root-control.md)). For the process-containment design and recovery, see Tether's `docs/LIFECYCLE_HARNESS.md` and [the July 2026 incident report](INCIDENT-2026-07-PROCESS-ESCAPES.md). The cutover from the old in-process owner and the Tether API gaps seen then are in [history](history/README.md).

## Current limitations

- Linux desktop is the supported path. macOS and Windows packaging are not implemented.
- X11 is the best-supported session for global shortcuts.
- There is no packaged build (AppImage or `.deb`); the old published AppImages predate Tether and are unsupported.

## License

Aico is licensed under the [Apache License 2.0](../LICENSE). See [NOTICE](../NOTICE) for copyright notice and [assets/fonts/README.md](../assets/fonts/README.md) for vendored font license notes.
