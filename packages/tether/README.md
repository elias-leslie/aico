# Tether

Tether is a per-user session daemon for Linux. It is part of [Aico](../../README.md) and owns the lifecycle of the durable tmux sessions that Aico web shows:

- containment
- the catalog and generation fencing
- the agent-tool registry
- the project list
- events

Aico web and `st` are its clients.

Tether serves a versioned HTTP API on a private Unix socket (`$XDG_RUNTIME_DIR/tether/<instance>/control.sock`, mode 0600). It is never exposed on the network. Aico web keeps its own terminal byte path (`tmux attach`) and their own view state.

**Status:** early release (v0.1.0, API v1). In daily use on the author's workstation since October 2026, where `tether@default` owns every Aico session ([cutover retrospective](../../docs/history/cutover-log-2026-10-11.md)). Aico web is a client: it keeps only its views (panes, layout and project display settings) and requires API v1 or later.

Tether's project list comes from Aico's project registry (`aico projects`) once it has projects. Otherwise Tether reads a local list at `~/.config/tether/projects.json`. The original migration plan is in [docs/history/migration-plan.md](../../docs/history/migration-plan.md).

## Source layout

Tether is three packages, and the dependency-cruiser rules in `.dependency-cruiser.cjs` hold the direction:

| Package | Holds | May import |
| --- | --- | --- |
| `@aico/session-engine` (`packages/session-engine`) | the `tether.db` schema and store, the agent-tool registry and one adapter per tool (`lifecycle/tui/`), the tmux lifecycle and ownership, roots and launch admission, paths, events, process facts | shared, context, tether-client |
| `@aico/fleet` (`packages/fleet`, `src/hub/`) | the hub that federates Tethers: hub, peers, wake, update, host admin, placement, `tether fleet` CLI | shared, store, status |
| `@aico/tether` (`packages/tether`) | the daemon, HTTP and CLI surface, asks, deliveries, wakes and waits, lane reports, recovery and reboot continuity, history; `API_VERSION` in `src/config.ts` | the packages above |

Neither the engine nor the fleet package imports `@aico/tether`, the fleet package never imports the engine, and Tether imports the others only through package exports (`@aico/session-engine/store`, `@aico/fleet/hub/placement`), never a deep `src` path. None of the four has an import cycle, `import type` included. The engine's compatibility surface (tmux units, hook bytes, ownership labels) is in [docs/compat-contract.md](docs/compat-contract.md).

## Requirements

- Linux with systemd 254 or later, unified cgroup v2, and user linger enabled
- Node.js 22.13 or later, for `node:sqlite`
- tmux at `/usr/bin/tmux`

## Install

Aico's installer installs Tether with the rest of the product (see [docs/INSTALL.md](../../docs/INSTALL.md)):

```sh
scripts/install.sh --start          # from the repo root; enables and starts tether@default
systemctl --user start tether@dev   # a test instance for this boot only (never enabled)
tether doctor
```

It puts the bundle, CLI and shims in `~/.local/lib/tether` and links `~/.local/bin/tether`. `packages/tether/scripts/install-release.sh` copies an already built release there; the `tether@default` unit runs it before each start. On a SummitFlow host, `st service rebuild aico --worker tether@default` deploys Tether.

Agent shims: the installer also puts `systemctl`, `systemd-run`, `pkexec` and a few siblings as wrappers under `~/.local/lib/tether/shims/` (the list is `scripts/shims/shims.list`), and every session Tether creates gets that directory first on PATH. The wrappers add `--no-ask-password` (or `--no-user-interaction` for `udisksctl`) so an agent's system-bus call fails at once instead of popping the owner's polkit password dialog; `pkexec` is refused. Only panes created after the install pick it up, and a caller that uses an absolute path such as `/usr/bin/systemctl` bypasses it.

The installer is idempotent and starts nothing unless you pass `--start`. It installs no pane memory drop-in: host-steward owns the pane OOM policy and cap, and `tether doctor` checks live panes against it.

## CLI

```text
tether [--instance NAME] [--json] <command>
  serve | doctor | version
  sessions [list | get <id> | create [--tool T] [--project P] [--name N] | end <id>]
  sessions attach <id> [--print]    exec tmux attach (nests with a notice inside another tmux)
  sessions diagnostics <id>
  roots [list | show <requestId>]
  import-aico --from PATH [--apply]   one-off import from an archived pre-Tether aico.db
  tools [list | get <slug> | add <slug> <name> -- <argv...> | default|enable|disable|rm <slug>]
  projects [--refresh]
```

## Documentation

- [API v1](docs/api-v1.md)
- [Root control](../../docs/root-control.md): the root contract `st aico` and SummitFlow fleet rely on
- [Compatibility contract](docs/compat-contract.md): the Aico names and paths Tether keeps
- [CONTEXT.md](CONTEXT.md): vocabulary
- [ADR 0001: Tether owns sessions; apps own views](../../docs/adr/0001-tether-owns-sessions.md)
- [ADR 0002: Runtime and packaging](../../docs/adr/0002-runtime-and-packaging.md)
- [Lifecycle harness](docs/LIFECYCLE_HARNESS.md): host integration tests against a running instance
- [Aico inventory](../../docs/history/inventory-aico.md): what moved from Aico's desktop into Tether
- [Migration plan](../../docs/history/migration-plan.md) and [cutover retrospective](../../docs/history/cutover-log-2026-10-11.md)

## Development

```sh
npm ci                              # at the repo root
npm run check                       # biome, tsc, vitest, esbuild bundle (in tether/)
native/host-steward/.venv/bin/pytest -q         # operator script tests, from the repo root (uv sync --locked --directory native/host-steward first)
scripts/tether-lifecycle-harness.sh dev   # host integration tests against a running instance
```

The author runs the same checks through his workspace tool (`st check`), which also runs ruff and gitleaks.

Each instance keeps its state in `~/.local/state/tether/<instance>/tether.db` (SQLite in WAL mode). Include `~/.local/state/tether` in your backups.

### Context-hook checks

Tether reports whether each agent TUI gets Aico's context: what the launch delivered (`aico context delivery TOOL on`), else whether the tool's Aico hook is installed (Claude Code settings, Codex hooks, Pi extension). A missing check stays visible and never blocks the launch.

## License

Apache-2.0. See [LICENSE](../../LICENSE) and [NOTICE](../../NOTICE).
