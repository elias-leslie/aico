# A-Term

Host-native browser workspace with tmux-backed persistent sessions, multi-pane layouts, configurable CLI agent integrations, and a built-in maintenance loop.

**A-Term is a standalone product.** It starts and runs independently with just PostgreSQL and tmux. SummitFlow and Agent Hub integrations are optional companion services.

![A-Term screenshot](docs/images/a-term-home-dark.png)

A-Term gives you browser-accessible tmux sessions with pane layouts, persistent shells, and optional companion tooling without turning your host runtime into a containerized sidecar.

## Quickstart

Native host runtime is the supported path.

```bash
cp .env.example .env.local
# edit DATABASE_URL for your local Postgres

uv sync --dev
DATABASE_URL=postgresql://a-term:a-term@localhost:5432/a-term uv run alembic upgrade head
corepack pnpm --dir frontend install --frozen-lockfile
corepack pnpm --dir frontend build

uv run python -m a_term
API_URL=http://localhost:8002 HOSTNAME=0.0.0.0 PORT=3002 corepack pnpm --dir frontend start
```

## Overview

A-Term provides browser-accessible shell and agent sessions backed by tmux for persistence. It supports multiple panes with split layouts, project-scoped working directories, and dual-mode operation (shell plus the configured default agent tool). Sessions survive browser disconnects, are reconciled with tmux state on startup and on a recurring maintenance interval, and expose maintenance status through `/health`.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | FastAPI, Python 3.13+, Uvicorn |
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4 |
| A-Term | xterm.js 6 (rendering), tmux (session persistence) |
| Database | PostgreSQL (own schema; can be a dedicated database) |
| Quality | Ruff, Ty, pytest, Vitest, Biome |

## Architecture

```
a-term/
├── a_term/              # FastAPI backend
│   ├── api/               # REST + WebSocket endpoints
│   │   ├── a_term.py    # WebSocket a-term I/O
│   │   ├── sessions.py    # Session CRUD
│   │   ├── panes.py       # Pane management
│   │   ├── projects.py    # Project settings
│   │   └── agent.py       # Agent startup + state endpoints
│   ├── services/          # Business logic
│   │   ├── lifecycle.py       # Session lifecycle facade
│   │   ├── lifecycle_core.py  # Single-session operations
│   │   ├── lifecycle_batch.py # Multi-session batch ops
│   │   ├── lifecycle_reconcile.py  # DB/tmux sync + dead-session retention
│   │   ├── maintenance.py     # Periodic maintenance loop + status tracking
│   │   ├── pty_manager.py     # Low-level PTY operations
│   │   └── pane_service.py    # Pane business logic
│   ├── storage/           # Database layer
│   └── utils/             # tmux utilities
├── frontend/
│   ├── app/               # Pages (App Router)
│   ├── components/        # React components
│   │   ├── ATerm.tsx        # xterm.js wrapper + WebSocket
│   │   ├── ATermTabs.tsx    # Tab management
│   │   ├── pane-layouts/      # Split/grid layout components
│   │   └── keyboard/          # Mobile on-screen keyboard
│   └── lib/
│       ├── hooks/         # Custom React hooks
│       └── api/           # API client functions
├── alembic/               # Database migrations
└── scripts/               # Service management
```

## Key Features

- **Persistent sessions** - tmux-backed a-terms survive browser disconnects and server restarts
- **Multi-pane layouts** - Up to 6 panes with resizable split views on wide desktops
- **Dual mode** - Switch between shell and your configured agent tool per pane
- **Project context** - Open a-terms in project-specific working directories
- **Project deep links** - Open `/?project=<id>&dir=<path>` to focus or create a project pane directly
- **Mobile keyboard** - On-screen keyboard for touch devices (simple-keyboard)
- **Periodic maintenance** - Reconciles tmux state, prunes stale uploads, repairs default agent-tool state, and deletes orphaned project settings
- **Maintenance observability** - `/health` and `/api/internal/maintenance/runs` report maintenance state and recent persisted runs
- **Scrollback capture** - Retrieves a-term history when reconnecting
- **Real-time resize** - A-Term dimensions sync between browser and tmux
- **Light and dark app themes** - Respects `prefers-color-scheme` by default and supports a persisted manual override

## Standalone Usage and Optional Integrations

A-Term requires only PostgreSQL and tmux. It has no hard dependency on any other service.

A-Term is intended to run natively on the host under `systemd --user`. It depends on the host tmux server, host working tree, and host CLI auth/session state.

### Standalone (default)

All core features work without SummitFlow or Agent Hub: persistent tmux sessions, multi-pane layouts, shell/agent mode switching, project settings, maintenance, and the full REST/WebSocket API. When no external service is reachable, the project list is populated from local `a_term_project_settings` only.

### Optional: SummitFlow API (`SUMMITFLOW_API_BASE`)

When the SummitFlow backend is available at `SUMMITFLOW_API_BASE`, A-Term fetches project metadata (name, root path) and merges it with local a-term settings. New project panes still open in shell mode by default, but A-Term uses the SummitFlow project root to place the shell in the right working directory. If SummitFlow is unreachable, A-Term continues with local data only.

### Optional: Agent Hub (`NEXT_PUBLIC_AGENT_HUB_URL`, `AGENT_HUB_URL`)

When Agent Hub is configured, A-Term gains:

- **Model catalog** — fetched through A-Term's same-origin `/api/agent-hub/models` proxy so cross-machine installs do not depend on browser CORS.
- **Prompt cleaning** — sent through A-Term's same-origin `/api/agent-hub/complete` proxy for the same reason.
- **Voice transcription** — still optional and still requires `@agent-hub/passport-client`. It is not part of the core v1 install path.

