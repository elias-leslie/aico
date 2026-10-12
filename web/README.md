# A-Term

A-Term is a persistent browser workspace for people using AI coding CLIs and shells. It puts terminals and project files side by side. The sessions themselves live in [Tether](https://github.com/elias-leslie/tether), a local session daemon, so they keep running when the browser closes and work resumes on reconnect. The same sessions can also be opened from [Aico](https://github.com/elias-leslie/aico), a Linux desktop app that shows each agent session as a floating window. A-Term and Aico are two views onto the same Tether sessions: you can start an agent on the desktop and pick it up from a phone browser, or the reverse.

## What it does

- Runs Claude Code, Codex, Antigravity, Pi, shells, and configurable TUI tools in up to six resizable panes.
- Provides file browsing and validated uploads, terminal search, scrollback, and mobile controls.
- Supports pane pop-outs, project switching/deep links, themes, and PWA installation.
- Shows every Tether session, whichever app started it, and the agent sessions you started yourself on your default tmux server.

## Current scope

The supported install targets Linux with systemd and requires Tether (API version 1 or newer) running as `tether@default.service`. Projects come from Tether, which reads them from a local list (`~/.config/tether/projects.json`) that A-Term can add to. On the author's workstation Tether reads them from SummitFlow, his own workspace tool, instead. Agent Hub prompt cleaning is an optional companion integration.

## Getting started

Install from source. The [Releases page](https://github.com/elias-leslie/a-term/releases) currently has only v0.1.0 from June 2026, which predates the move to Tether; the current code on `main` (0.2.x) is newer and is what this README describes.

```bash
git clone https://github.com/elias-leslie/a-term.git
cd a-term
bash scripts/install.sh
```

Install and start Tether first. Then open <http://localhost:3002>. The installer checks that Tether answers, then sets up dependencies, frontend output, user services and local configuration. Source requirements include Python 3.13+, Node.js, pnpm, uv, and tmux. Install smoke tests without a user systemd session can use `bash scripts/install.sh --skip-systemd` (add `A_TERM_SKIP_TETHER_CHECK=1` where no Tether runs).

## Runtime, data, and integrations

FastAPI uses port 8002 and Next.js uses port 3002 by default. A-Term has no database server. Tether owns sessions, agent tools and the project list, and A-Term reaches it over its Unix socket (`TETHER_SOCKET`, default `$XDG_RUNTIME_DIR/tether/default/control.sock`). A-Term keeps only its own view state (panes, layout, which session each pane shows, project display settings) in `~/.local/state/a-term/a-term.db`. Losing that file loses layout, never a running session.

Default authentication is loopback-only `none`. Before exposing A-Term beyond localhost, use built-in password authentication or `proxy` mode behind an identity-aware gateway. Agent Hub adds optional model catalog and prompt refinement; browser speech input can work independently.

## Development and verification

```bash
uv sync --extra dev
corepack pnpm --dir frontend install
uv run pytest
uv run ruff check .
corepack pnpm --dir frontend lint
corepack pnpm --dir frontend exec tsc --noEmit
corepack pnpm --dir frontend test
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the full list, including `ty`. The author runs the same checks through his workspace tool (`st check`). The [project guide](docs/project-guide.md) covers advanced configuration, daily commands, and feature details. Session survival and rendering behavior need runtime verification in addition to those checks.

## Documentation

- [Project guide](docs/project-guide.md), [remote access](docs/remote-access.md), [mobile verification](docs/mobile-verification.md), and [glossary](docs/glossary.md).
- [Contributing](CONTRIBUTING.md), [releasing](RELEASING.md), and [changelog](CHANGELOG.md).
- [Security reporting](SECURITY.md), [Apache 2.0 license](LICENSE), and [notice](NOTICE).
- [Releases](https://github.com/elias-leslie/a-term/releases) and [sponsorship](https://github.com/sponsors/elias-leslie).
