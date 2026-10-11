# ADR 0002: Runtime and packaging

- Status: accepted
- Context: Phase 0 item 1 says Tether ships as a self-contained build or vendored Node, at a start path that stays stable across releases.

## Decision

- **Language:** TypeScript (strict), built with esbuild into a single ESM bundle, `dist/tether.mjs`. It has no runtime dependencies: the HTTP server, Unix sockets and SQLite (`node:sqlite`) all come from Node.
  - This matches Aico's `build:owner`, which bundles `owner-service.ts` the same way.
  - Aico's lifecycle modules can then move with only import-path changes.
- **Runtime:** the system Node.js, version 22.13 or later. `node:sqlite` is available unflagged from 22.13, and WAL works. This host has v24.14.1 at `/usr/local/bin/node` (a symlink to `/opt/node-current`).
  - The launcher `bin/tether` (POSIX sh) resolves Node in this order: `$TETHER_NODE`, `/usr/local/bin/node`, `/usr/bin/node`, then `PATH`.
  - It refuses anything older than 22.13.
  - It runs the bundle with `--disable-warning=ExperimentalWarning`, because Node 24 still labels `node:sqlite` experimental.
- **Stable start path:** `scripts/install.sh` copies the launcher and the bundle into `~/.local/lib/tether/{bin,dist}`. It links `~/.local/bin/tether` to the launcher.
  - The unit template runs `ExecStart=%h/.local/lib/tether/bin/tether --instance %i serve`.
  - Upgrades replace files atomically (write a temp file, then `mv`) and never edit the unit.
  - Running from the repo checkout is supported for development, but the unit never points at it. This is unlike `aico-owner.service`, which runs from `__PROJECT_ROOT__/node_modules/electron`.
- **Unit:** `tether@.service`, `Type=simple`, `Restart=on-failure`, `Slice=app.slice`, and the default `KillMode=control-group`.
  - `Type=notify` was rejected because Node cannot `sd_notify` without a native module or a subprocess.
  - Readiness is the socket answering `GET /v1/health`, which clients and `tether doctor` already check.
  - KillMode stays at its default because Tether's cgroup holds only Tether and its short-lived `tmux`/`systemctl` clients. tmux servers are separate transient units. Tether must never start a tmux server inside its own cgroup.
- **Future: single executable.** A Node SEA (single executable application) binary at the same `~/.local/lib/tether/bin/tether` path would remove the system-Node dependency for other hosts. It is deferred: no other hosts exist yet, SEA plus `node:sqlite` adds build complexity, and the launcher path is already the stable contract.

## Consequences

- A Node upgrade on the host (`/opt/node-current`) changes Tether's runtime on the next restart. `tether doctor` reports the Node version and whether `node:sqlite` is present.
- The installed bundle is a copy, so a repo rebuild does not affect the running daemon until `scripts/install.sh` runs again.
