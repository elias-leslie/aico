# A-Term

**A browser workspace for AI coding agents, shells, files, and notes.**

Run AI coding agents side by side in a browser workspace that keeps your terminal sessions alive — with a files browser, notes, and voice input built in.

Built for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [OpenCode](https://github.com/opencode-ai/opencode), and every TUI agent that follows.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/elias-leslie/a-term/actions/workflows/ci.yml/badge.svg)](https://github.com/elias-leslie/a-term/actions/workflows/ci.yml)
[![Sponsor](https://img.shields.io/badge/sponsor-GitHub%20Sponsors-db61a2?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/elias-leslie)
[![Python](https://img.shields.io/badge/python-3.13+-3776ab.svg)](https://python.org)
[![Next.js](https://img.shields.io/badge/Next.js-16-000.svg)](https://nextjs.org)
[![xterm.js](https://img.shields.io/badge/xterm.js-6-green.svg)](https://xtermjs.org)

![A-Term — multi-pane workspace with Claude Code, shell, and project files](docs/images/a-term-home-dark.png)

## Why A-Term

If you use AI coding agents, you already know the mess: one terminal for Claude Code, another for Codex, another for git, another for logs, plus notes somewhere else.

**A-Term puts the whole workspace in one browser tab and keeps it alive when your browser or connection drops.**

## Quickstart

```bash
git clone https://github.com/elias-leslie/a-term.git
cd a-term
bash scripts/install.sh
```

Then open **http://localhost:3002** and start working.

A-Term currently targets **Linux with systemd**. The installer is built to do the heavy lifting for you: it can set up `.env.local`, Node.js, corepack, Python, uv, tmux, PostgreSQL, dependencies, migrations, frontend build output, and user services.
The first install can take a few minutes because it downloads the pieces it needs for you.

If **SummitFlow** is already running on the same machine, the installer can connect A-Term to it so notes and project scopes become shared instead of staying local to A-Term.

If the default ports are already taken, the installer should guide you to another open port instead of forcing you to debug it by hand.

Most people can stop here. The advanced setup options are lower on the page.

## Features

**`persistent sessions`** — tmux-backed terminals survive browser closes, server restarts, and network drops. Reconnect exactly where you left off.

**`multi-pane layouts`** — Up to 6 resizable panes. Run Claude Code, Codex, and a shell side by side on the same screen.

![Four-pane grid layout with multiple active agents](docs/images/a-term-grid-2x2.png)
*Four-pane grid: run multiple agents and shells simultaneously*

**`files browser`** — Browse the active pane's working directory. Preview files, copy paths, insert into prompts — without leaving the terminal.

![Files browser showing directory tree and README preview](docs/images/a-term-files-browser.png)
*Browse and preview files from the active pane's working directory*

**`docked notes`** — Keep prompts, context snippets, and scratchpads beside your live terminal output. In standalone installs, notes and prompts are stored inside A-Term itself. When the SummitFlow companion API is configured, the same notes workspace switches to SummitFlow's shared cross-project library.

![Notes workspace docked beside active terminal panes](docs/images/a-term-notes-workspace.png)
*Notes panel docked alongside the workspace*

**`voice input`** — Dictate commands and prompts via browser speech-to-text. Hands stay on the keyboard until they don't need to.

![Voice input panel with transcript textarea and mic controls](docs/images/a-term-voice-input.png)
*Voice input panel overlaid on the workspace*

**`project deep links`** — Open `/?project=myapp&dir=/path` to jump straight into a project workspace. Bookmark your setups.

**`dual mode`** — Switch any pane between raw shell and your configured AI agent with one click. Supports Claude Code, Codex, Gemini CLI, and OpenCode out of the box.

![Mode switching dropdown showing Shell, Claude Code, OpenCode, Gemini CLI, and Codex](docs/images/a-term-mode-switch.png)
*Switch between agents and shell per pane*

**`mobile keyboard`** — On-screen keyboard with arrow keys, Ctrl, Esc, and modifier support for touch devices.

**`light and dark themes`** — Respects `prefers-color-scheme` with a manual override that persists across sessions.

## Advanced Setup

For install smoke or CI validation on Linux hosts without a user systemd session, run `bash scripts/install.sh --skip-systemd`.

For any deployment beyond localhost, turn on browser auth first. `A_TERM_AUTH_MODE=password` is the built-in path. `A_TERM_AUTH_MODE=proxy` is for running behind an identity-aware reverse proxy.

<details>
<summary><strong>Use your own PostgreSQL instead of the installer-managed one</strong></summary>

```bash
docker run -d \
  --name a-term-postgres \
  -e POSTGRES_DB=a-term \
  -e POSTGRES_USER=a-term \
  -e POSTGRES_PASSWORD=a-term \
  -p 5432:5432 \
  postgres:16
```

Set in `.env.local`:

```bash
DATABASE_URL=postgresql://a-term:a-term@localhost:5432/a-term
```

</details>

<details>
<summary><strong>Environment variables</strong></summary>

Copy `.env.example` to `.env.local` only if you want to review or override settings first. For the default one-shot install, `bash scripts/install.sh` will create `.env.local` and replace the placeholder `DATABASE_URL` with managed PostgreSQL automatically. That path prefers Docker when it is already installed and otherwise bootstraps a local PostgreSQL cluster for you.

If you want to use your own PostgreSQL instead, set `DATABASE_URL` yourself. Everything else is optional:

```bash
# Required
DATABASE_URL=postgresql://user:pass@localhost/a-term

# Service tuning
A_TERM_PORT=8002
A_TERM_BIND_HOST=127.0.0.1
A_TERM_FRONTEND_PORT=3002
LOG_LEVEL=INFO

# Public auth
A_TERM_AUTH_MODE=password
A_TERM_AUTH_PASSWORD=change-me
A_TERM_AUTH_SECRET=replace-with-a-long-random-string
A_TERM_AUTH_COOKIE_SECURE=true

# Maintenance
MAINTENANCE_INTERVAL_SECONDS=900
MAINTENANCE_SESSION_PURGE_DAYS=7

# Optional companion services (A-Term works without these)
SUMMITFLOW_API_BASE=http://localhost:8001/api
NEXT_PUBLIC_AGENT_HUB_URL=http://localhost:8003
AGENT_HUB_URL=http://localhost:8003
```

</details>

<details>
<summary><strong>Daily commands</strong></summary>

```bash
bash scripts/start.sh
bash scripts/shutdown.sh
journalctl --user -u a-term-backend.service -f
journalctl --user -u a-term-frontend.service -f
```

</details>

## Remote Access

A-Term listens on `localhost` by default. To access it from your phone, another machine, or anywhere on the internet, see the [Remote Access guide](docs/remote-access.md) — covers Tailscale, Cloudflare Tunnel, and Caddy reverse proxy. Public deployments should use either built-in password auth or `proxy` mode behind an identity-aware gateway.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | FastAPI, Python 3.13+, Uvicorn |
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4 |
| Terminal | xterm.js 6 (rendering), tmux (session persistence) |
| Database | PostgreSQL |
| Quality | Ruff, Ty, pytest, Vitest, Biome |

<details>
<summary><strong>Architecture</strong></summary>

- `a_term/api/` — REST and WebSocket endpoints
- `a_term/services/` — tmux lifecycle, maintenance, agent orchestration
- `a_term/storage/` — database access
- `frontend/app/`, `frontend/components/`, `frontend/lib/` — Next.js UI
- `scripts/` — install, start, stop, systemd templates

Full API schema available at `/openapi.json` when running.

</details>

<details>
<summary><strong>Optional companion integrations</strong></summary>

A-Term is a standalone product. All core features work without any external service.

**SummitFlow** (`SUMMITFLOW_API_BASE`) — When available, A-Term fetches project metadata and switches notes and prompts from A-Term-owned local storage to SummitFlow's central shared notes library. Without it, A-Term keeps notes, prompts, and project scopes local to A-Term.

**Agent Hub** (`NEXT_PUBLIC_AGENT_HUB_URL`, `AGENT_HUB_URL`) — Adds model catalog and prompt cleaning proxies. Browser-native voice input works standalone; Agent Hub provides an optional enhanced path.

</details>

## Sponsors

A-Term is free and open source. If it saves you time, sponsor ongoing development here:

[![Sponsor A-Term on GitHub Sponsors](https://img.shields.io/badge/Sponsor-A--Term%20on%20GitHub%20Sponsors-db61a2?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/elias-leslie)

Sponsorship helps fund:

- install and onboarding polish
- CI, security, and release maintenance
- continued product and UX improvements

<!-- sponsors -->
<!-- /sponsors -->

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Commercial use is permitted. For commercial support, custom work, or partnership discussions, start a thread in [GitHub Discussions](https://github.com/elias-leslie/a-term/discussions).

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
