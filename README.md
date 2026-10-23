# Aico

Aico is a Linux companion for people working with terminal AI tools. Your agent sessions keep running in the background, and you open them wherever you are: as floating desktop windows, or in a browser or on your phone. Tether, Aico's session daemon, owns every session, so closing a window or the browser never stops one.

![Aico floating widget](docs/images/aico-demo.gif)

## What it does

- Runs Claude Code, Codex, Antigravity, Pi and shells in sessions that survive closed windows, browser restarts and app updates.
- On the desktop: movable session windows that remember their place, a command palette, a workspace picker, browser selection capture, and optional arcade-style title bar scenes.
- In the browser and on the phone: the same sessions with a phone keyboard, file browsing, uploads and search, installable as an app.
- Agents can share a file or link with you (`tether show`); it shows up in both.

## Current scope

Aico targets a single-user Linux machine with systemd. X11 is the best-supported desktop path for global shortcuts; Wayland has limitations. The optional browser extension is loaded unpacked. macOS, Windows and packaged builds are not available.

## Getting started

Install from source:

```bash
git clone https://github.com/elias-leslie/aico.git
cd aico
scripts/install.sh --start   # build, install, start Tether and the web app
scripts/aico-launch.sh       # the desktop app
```

Then open <http://localhost:3002> for the web app. `scripts/install.sh --dry-run` shows what it would do first. It needs Node.js 22+, npm, uv, Python 3.13+, tmux and systemd 254+; [docs/INSTALL.md](docs/INSTALL.md) has the details, including the Electron sandbox steps it may ask `sudo` for.

## How it fits together

| Part | Where | What it does |
| --- | --- | --- |
| Tether | `tether/` | The session daemon (`tether@default`). Owns tmux servers, agent launch, End, roots and the project list. Serves a private Unix socket only. |
| Desktop | `electron/`, `extension/` | Floating windows (`aico-shell.service`). Listens on `127.0.0.1:8005` for browser captures and `st selection send`. |
| Web app | `web/` | Browser and phone front end on port 3002, with its backend on 8002. |

Tether is found at `$TETHER_SOCKET`, else `$XDG_RUNTIME_DIR/tether/${TETHER_INSTANCE:-default}/control.sock`. When it is down, open views keep their terminals and session actions say control is unavailable.

The desktop keeps only window views and settings in `~/.local/state/aico/aico.db`; the web app keeps its panes in `~/.local/state/a-term/a-term.db`. Losing either loses layout, never a running session. AI provider credentials belong to each CLI. Captures are typed at the last-focused session's prompt or refused; none are stored.

## Runtime, data, and integrations

Agent shares (`show.requested`) are accepted only from your own `tether@default`. On the desktop a notification offers **Show file**, or shows the URL with **Copy**. Files are copied on click into `$TETHER_EXCHANGE_ROOT/owner/shown/<id>-<name>` (root default `/srv/workspaces/exchange`). Previews show raster images or escaped text; other files open in the file manager. The web app lists recent shares and can push a notification through Nightshift. See [agent shares](docs/agent-shares.md).

Provision the exchange root before use, with an `agent/` subtree Tether can write. The desktop can create `owner/` when the root belongs to you and only you can write it; otherwise create `owner/` yourself. Owner directories must have no group or other write permission. Set the same `TETHER_EXCHANGE_ROOT` for Tether and both front ends.

The web app has no login of its own by default and listens on loopback only. Before exposing it beyond localhost, put it behind an identity-aware gateway or turn on its password mode; see [remote access](docs/remote-access.md).

## Development and verification

```bash
npm ci
(cd web && uv sync --locked --extra dev)
npm run check
```

`npm run check` runs lint, type checks, the TypeScript tests of the desktop, Tether and web front end, and the build. The web backend's tests and Tether's script tests run with `web/.venv/bin/pytest` from the root. The author runs everything through his workspace tool (`st check`). Avoid broad process-name cleanup.

## Documentation

- [Desktop guide](docs/project-guide.md), [web app guide](docs/web-guide.md), [install](docs/INSTALL.md) and [browser extension](extension/README.md).
- [Glossary](docs/glossary.md), [root control](docs/root-control.md), [agent shares](docs/agent-shares.md), [remote access](docs/remote-access.md) and [mobile verification](docs/mobile-verification.md).
- Tether: [README](tether/README.md), [API v1](tether/docs/api-v1.md) and the [decision records](docs/adr/).
- [History](docs/history/README.md) and the [process incident report](docs/INCIDENT-2026-07-PROCESS-ESCAPES.md).
- [Changelog](CHANGELOG.md), [security](SECURITY.md), [Apache 2.0 license](LICENSE), [notice](NOTICE) and [font licenses](assets/fonts/README.md).
