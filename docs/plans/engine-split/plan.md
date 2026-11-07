# Split the session engine and move fleet code out of Tether

Plan only (roadmap "Next"). Measured 2026-11-07 on `main` over the 117 non-test files in `packages/tether/src` (42,856 lines; tests another 29,265). Import edges come from the files' own `import`/`export from`/`import()` statements, value and type-only imports counted separately; `.dependency-cruiser-known-violations.json` agrees with the cycle list. Neri case data was not read.

## 1. Map

Groups are by responsibility. Arrows are value imports (what the code needs to run); letters name the groups it imports.

| Group | Files | Lines | Test lines | Imports |
| --- | --- | --- | --- | --- |
| A Foundation: config (paths, `API_VERSION`), events, env, proc-fs/facts, generation, http helpers, socket client, projects | 14 | 1,408 | ~560 | D (one edge) |
| B State: `schema.ts` (37 migrations, one chain), `store.ts` | 2 | 1,711 | ~440 | C (tool seeds) |
| C Agent tools: `lifecycle/tui/**` (4 adapters + registry), tools, agent-state, continuity, model-record | 25 | 4,581 | ~3,150 | A B D |
| D Engine core: `lifecycle/` (engine 3,340, catalog, tmux, ownership, entries, display, panes) + running-session, dead-shells, entry-* | 21 | 7,468 | ~6,010 | A B C E |
| E Roots + admission: root-control, root-launch, owner-*, agent-admission, job-guard, memory-guard/policy | 8 | 3,494 | ~3,070 | A C D |
| F Recovery + reboot continuity | 4 | 2,809 | ~1,480 | A C D E I |
| G Messaging: wakes, waits, wait-readers, lane-reports, deliveries, model-switch/notices | 10 | 7,275 | ~5,160 | A C D E L |
| H Asks | 2 | 1,528 | ~1,020 | A K |
| I Hub + fleet CLI: `hub/` (placement 1,167, hub, peer, host-admin, update, wake) + `fleet-cli.ts` | 7 | 3,965 | ~3,780 | A C E |
| J History (`sessions/`: transcript readers, search) | 11 | 2,936 | ~1,350 | A only |
| K HTTP surface: server, lifecycle-api, files/api, coordination, show | 5 | 2,332 | ~970 | A C D E F G H I J L |
| L CLI + other: cli, capture/note CLIs, doctor, importer, continue-from, rewind | 7 | 2,382 | ~2,420 | A B C F H I J M |
| M Daemon wiring (`daemon.ts`) | 1 | 967 | 0 | everything |

Direction: A, B at the bottom; C under D/E (the engine launches and observes tools); F, G, I, J, H sit on D/E/C; K and L expose them; M wires all. Group-level loops that look like cycles are placement mistakes, not real: D and E import each other's directory but not each other's files (treat D+E as one "engine core", 10.96K lines); `http.ts`/`client.ts` live in the middle but are plain utilities.

**Cycles.** There are no value-import cycles. All 17 Tether entries in the cruiser baseline are closed by `import type` edges only. Four clusters:
1. `catalog.ts` -> `root-control.ts` (type `RootLaunchOptions`) closes root-control/entries/owner-retirement/catalog.
2. `lifecycle-api.ts` <-> reboot / recovery / wake-runtime: they import the type `LifecycleApiContext`; reboot <-> recovery import each other's types.
3. `tui/registry` <-> adapters <-> `agent-state` <-> `continuity` <-> `tools` (adapters import agent-state; registry imports adapters; agent-state/tools/continuity import the registry).
4. `hub/peer.ts` <-> `hub/wake.ts` (type `WakeProgress`/`Peer`).

**Upward or odd edges to fix:** `proc-fs` -> `entry-files`; `store` + `schema` -> `tools`; `tui/delivery` -> `catalog` and -> `@aico/tasks/registry`; `lifecycle/display` -> `projects` (type only); `lifecycle/entries` -> `continuity` (constants); `model-notices` -> `waiting`; `waiting` -> `capture-cli`; `asks` -> `show`; `wake-runtime` -> `lifecycle-api`.

