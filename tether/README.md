# Tether

Tether is a per-user session daemon for Linux. It owns the lifecycle of durable tmux sessions for [Aico](https://github.com/elias-leslie/aico) (desktop) and [A-Term](https://github.com/elias-leslie/a-term) (web and mobile):

- containment
- the catalog and generation fencing
- the agent-tool registry
- the project list
- events

Either app works alone against Tether, and both can share one instance.

Tether serves a versioned HTTP API on a private Unix socket (`$XDG_RUNTIME_DIR/tether/<instance>/control.sock`, mode 0600). It is never exposed on the network. Apps keep their own terminal byte path (`tmux attach`) and their own view state.

**Status: v0 skeleton (migration Phase 2).**

- Implemented: health and version, projects, the agent-tool registry, the event stream, the CLI, the installer and the systemd unit.
- Not yet implemented: session lifecycle routes answer `501 not_implemented` until Phase 3 extracts Aico's hardened lifecycle. See [docs/migration-plan.md](docs/migration-plan.md).

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
  sessions [list | get <id>]
  roots [list | show <requestId>]
  tools [list | get <slug> | add <slug> <name> -- <argv...> | default|enable|disable|rm <slug>]
  projects [--refresh]
```

## Documentation

- [API v1](docs/api-v1.md)
- [Compatibility contract](docs/compat-contract.md): the Aico names and paths Tether keeps
- [CONTEXT.md](CONTEXT.md): vocabulary
- [ADR 0001: Tether owns sessions; apps own views](docs/adr/0001-tether-owns-sessions.md)
- [ADR 0002: Runtime and packaging](docs/adr/0002-runtime-and-packaging.md)
- [Aico inventory for Phase 3](docs/inventory-aico.md)

## Development

```sh
npm run check   # biome, tsc, vitest, esbuild
```

## Data and backups

Each instance keeps its state in `~/.local/state/tether/<instance>/tether.db` (SQLite in WAL mode). The `/home` subvolume, which includes `~/.local/state`, is covered by the host's native btrbk snapshots sent to `/mnt/summitflow-native`. The portable T7 and Google Drive backups are project-scoped. Their coverage of `~/.local/state/tether` has not been verified, so don't assume it.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