Use `NEXT_PUBLIC_AGENT_HUB_URL` when the browser should expose companion UI, and set `AGENT_HUB_URL` anywhere the A-Term server itself needs to reach Agent Hub directly on another host. If Agent Hub is unavailable, A-Term falls back cleanly.

## Ports

| Service | Port |
|---------|------|
| Frontend (Next.js) | 3002 |
| Backend (FastAPI) | 8002 |

## Getting Started

### Prerequisites

- Python 3.13+
- Node.js 20+
- PostgreSQL
- tmux

### Recommended: Native Standalone

```bash
cp .env.example .env.local
# edit DATABASE_URL for your local Postgres

uv sync --dev
DATABASE_URL=postgresql://a-term:a-term@localhost:5432/a-term uv run alembic upgrade head
corepack pnpm --dir frontend install --frozen-lockfile
corepack pnpm --dir frontend build

# a-term API
uv run python -m a_term

# a-term frontend
API_URL=http://localhost:8002 HOSTNAME=0.0.0.0 PORT=3002 corepack pnpm --dir frontend start
```

`pnpm --dir frontend build` stages `.next/static` and `public/` into the
standalone runtime, and `pnpm --dir frontend start` runs the production Next.js
server. Keep `dev` for local feature work, not for public release verification
or install docs.

### Native Companion

Add these on top of the native standalone setup when SummitFlow or Agent Hub are running elsewhere:

```bash
SUMMITFLOW_API_BASE=http://HOST:8001/api
NEXT_PUBLIC_AGENT_HUB_URL=http://HOST:8003
AGENT_HUB_URL=http://HOST:8003
```

Then start the same production processes as native standalone:

```bash
uv run python -m a_term
API_URL=http://localhost:8002 HOSTNAME=0.0.0.0 PORT=3002 corepack pnpm --dir frontend start
```

### Environment

Runtime settings are read from repo-local `.env.local`, repo-local `.env`, or exported environment variables. Use [`.env.example`](.env.example) as the reference. Only `DATABASE_URL` is required for standalone mode.

```bash
# Required
DATABASE_URL=postgresql://user:pass@localhost/a-term

# Optional integrations (A-Term works without these)
SUMMITFLOW_API_BASE=http://localhost:8001/api       # SummitFlow project metadata
NEXT_PUBLIC_AGENT_HUB_URL=http://localhost:8003     # enables companion UI in the browser
AGENT_HUB_URL=http://localhost:8003                 # server-side Agent Hub access for proxies

# Optional tuning
LOG_LEVEL=INFO
LOG_DIR=logs
MAINTENANCE_INTERVAL_SECONDS=900
MAINTENANCE_SESSION_PURGE_DAYS=7
UPLOAD_MAX_AGE_SECONDS=86400
```

## Remote Access

A-Term listens on `localhost` by default. To access it from other devices — your phone, another computer, or anywhere on the internet — see the [Remote Access guide](docs/remote-access.md), which covers Tailscale, Cloudflare Tunnel, and Caddy reverse proxy setups.

## API

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check plus maintenance status payload |
| GET | `/api/internal/maintenance` | Internal maintenance status (requires internal bearer token) |
| GET | `/api/internal/maintenance/runs` | Recent persisted maintenance runs (requires internal bearer token) |
| POST | `/api/internal/maintenance/run` | Trigger one maintenance cycle (requires internal bearer token) |
| GET | `/api/a-term/sessions` | List sessions |
| GET | `/api/a-term/sessions/{id}` | Get session |
| PATCH | `/api/a-term/sessions/{id}` | Update session |
| DELETE | `/api/a-term/sessions/{id}` | Delete session |
| GET | `/api/a-term/panes` | List panes |
| POST | `/api/a-term/panes` | Create pane (max 6) |
| PATCH | `/api/a-term/panes/{id}` | Update pane |
| DELETE | `/api/a-term/panes/{id}` | Delete pane |
| GET | `/api/a-term/projects` | List project settings (merged with SummitFlow projects when available) |
| PUT | `/api/a-term/project-settings/{id}` | Update project settings |
| PUT | `/api/a-term/projects/{id}/mode` | Set shell/agent mode |
| POST | `/api/a-term/projects/{id}/reset` | Reset project sessions |
| POST | `/api/a-term/projects/{id}/disable` | Disable a-term for project |

### WebSocket

`/ws/a-term/{session_id}` - A-Term I/O stream

| Message Type | Direction | Description |
|-------------|-----------|-------------|
| Text | Client → Server | A-Term input |
| JSON `{"resize": {cols, rows}}` | Client → Server | Resize a-term |
| JSON `{"refresh": true}` | Client → Server | Redraw a-term |
| Binary | Server → Client | A-Term output |

## Database

Primary service tables: `a_term_sessions` (session state, mode, alive tracking), `a_term_panes` (pane layout and ordering), `a_term_project_settings` (per-project mode and enabled state), `agent_tools` (configured CLI agent integrations), and `a_term_maintenance_runs` (append-only maintenance audit trail). Schema is managed via Alembic migrations, with maintenance-focused indexes for session retention and project/mode lookups.

## Services

A-Term runs natively under `systemd --user`:

- `a-term-backend.service` for the FastAPI backend on port `8002`
- `a-term-frontend.service` for the Next.js frontend on port `3002`

`rebuild.sh a-term` remains the preferred local maintenance path in the SummitFlow workspace. Public installs should use the native steps above.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Security

Please report suspected vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

## Commercial

Commercial use is permitted under the Apache 2.0 license.

For commercial support, custom work, partnership discussions, or private
licensing for future versions, start a thread in
[GitHub Discussions](https://github.com/elias-leslie/a-term/discussions).
