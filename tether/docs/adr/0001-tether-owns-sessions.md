# ADR 0001: Tether owns sessions; apps own views

- Status: accepted (owner decisions 2026-10-10)
- Context: [migration-plan.md](../migration-plan.md)

## Context

Aico (desktop) and A-Term (web/mobile) each create durable tmux sessions. Each app has its own lifecycle code, catalog and tool registry. The cross-app **Owner** concept exists so each app can end the other's sessions:

- The creating app is the only one that can verify and end the workload.
- The other app asks it to over a private socket or an internal HTTP route.
- Discovery is federated. A-Term reads `aico.db` read-only, and Aico lists A-Term's tmux sessions.

This doubles the hard part. The July 2026 containment incident ([Aico INCIDENT-2026-07-PROCESS-ESCAPES.md](https://github.com/elias-leslie/aico/blob/040df2b286dd6e43cc7c7b608ac88ac9b972951b/docs/INCIDENT-2026-07-PROCESS-ESCAPES.md)) showed that durable sessions need exact cgroup containment and generation-checked, fail-closed reconciliation. Only Aico has that hardened model. A-Term's sessions still run on the default tmux server with a global hook.

## Decision

A standalone per-user daemon, **Tether**, owns session lifecycle for both apps:

- tmux server, session and pane lifecycle and containment, using Aico's hardened model moved unchanged
- the session catalog and root-request tombstones
- the merged agent-tool registry
- TUI launch, context-hook verification and agent admission
- text injection
- the project list
- the event stream
- the active-client resize claim
- `/v1/roots` ([root contract](../root-control.md))

Tether has its own SQLite database and a versioned API on a 0600 Unix socket ([api-v1.md](../api-v1.md)). It is never network-exposed.

Apps own **views**. Aico keeps windows, bounds, settings and selections. A-Term keeps panes, layouts and per-project display settings in a small local SQLite file keyed by Tether session ids. Each app keeps its own byte path: a PTY running `tmux attach -S <socket>` against the target Tether returns. Tether never proxies terminal bytes.

The cross-app **Owner** concept is dropped. Either app can end, rename or resize any session through Tether. There is one authority, so there is nothing to federate.

Rules that follow:

- **No silent resurrection.** A dead session is never re-created implicitly. Starting new work is always an explicit create, and a root request id can never start work again after End.
  There are two announced exceptions, and both resume the same session in place rather than start new work. **Reboot restore** relaunches sessions that were running before their tmux server died at a reboot ([reboot-continuity.md](../reboot-continuity.md)). **Crash restore** (amendment, 2026-10-16) relaunches a session whose pane, agent or tmux server was killed while nobody ended it, once Tether has proven the crash from the journal or the agent's exit status ([crash-recovery.md](../crash-recovery.md)). Each recovery is announced: the agent gets a synopsis of what happened, the status is in `tether recovery status`, and Nightshift pushes the owner. Loop limits hold a session that keeps crashing instead of relaunching it. An ended session is deleted from the catalog, so neither exception can bring it back.
- **Instances.** `tether@<instance>.service`. Both apps can share `default`, or each can use its own instance. Only `default` serves Aico's legacy sockets and adopts historical tmux servers, and no instance reconciles another instance's units ([compat-contract.md](../compat-contract.md)).
- **Independent of app rebuilds.** Tether is not a worker of either app's `project.identity.json`. Rebuilding or restarting an app never restarts Tether. Restarting Tether never stops a tmux server, because servers are separate transient units.
- **GUI view mutations.** Show, position and title are forwarded to a connected Aico GUI client over a channel the GUI opens. With none connected, Tether answers `gui_unavailable` and never starts the desktop.

## Consequences

- Phase 3 is an extraction: Aico's lifecycle modules, their tests and their invariants move into Tether verbatim where possible ([inventory-aico.md](../inventory-aico.md)). The catalog import is byte for byte, and `generation` values stay valid across the cutover.
- A-Term drops its Postgres session tables, its tmux lifecycle code and its default-server hook, and becomes a Tether client (Phase 4).
- SummitFlow fleet, `st aico` and codex sync keep working through the compatibility names (`AICO_*` markers, `owner: "aico"`, legacy sockets) until consumers move (Phase 5).
- One daemon is now a single point of failure for session control, though not for running sessions: tmux servers and panes keep running while Tether is down or restarting. Apps must treat `ECONNREFUSED` as "control unavailable", not "session gone".
