# Aico project guide

[Project overview](../README.md). This guide retains detailed setup, operating contracts, and verification notes. Run shell commands from the repository root unless a step changes directory. Aico is the web and phone app over Tether; the [web app guide](web-guide.md) covers its features. The floating desktop app was removed (see the [changelog](../CHANGELOG.md)).

## What it does

- **Persistent sessions, owned by Tether** — every session lives in [Tether](https://github.com/elias-leslie/tether), the per-user session daemon; each tab is a view of one Tether session, keyed by its 8-hex session ID. Closing a tab or the browser only detaches its tmux client, so work reattaches across close/reopen/restart, and Aico restarts never touch sessions. Titles (`displayTitle`, `Project — Task`) and the coordinator chip (`badge`) come from the Tether descriptor as they are.
- **Lifecycle diagnostics** — Tether keeps a report for each session: ownership, tmux target, command, scope, age, CPU time, memory, swap, process/task counts, and containment warnings.
- **Agent launcher** — start any tool Tether has enabled (Claude Code, Codex, Antigravity, Pi, a plain shell, …) from New session, choosing the tool and the project to launch it into.
- **Native scrollback** — each session is attached in tmux control mode, so the terminal itself holds the pane's history: scroll, select and copy reach as far back as it goes.
- **Project picker** — the projects Tether serves (SummitFlow's catalog when installed, else Tether's local list). Claude Code, Codex and Pi also offer a blank slate: a new empty workspace with no first-party context ([root-control.md](root-control.md#blank-slate)).
- **Every session, one list** — the session list shows every Tether session, whether started from the web app, the `tether` CLI or a SummitFlow root.

## Requirements

Aico currently targets a **single-user Linux machine with systemd**.

Required:

- a running [Tether](https://github.com/elias-leslie/tether) daemon, API v1 or later (`tether --json version`). Tether's installer checks its own durable-session prerequisites: a systemd 254+ user manager, cgroup v2, per-pane tmux scopes and user lingering
- `tmux` (each view is a tmux client of its session)

Source installs additionally need Node.js 22+, npm and Python 3.

Recommended:

- Any terminal AI CLIs you want to launch (`claude`, `codex`, `agy`, `pi`). Aico does not provide accounts or API keys for those tools.

## Quickstart

Aico installs from source; there is no packaged build. The old AppImages on the [Releases](https://github.com/elias-leslie/aico/releases) page (v0.1.0 and v0.1.1, June 2026) predate Tether and are unsupported.

### Build from source

```bash
git clone https://github.com/elias-leslie/aico.git
cd aico
scripts/install.sh --start
```

`scripts/install.sh` installs Tether and the web app from this checkout, as [INSTALL.md](INSTALL.md) describes:

- requires Node.js 22+, systemd 254+, cgroup v2 and tmux
- `npm ci` and `npm run build`
- installs Tether's bundle and CLI, then renders the user units in `scripts/systemd/` into `${XDG_CONFIG_HOME:-~/.config}/systemd/user/` (substituting the checkout path, as `st service rebuild aico` does) and reloads the user manager
- with `--start`, enables and restarts `tether@default` and `aico-web`

Then open <http://localhost:3002>.

## Configuration

Aico reads configuration from process environment variables only. Nothing
loads a `.env` file: `.env.example` is a reference list of the variables and
their defaults, not a file the app reads.

The services run as systemd user units, so they see the user manager's
environment, not your interactive shell's. Set overrides with a drop-in, then
restart the unit:

```bash
systemctl --user edit aico-web.service
# [Service]
# Environment=TETHER_INSTANCE=default
```

Important variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TETHER_SOCKET` | unset | Tether control socket. Wins over `TETHER_INSTANCE`. |
| `TETHER_INSTANCE` | `default` | Tether instance; the socket is `$XDG_RUNTIME_DIR/tether/<instance>/control.sock`. |

The web server has its own variables (port, database path, uploads); see the [web app guide](web-guide.md#advanced-setup).

Aico intentionally does not store third-party AI provider secrets. Authenticate each AI CLI with its own documented login/config flow.

### Agent launch admission

Admission (memory and PSI thresholds) moved to Tether with the rest of the
session lifecycle; configure it there. A deferred launch reaches Aico as a
create failure and is shown in the new-session dialog.

Placement across hosts (`st aico create --host auto --needs mem=6G,cpu=2`)
also lives in Tether: it picks the first host with room from live readings, or
answers `at_capacity` with each host's reason. Order, owner reserves and the
Proxmox node per host are data in `~/.config/tether/placement.json`; see
packages/tether/docs/api-v1.md "Placement". `st aico placement --needs ...` shows the
decision without starting anything.

## Test, lint, typecheck, build

After `npm ci`:

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
(or `--print` for the exact argv). The [web app](../packages/web-server) is another Tether
client with an authenticated WebSocket, so opening its PWA on a phone
gives live, two-way access to the same sessions.

An agent's question and a new share reach the owner through Nightshift's notice contract v1 (`nightshift push
--json`, see Nightshift's `docs/notify-contract.md`; sender: `packages/web-server/src/notice.ts`): a question offers Answer
and opens `?ask=<id>`, a share opens `?show=<id>`. A session that waits on the owner for two minutes is a phone notice from Tether, through Aico's notify (`POST /api/notices` on loopback).

## Architecture

```text
Tether (separate daemon; owns sessions)
  ├─ tmux servers, panes, agent launch, admission, End, roots, context hooks
  ├─ the 2-minute waiting notices (Aico notify, phone)
  └─ API v1 on $XDG_RUNTIME_DIR/tether/<instance>/control.sock (also `st aico` and SummitFlow)

aico-web (a Tether client, port 3002)
  ├─ serves the page, its API and the terminal sockets
  ├─ follows Tether's /v1/events (reconnects, resyncs on gaps)
  └─ keeps tabs and project settings in web.db

Browser or phone (the PWA)
  └─ xterm.js terminal UI, session list, Files, check-ins
```

Aico degrades when optional tools are missing: unavailable agent CLIs simply fail in their pane. When Tether is unreachable, open views keep their terminals and session actions say control is unavailable; Aico reconnects on its own.

The `st aico` extension's client is `native/host-steward/aico-root-watch.py`; SummitFlow runs it from this checkout. The root contract lives in Tether's `docs/root-control.md` ([pointer](root-control.md)). For the process-containment design and recovery, see Tether's `docs/LIFECYCLE_HARNESS.md` and [the July 2026 incident report](INCIDENT-2026-07-PROCESS-ESCAPES.md). The cutover from the old in-process owner and the Tether API gaps seen then are in [history](history/README.md).

## Current limitations

- A single-user Linux machine is the supported path. macOS and Windows packaging are not implemented.
- There is no packaged build (AppImage or `.deb`); the old published AppImages predate Tether and are unsupported.

## License

Aico is licensed under the [Apache License 2.0](../LICENSE). See [NOTICE](../NOTICE) for copyright notice and [packages/ui-kit/fonts/README.md](../packages/ui-kit/fonts/README.md) for vendored font license notes.
