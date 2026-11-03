# Aico

Aico is a Linux companion for people working with terminal AI tools. Your agent sessions keep running in the background, and you open them wherever you are: in a browser or on your phone. Tether, Aico's session daemon, owns every session, so closing a window or the browser never stops one.

## What it does

- Runs Claude Code, Codex, Antigravity, Pi and shells in sessions that survive closed windows, browser restarts and app updates.
- In the browser and on the phone: the same sessions with a phone keyboard, file browsing, uploads and search, installable as an app.
- Agents can share files, folders or a link with you (`tether share`): links to where the files are, opened under Files › Shared. File paths in the web terminal are clickable too.

## Current scope

Aico targets a single-user Linux machine with systemd. macOS, Windows and packaged builds are not available.

## Getting started

Install from source:

```bash
git clone https://github.com/elias-leslie/aico.git
cd aico
scripts/install.sh --start   # build, install, start Tether and the web app
```

Then open <http://localhost:3002> for the web app. `scripts/install.sh --dry-run` shows what it would do first. It needs Node.js 22+, npm, Python 3, tmux and systemd 254+; [docs/INSTALL.md](docs/INSTALL.md) has the details.

## How it fits together

| Part | Where | What it does |
| --- | --- | --- |
| Tether | `tether/` | The session daemon (`tether@default`). Owns tmux servers, agent launch, End, roots and the project list. Serves a private Unix socket only. |
| Web app | `web/` | Browser and phone app: one Node server (`aico-web.service`, port 3002) serving the page, its API and the terminal sockets. |

Tether is found at `$TETHER_SOCKET`, else `$XDG_RUNTIME_DIR/tether/${TETHER_INSTANCE:-default}/control.sock`. When it is down, open views keep their terminals and session actions say control is unavailable.

The web app keeps its tabs in `~/.local/state/aico/web.db`. Losing it loses layout, never a running session. AI provider credentials belong to each CLI.

## Runtime, data, and integrations

Agent shares (`show.requested`) are accepted only from your own `tether@default`. A share links to files where they already are; nothing is copied. The web app opens them under **Files › Shared**, and the notice's **Open** goes there. See [agent shares](docs/agent-shares.md).

Provision the exchange root before use, with an `agent/` subtree Tether can write. Create `owner/` yourself. Owner directories must have no group or other write permission. Set `TETHER_EXCHANGE_ROOT` for Tether.

The web app has no login of its own and listens on loopback only. Before exposing it beyond localhost, put it behind an identity-aware gateway; see [remote access](docs/remote-access.md).

## Development and verification

```bash
npm ci
npm run check
uv sync --locked --directory native/host-steward   # only for Tether's Python operator scripts
```

`npm run check` runs lint, type checks, the TypeScript tests of the shared code, Tether, the web server and front end, and the build. Tether's operator-script tests run with `native/host-steward/.venv/bin/pytest` from the root. The author runs everything through his workspace tool (`st check`). Avoid broad process-name cleanup.

## Documentation

- [Project guide](docs/project-guide.md), [web app guide](docs/web-guide.md) and [install](docs/INSTALL.md).
- [Glossary](docs/glossary.md), [root control](docs/root-control.md), [agent shares](docs/agent-shares.md), [remote access](docs/remote-access.md) and [mobile verification](docs/mobile-verification.md).
- Tether: [README](packages/tether/README.md), [API v1](packages/tether/docs/api-v1.md) and the [decision records](docs/adr/).
- [History](docs/history/README.md) and the [process incident report](docs/INCIDENT-2026-07-PROCESS-ESCAPES.md).
- [Changelog](CHANGELOG.md), [security](SECURITY.md), [Apache 2.0 license](LICENSE), [notice](NOTICE) and [font licenses](packages/ui-kit/fonts/README.md).