**Hub is a leaf.** `hub/` + `fleet-cli.ts` import outward only: `config` (`API_VERSION`, `isInstanceName`), `events` (a type), `http`, `tui/registry` (tool login data, `entryApiVersion`), `tui/sign-in-link`, `agent-admission` (host-steward's verdict reader) and `@aico/fleet/*`. Nothing in D/E/G imports hub internals; callers are `daemon`, `server`, `lifecycle-api`, `recovery` (placement), `asks` and `show`.

**Package level today:** `@aico/tether` (layer 5) bundles shared, context, fleet, tasks, tether-client into `dist/tether.mjs`. No other package imports it (web-server, jobs, cli, ops talk through the socket and `@aico/tether-client`); `ops/src/deploy.ts` only reads `packages/tether/src/config.ts` from git. `@aico/fleet` (layer 3, 4,300 lines) is the transport: link, exec, trust, identity, logins, secrets, releases, power, settings, `FleetService`. The fleet link already runs inside the Tether process (`FleetService` over the control socket); the separate `tether-link@` units were retired on purpose (2026-11-04), leaving only a compatibility unit.

## 2. Target shape

```
@aico/shared  (+ http, host-admission)           layer 0
@aico/fleet   (+ hub, placement, fleet CLI)      layer 3   transport + the hub that federates Tethers
@aico/session-engine  (new)                      layer 4   store, agent tools, lifecycle, roots, admission
@aico/tether                                     layer 5   daemon, HTTP/CLI surface, services on the engine
```

**Goes to `@aico/fleet`: group I (~4.0K lines + 3.8K tests).** Merit: one-way edges (7 outward), already depends on fleet for everything it does, hub (21 commits since September) and fleet (32) churn as often as the whole lifecycle directory (35) and the hub's tests need no tmux. It is "which machines exist, are they up, can they take this agent, update them", which is fleet. It gets its Tether-specific inputs as ports: tool logins and `entryApiVersion` (from the tool registry), `apiVersion` and the instance-name check (passed in), event type as a plain string, `Router`/`HttpError` helpers from `@aico/shared/http`, host-steward verdict reader from `@aico/shared/host-admission`. Stays in Tether: the host-admin route registration (18 lines in `registerHostAdminRoutes`, so the HTTP surface has one owner), `createHub`/`createPlacement` in `daemon.ts`, and the hub tests that build a real engine (`hub.test.ts` becomes a Tether integration test).

**Goes to new `@aico/session-engine` (layer 4): groups B, C, D, E plus the three foundation pieces they need (paths split out of `config.ts`, `events.ts`, `proc-fs`/`proc-facts`/`generation`/`env`).** About 18.8K lines + ~12.7K test lines. Merit: this is one thing with one contract (`docs/compat-contract.md`: tmux units, hook bytes, ownership); its only outward edges are `config`, `events`, `projects` and one `@aico/tasks` call, so the boundary is already nearly clean; a package turns that into a rule (layers + cruiser) instead of a habit, and 16K lines of tests run as their own Vitest project without loading hub, asks or wakes. `Store`/`schema.ts` go with it because the engine tests build their catalog from it and the migration chain is one numbered list shared by every table; splitting it would mean two DB files or interleaved migrations, which is a persisted-state change with no benefit. Tether still owns the daemon, so the DB file entry in `aico.db` (boundaries rule: one owner per DB) moves to the package that holds the schema; the asks/wakes/waits tables keep their DDL in that same file and a comment says so.

**Stays in Tether (the daemon plus services built on the engine, ~20K lines):** messaging (G), recovery/reboot (F), asks (H), history (J), HTTP surface (K), CLI + importer etc. (L), `daemon.ts`, `API_VERSION` and `show`/entry-scan config in `config.ts`.

**What NOT to move, and why**
- Messaging (wakes, waits, lane reports, deliveries; 7.3K): writes the shared DB, delivers through the engine's tool adapters, runs timers owned by the daemon, and imports five groups. A package would need three ports for one consumer. M0 only removes its reach into `lifecycle-api` and `capture-cli`.
- Recovery/reboot (2.8K): the crash and reboot contracts (`docs/crash-recovery.md`, `reboot-continuity.md`) span engine, placement, continuity and durable files. Moving it adds risk and no ownership gain.
- History (`sessions/`, 2.9K): already a clean leaf (imports only foundation). A package would just be a rename; leave it.
- Asks, show, files, coordination and the route tables: they are the owner-facing wire. Tether owns `API_VERSION` and `docs/api-v1.md`; the literal `export const API_VERSION = N` stays in `packages/tether/src/config.ts` because `ops/src/deploy.ts` reads that path from git.
- The `tether-client` hosts/sync-peers code: public client side of the same routes.
- The fleet link as its own process: the link only talks to the control socket, so it could be split, but the hub fronts the local socket (it is in the request path), the standalone link units were deliberately removed, and a deploy-time restart of Tether leaves sessions running (tmux servers have their own units). Not worth it. The package split gives no restart gain; its value is ownership, tests and enforced direction. Say so when reviewing.
- Two databases, or any change to `tmux.ts` / `ownership.ts` text (systemd-run flags and the pane-exited hook are compared byte for byte): these move verbatim or not at all.
- Dead-code note: `markers.ts` is imported only by its own test; it documents the pane-marker contract, so check it before deciding (not part of this plan).

If M4 shows the store move reaching more than ~20 importers beyond the expected ones, stop after M3 and keep M0's cruiser rules (folder-level "engine paths may not import services") as the cheaper form. Nothing before M4 depends on it.

## 3. Milestones

Every milestone is a refactor with no behavior change: **no `API_VERSION` bump, no schema bump, no route or CLI text change**. Each one lands and deploys alone; tests move with their code and may differ only in import lines (check with `git diff -M` showing renames plus import hunks).

**Common gates (every milestone).** Before: `st check` clean; record `tether sessions list --json` (ids, generations, statuses), `tether hosts`, `tether --json version`. Deploy: `st sessions may-disrupt aico`, then `st service rebuild aico --detach`; wait for the job. After, all of:
1. `tether --json version`: API 32, new build; `ssh aico-gem tether --json version` also 32.
2. `tether sessions list --json`: same ids and generations, none ended or respawned; `journalctl --user -u tether@default --since <deploy>` shows reconcile, no `recovery` or `ended`.
3. `tether hosts`: `aico` connected, identity ok, no new `identity_changed`.
4. Placement dry run: `curl --unix-socket $XDG_RUNTIME_DIR/tether/default/control.sock 'http://tether/v1/placement?mem=1073741824&cpu=1'` returns the same host verdict shape and reasons as before.
5. `tether fleet exec $XDG_RUNTIME_DIR/aico/fleet/aico/exec.sock -- hostname` prints CT 190's name.
6. Create and end a synthetic session: `tether sessions create --tool shell --name split-check`, `tether sessions end <id>`.
7. CT 190 follows through `peer-release` (15-minute job) or `scripts/peer-release.sh aico-gem aico`; afterwards steps 1, 3, 5 again. Never touch the owner's sessions.

| # | Deliverable | Files moved or changed | Public API kept | Proof beyond the gates |
| --- | --- | --- | --- | --- |
| M0 | Cut the cycles and upward edges inside Tether, no package changes | New small type files: `lifecycle/types.ts` (`RootLaunchOptions`), `lifecycle-context.ts` (`LifecycleApiContext`), `hub/types.ts`, `agent-state-types.ts` (what adapters import) and the registry lookup passed in instead of imported; inject `registered` into `tui/delivery` (daemon passes the `@aico/tasks` registry); move `waiting`'s use of `capture-cli` and `model-notices` -> `waiting` behind small functions; `proc-fs` stops importing `entry-files` | All exports keep their names (re-export where a path is imported by many) | Existing tests unchanged; cruiser baseline loses the 17 Tether `no-cycles` entries (`npx depcruise` clean without them); add rule: no value or type cycles in `packages/tether` |
| M1 | Hub prerequisites, still inside Tether | `http.ts` -> `@aico/shared/http` (HttpError, sendJson, readJsonObject, Router, listenPrivateSocket); host-steward verdict reader (`hostAdmissionPath`, `parseHostAdmission`, `readHostAdmission`, limits) out of `agent-admission` -> `@aico/shared/host-admission`; hub constructors take `{ tools: logins/entryApiVersion, apiVersion, isInstanceName }` and a string event type | Same exports from Tether paths (re-export), same HTTP bodies | `shared` tests for both new modules (move the existing `http` and admission parser tests); `hub/*.test.ts` and `placement.test.ts` pass untouched |
| M2 | Hub core to `@aico/fleet`: `hub.ts`, `peer.ts`, `wake.ts`, `update.ts`, `host-admin.ts` (logic), `fleet-cli.ts` + their tests | `git mv` into `packages/fleet/src/hub/`; fleet `package.json` exports + `aico.imports` add shared (already), no tether-client import; Tether keeps `host-routes` (the 18-line registration), `createHub` in `daemon.ts`, and `hub-integration.test.ts` | Routes, `tether hosts`, `tether fleet *` output identical | `hub.test.ts` split: unit part moves, engine-backed part stays; `fleet-cli.test.ts` moves; `daemon-fleet.test.ts` stays and passes. Extra live check: the new Tether pushes itself to CT 190 (`tether fleet push-update` via `scripts/peer-release.sh`), exercising the moved `update.ts`; fallback if it fails is `scripts/deploy-remote.sh aico-gem` |
| M3 | Placement to `@aico/fleet`: `placement.ts` + test; `recovery-placement.ts`, `recovery.ts`, `lifecycle-api.ts`, `daemon.ts` import it from fleet | `git mv hub/placement.ts` -> `packages/fleet/src/hub/placement.ts` | `GET /v1/placement`, `host: "auto"`, reservation file `placement.json` format | Placement unit tests unchanged; live: placement dry run with `cap=` and `pool=` variants match before; create a root with `host: auto` that lands on the workstation and end it |
| M4 | New `@aico/session-engine`: scaffold + foundation + store + agent tools (groups A pieces, B, C) | `paths.ts` (split from `config.ts`; Tether `config.ts` re-exports paths and keeps `API_VERSION`), `events`, `env`, `proc-fs`, `proc-facts`, `generation`, `store`, `schema`, `tools`, `tool-types`, `agent-state`, `agent-signal`, `continuity`, `model-record`, `lifecycle/tui/**`, `Project` type; `package.json` (layer 4; imports shared, context, tether-client; db `tether.db`), explicit curated `exports`, tsconfig reference, `vitest.config.ts`, root `tsconfig.json` ref, `package-lock.json`, `biome.json` blocks, `project.identity.json` `manual_worker_sources`, cruiser baseline paths, `@earendil-works/pi-coding-agent` dev dep | Tether imports from `@aico/session-engine/<name>`; DB path, `SCHEMA_VERSION` 37 and every migration text unchanged | `node scripts/boundaries.mjs` and `st check`; `tether doctor` unchanged; `sqlite3` dump of `tether.db` schema from a fresh store equals the one before the move (diff empty) |
| M5 | Lifecycle core and roots into the package (D, E) | `lifecycle/**` except `tui/` (already moved), `running-session`, `dead-shells`, `entry-agent`, `entry-files`, `memory-policy`, `memory-guard`'s pure parts; `lifecycle/testing.ts`; the 10K lines of lifecycle tests; docs: path columns of `docs/compat-contract.md`, `LIFECYCLE_HARNESS.md`, `reboot-continuity.md` | `lifecycle-api.ts` and `daemon.ts` keep calling the same functions (`configureEngine`, `bindCatalog`, `startLifecycle`, ...); `tmux.ts` and `ownership.ts` content byte-identical | Move as a pure rename; `git diff -M` shows only import lines; `invariants.test.ts`, `view-mutation-contract.test.ts`, `tmux.test.ts` pass; tmux hook and `systemd-run` flag test unchanged. Live: also a reboot-continuity dry look: `tether reboot status` and `tether recovery status` identical, kill nothing |
| M6 | Lock the boundaries and tidy | Cruiser rules: session-engine and fleet may not import `@aico/tether`; Tether imports only package exports (no deep `src` paths); no `import type` cycles anywhere; update `packages/tether/CONTEXT.md`, `README.md`, `docs/plans/codebase-cleanup` references; delete re-export shims left by M1 and M4; remove the baseline entries that no longer exist | None changed | `st check` full, `npx depcruise` with an empty Tether section in the baseline; a deploy only if shims or code changed; docs-only parts need none |

**M0 done 2026-11-07.** Commits `eedada5c` (the 17 cycles; `lifecycle/types.ts`, `lifecycle-context.ts`, `hub/types.ts`, delivery catalog and `registered` passed in by the daemon; adapters read `agent-signal` and `tool-types` instead of a new `agent-state-types.ts`) and `f6749e4a` (`proc-fs` no longer imports `entry-files`: the entry-home readers are bound by `entry-files` at load, `entryReaders` moved there, `fileTail` moved into `proc-fs`; `model-notices` no longer imports `waiting`: `aico-notice.ts` leaf; depcruise rule `tether-no-cycles`, never baselined). Deployed with HEAD `3201e4c2` (tether restarted 18:19 by a concurrent deploy; job `aico-619baaefac97` was the no-op that followed). Gates 1-7 passed: API 32 on both hosts, same session ids and generations, `aico` connected/updated with no `identity_changed`, placement verdict shape equal, `fleet exec` printed `aico`, synthetic shell session created and ended, `scripts/peer-release.sh aico-gem aico` moved CT 190 to `3201e4c2`.

Order: M0 first (it makes every later move a rename). M1-M3 and M4-M5 are independent chains after M0; run hub first (clear win, smaller), then the engine. M3 needs M2 only because `placement.ts` imports `peer`/`host-admin` types. Each agent takes one row; M4 and M5 are mechanical but wide, so M5 is not started until M4 is deployed and verified.

Context sizing: M0, M1, M3, M6 are a few hundred changed lines. M2 and M5 are mostly `git mv` plus import rewrites (script it with `sed`/`rg`, then fix what the compiler reports; do not read the moved files). M4 is the widest, mostly new config files; keep schema text untouched.

## 4. Risks

**Live contracts.** (a) `API_VERSION` stays 32 in every milestone; a bump makes the web server and `ops/deploy.ts` treat the daemon as out of date and makes the hub push updates to every peer, and `tether-client`'s `EXPECTED_TETHER_API_VERSION` must equal it (`config.test.ts`). `deploy.ts` parses `packages/tether/src/config.ts` from git, so that file and the literal line stay put. (b) Route tables, error codes and CLI usage text do not change; `server.test.ts` and `cli.test.ts` are the guard. (c) web-server, jobs, ops, cli never import Tether source, so only socket behavior matters. (d) Env names (`TETHER_*`, `AICO_*`), unit names, socket and runtime paths follow `compat-contract.md`; nothing renamed.

**Persisted state.** `tether.db` schema 37 (one migration chain, same text and order), `hosts.json`, `fleet.json`, `placement.json`, `entries.json`, `continuity.json`, `recoveries.json`, `restore.json`, `memory-guard.json`, `host-logins.json`. Their readers and writers move verbatim; a moved file must keep reading what the old release wrote and writing what the old release can read, because CT 190 may be one release behind. Verified per milestone by the fresh-schema diff and the existing store, continuity and recovery tests; the live check is that the new daemon reads the state the old one wrote (gate step 2).

**CT 190 on an older release.** It runs the previous commit's bundle until `peer-release` pushes (up to 15 minutes), and the workstation hub is new while the peer's hub is old. Wire format does not change, so the mix is safe by construction; confirm it, do not assume it: after each deploy and before the push, run gate steps 1, 3 and 5 against the old peer. The update path itself moves in M2, so a bug there can strand the peer; `scripts/deploy-remote.sh aico-gem` (ssh) is the fallback and CT 190 has no checkout, so only `dist` matters to it, not source layout.

**Deploy mechanics.** Tether restarts only if a changed path is in `manual_worker_sources`; M4 must add `packages/session-engine` (`scripts/boundaries.mjs` fails otherwise). The first deploy per milestone restarts Tether, which is expected: sessions live in tmux units and reconcile, and wakes, waits and fleet links resume; verify rather than assume (gates 2-3). New workspace packages need `package-lock.json` and a `node_modules/@aico` link before esbuild can bundle; run the managed install, then build `dist/tether.mjs` before deploying. Cruiser baseline entries are keyed by file path, so each move rewrites them; Biome and check-stage blocks are generated (`scripts/check-stages.mjs`).

**Hidden state.** The engine keeps module-level state (`bindCatalog`, `configureEngine`, `bindToolSource`, `bindAgentStates`, `setLaunchGuard`). Two copies of a module (one relative path, one package path) would silently split it; M6's deep-import rule prevents that and each move should leave exactly one import path. `lifecycle/testing.ts` and Tether tests must import the package path.

**Concurrent work.** `packages/fleet` has uncommitted edits from other sessions (`package.json`, `settings.ts`); M2/M3 agents must commit with `--paths` and not sweep them in. Do not run M0-M6 in parallel with a Tether API bump.
