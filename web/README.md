# A-Term

**Your browser is now a terminal multiplexer.**

Run AI coding agents side by side in persistent, browser-accessible tmux sessions — with a files browser, notes, and voice input built in.

Built for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [OpenCode](https://github.com/opencode-ai/opencode), and every TUI agent that follows.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.13+-3776ab.svg)](https://python.org)
[![Next.js](https://img.shields.io/badge/Next.js-16-000.svg)](https://nextjs.org)
[![xterm.js](https://img.shields.io/badge/xterm.js-6-green.svg)](https://xtermjs.org)

![A-Term — multi-pane workspace with Claude Code, shell, and project files](docs/images/a-term-home-dark.png)

## The Problem

You're running Claude Code in one terminal, Codex in another, a shell for git, and a fourth for logs. You lose your session when the browser tab closes or SSH drops. Your project files are in a different window. Your notes are in a different app entirely.

**A-Term puts all of it in one browser tab.**

## Features

**`persistent sessions`** — tmux-backed terminals survive browser closes, server restarts, and network drops. Reconnect exactly where you left off.

**`multi-pane layouts`** — Up to 6 resizable panes. Run Claude Code, Codex, and a shell side by side on the same screen.

![Four-pane grid layout with multiple active agents](docs/images/a-term-grid-2x2.png)
*Four-pane grid: run multiple agents and shells simultaneously*

**`files browser`** — Browse the active pane's working directory. Preview files, copy paths, insert into prompts — without leaving the terminal.

![Files browser showing directory tree and README preview](docs/images/a-term-files-browser.png)
*Browse and preview files from the active pane's working directory*

**`docked notes`** — Keep prompts, context snippets, and scratchpads beside your live terminal output. Project-scoped, always available.

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

## Install

```bash
git clone https://github.com/elias-leslie/a-term.git
cd a-term
bash scripts/install.sh
```

> Requires Linux with systemd, tmux, Node.js 20+, and PostgreSQL.
> The installer handles Python 3.13, uv, Alembic migrations, frontend build, and systemd unit setup.

Then open **http://localhost:3002** and start working.

<details>
<summary><strong>Quick PostgreSQL setup (Docker)</strong></summary>

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

Copy `.env.example` to `.env.local` and set `DATABASE_URL`. Everything else is optional:

```bash
# Required
DATABASE_URL=postgresql://user:pass@localhost/a-term

# Service tuning
A_TERM_PORT=8002
A_TERM_FRONTEND_PORT=3002
LOG_LEVEL=INFO

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

A-Term listens on `localhost` by default. To access it from your phone, another machine, or anywhere on the internet, see the [Remote Access guide](docs/remote-access.md) — covers Tailscale, Cloudflare Tunnel, and Caddy reverse proxy.

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

**SummitFlow** (`SUMMITFLOW_API_BASE`) — When available, A-Term fetches project metadata (name, root path) and uses it to place shells in the right working directory. Falls back to local data if unreachable.

**Agent Hub** (`NEXT_PUBLIC_AGENT_HUB_URL`, `AGENT_HUB_URL`) — Adds model catalog and prompt cleaning proxies. Browser-native voice input works standalone; Agent Hub provides an optional enhanced path.

</details>

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Commercial use is permitted. For commercial support, custom work, or partnership discussions, start a thread in [GitHub Discussions](https://github.com/elias-leslie/a-term/discussions).

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
