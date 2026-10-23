# Tether

Tether is a per-user session daemon for Linux. It owns the lifecycle of durable tmux sessions for [Aico](https://github.com/elias-leslie/aico) (desktop) and [A-Term](https://github.com/elias-leslie/a-term) (web and mobile):

- containment
- the catalog and generation fencing
- the agent-tool registry
- the project list
- events

Either app works alone against Tether, and both can share one instance.

Tether serves a versioned HTTP API on a private Unix socket (`$XDG_RUNTIME_DIR/tether/<instance>/control.sock`, mode 0600). It is never exposed on the network. Apps keep their own terminal byte path (`tmux attach`) and their own view state.

**Status:** early release (v0.1.0, API v1). In daily use on the author's workstation since October 2026, where `tether@default` owns every Aico and A-Term session ([cutover retrospective](docs/cutover-log-2026-10-11.md)). Both apps are clients: they keep only their views (Aico windows; A-Term panes, layout and project display settings) and require API v1 or later.

Tether's project list comes from SummitFlow, the author's workspace tool, when it answers on `http://127.0.0.1:8001/api/projects` (override with `TETHER_SUMMITFLOW_URL`, or set it to `off`). Otherwise Tether reads a local list at `~/.config/tether/projects.json`, so it works without SummitFlow. Remaining cleanup work in the two apps is tracked in [docs/migration-plan.md](docs/migration-plan.md).

## Requirements

- Linux with systemd 254 or later, unified cgroup v2, and user linger enabled
- Node.js 22.13 or later, for `node:sqlite`
- tmux at `/usr/bin/tmux`

## Install

```sh
npm ci
scripts/install.sh              # build; install ~/.local/lib/tether, ~/.local/bin/tether and the unit template
scripts/install.sh --start default  # also enable and start tether@default
scripts/install.sh --start dev      # start a test instance for this boot only (never enabled)
tether doctor
```

Install Tether before Aico or A-Term; both installers refuse to continue until it answers. A single `default` instance can serve both apps.

Agent shims: the installer also puts `systemctl`, `systemd-run`, `pkexec` and a few siblings as wrappers under `~/.local/lib/tether/shims/` (the list is `scripts/shims/shims.list`), and every session Tether creates gets that directory first on PATH. The wrappers add `--no-ask-password` (or `--no-user-interaction` for `udisksctl`) so an agent's system-bus call fails at once instead of popping the owner's polkit password dialog; `pkexec` is refused. Only panes created after the install pick it up, and a caller that uses an absolute path such as `/usr/bin/systemctl` bypasses it.

The installer is idempotent. It never starts an instance unless you pass `--start`. It installs no pane memory drop-in: Nightshift owns the pane OOM policy and cap, and `tether doctor` checks live panes against it.

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
- [Root control](docs/root-control.md): the root contract `st aico` and SummitFlow fleet rely on
- [Compatibility contract](docs/compat-contract.md): the Aico names and paths Tether keeps
- [CONTEXT.md](CONTEXT.md): vocabulary
- [ADR 0001: Tether owns sessions; apps own views](docs/adr/0001-tether-owns-sessions.md)
- [ADR 0002: Runtime and packaging](docs/adr/0002-runtime-and-packaging.md)
- [Lifecycle harness](docs/LIFECYCLE_HARNESS.md): host integration tests against a running instance
- [Aico inventory](docs/inventory-aico.md): what moved from Aico into Tether
- [Migration plan](docs/migration-plan.md) and [cutover retrospective](docs/cutover-log-2026-10-11.md)

## Development

```sh
npm ci
npm run check                       # biome, tsc, vitest, esbuild bundle
uv run pytest                       # operator script tests (scripts/tests)
scripts/tether-lifecycle-harness.sh dev   # host integration tests against a running instance
```

The author runs the same checks through his workspace tool (`st check`), which also runs ruff and gitleaks.

Each instance keeps its state in `~/.local/state/tether/<instance>/tether.db` (SQLite in WAL mode). Include `~/.local/state/tether` in your backups.

### Context-hook checks

Tether reports whether each agent TUI's optional context hook is installed. Those checks look for sibling checkouts under `$TETHER_PROJECTS_DIR`, set in a unit drop-in such as `~/.config/systemd/user/tether@.service.d/projects-dir.conf` (`Environment=TETHER_PROJECTS_DIR=/srv/workspaces/projects`). Set `AGENT_HUB_REPO` or `CODEX_CONFIG_REPO` to point at a checkout directly. With none of them set, or no checkout there, the status reads `missing` and says why, and the agent still launches normally.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
