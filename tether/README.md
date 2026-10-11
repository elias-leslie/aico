# Tether

Tether is a per-user session daemon for Linux. It owns the lifecycle of durable tmux sessions for [Aico](https://github.com/elias-leslie/aico) (desktop) and [A-Term](https://github.com/elias-leslie/a-term) (web and mobile):

- containment
- the catalog and generation fencing
- the agent-tool registry
- the project list
- events

Either app works alone against Tether, and both can share one instance.

Tether serves a versioned HTTP API on a private Unix socket (`$XDG_RUNTIME_DIR/tether/<instance>/control.sock`, mode 0600). It is never exposed on the network. Apps keep their own terminal byte path (`tmux attach`) and their own view state.

**Status: session owner (migration Phase 3a).**

- Implemented: the full v1 API in [docs/api-v1.md](docs/api-v1.md), with Aico's lifecycle extracted into `src/lifecycle/`: contained tmux servers and pane scopes, generation fencing, End, respawn, roots, the GUI forwarding channel, A-Term legacy sessions, the legacy Aico sockets on the default instance, and `tether import-aico`.
- Not yet switched over: Aico (Phase 3b) and A-Term (Phase 4) still run their own lifecycle until they become clients. See [docs/migration-plan.md](docs/migration-plan.md).

## Requirements

- Linux with systemd 254 or later, unified cgroup v2, and user linger enabled
- Node.js 22.13 or later, for `node:sqlite`
- tmux at `/usr/bin/tmux`

## Install

```sh
npm ci
scripts/install.sh              # build; install ~/.local/lib/tether, ~/.local/bin/tether and the unit template
scripts/install.sh --start dev  # also enable and start tether@dev
tether --instance dev doctor
```

The installer is idempotent. It never starts an instance unless you pass `--start`. If the tmux pane memory guard (`tmux-spawn-.scope.d/50-memory-guard.conf`) is missing, it installs it.

## CLI

```text
tether [--instance NAME] [--json] <command>
  serve | doctor | version
  sessions [list | get <id> | create [--tool T] [--project P] [--name N] | end <id>]
  sessions attach <id> [--print]    exec tmux attach (nests with a notice inside another tmux)
  sessions diagnostics <id>
  legacy [list | end <name>]        A-Term summitflow-<uuid> sessions
  roots [list | show <requestId>]
  import-aico [--from PATH] [--apply]
  tools [list | get <slug> | add <slug> <name> -- <argv...> | default|enable|disable|rm <slug>]
  projects [--refresh]
```

## Documentation

- [API v1](docs/api-v1.md)
- [Compatibility contract](docs/compat-contract.md): the Aico names and paths Tether keeps
- [CONTEXT.md](CONTEXT.md): vocabulary
- [ADR 0001: Tether owns sessions; apps own views](docs/adr/0001-tether-owns-sessions.md)
- [ADR 0002: Runtime and packaging](docs/adr/0002-runtime-and-packaging.md)
- [Lifecycle harness](docs/LIFECYCLE_HARNESS.md): host integration tests against a running instance
- [Aico inventory for Phase 3](docs/inventory-aico.md)

## Development

```sh
st check --quick --changed-only     # biome, tsc, vitest, pytest, ruff, gitleaks
scripts/tether-lifecycle-harness.sh dev
```

## Data and backups

Each instance keeps its state in `~/.local/state/tether/<instance>/tether.db` (SQLite in WAL mode). The `/home` subvolume, which includes `~/.local/state`, is covered by the host's native btrbk snapshots sent to `/mnt/summitflow-native`. The portable T7 and Google Drive backups are project-scoped. Their coverage of `~/.local/state/tether` has not been verified, so don't assume it.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
