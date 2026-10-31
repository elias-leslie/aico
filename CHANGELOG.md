# Changelog

## Unreleased

### Added

- `st aico create --host auto --needs mem=6G,cpu=2[,cap=live-ready]`: Tether
  picks the first host with room from live readings (Nightshift's admission
  file here; a VM's memory, PSI and CPUs plus its Proxmox node's memory and
  storage), less the owner's reserve and what placed sessions still hold, or
  refuses with `at_capacity` and each host's reason. Order and reserves live in
  `~/.config/tether/placement.json`. `st aico placement --needs ...` shows the
  decision. Tether API 10.
- Placement pools: `st aico create --host auto --pool neri-hunt --needs ...`
  (and `st aico placement --pool`) pick only from the hosts that
  placement.json `pools.neri-hunt` lists; without `--pool` the default pool
  (`order`) is used as before and leaves pooled hosts out. An unknown pool is
  refused with `unknown_pool` and the pools there are. Tether API 11.
- Lane reports: a lane started with `st aico create` tells whoever launched it
  when it finishes a turn, is blocked on a prompt, or ends, as one line pasted
  once the receiver is idle (`[Ready] lane "Store lane" finished after 6m ·
  st aico root status neri-r1`). No subscription and no check-in needed;
  turns shorter than the poll and turns during a Tether restart count, nothing
  repeats after a restart. `st aico watch LANE` / `st aico unwatch LANE` add
  or drop a receiver. Tether API 12.

### Fixed

- The first create on a VM that `st vm rollback` had just powered off no
  longer fails with `host_unavailable` ("went away while its services were
  checked"): the create now wakes the host and goes ahead.
- Blank Slate Claude Code sessions keep the user's Bypass Permissions
  acceptance (`skipDangerousModePermissionPrompt`), so they no longer stop at
  the accept screen.

### Changed

- One wake paste stays under 1800 bytes (the rest waits for the next paste),
  and no second paste goes to a session within `quietSeconds` of the last.
- `st aico wake` on a Pi session works once Pi's state is known; the docs said
  Pi was refused.
- Code the desktop and the web app share (chat view, palette, mouse shim, font
  settings, host and size-holder copy) and the Lantern tokens moved from
  `electron/shared` and `electron/renderer/tokens.css` to `shared/` at the repo
  root. The web app no longer imports anything from `electron/`.

### Removed

- The Electron desktop app is gone: floating windows, tiling and saved
  positions, the tray icon, the arcade and eyes, `aico-shell.service`, the
  `.desktop` entry, the launch and stop scripts and the Electron steps of
  `scripts/install.sh` (sandbox profile, `chrome-sandbox`). Aico is the web and
  phone app over Tether. The 2-minute waiting notice now comes from Tether.
  `AICO_STATE_DIR`, `AICO_OZONE_PLATFORM` and `AICO_PASTED_IMAGES_*` are no
  longer read. The root package no longer depends on Electron, electron-vite,
  dbus-native, resvg or the xterm add-ons.
- Tether no longer serves the old `/run/user/<uid>/aico/control.sock` and
  `gui-control.sock`. `st aico` and SummitFlow use Tether's own socket
  (`TETHER_SOCKET`, else `$XDG_RUNTIME_DIR/tether/${TETHER_INSTANCE:-default}/control.sock`);
  `AICO_CONTROL_SOCKET` and `AICO_GUI_CONTROL_SOCKET` are no longer read.
- Selection capture is gone: the browser extension (`extension/`), the desktop
  app's loopback listener on `127.0.0.1:8005` (`/health`, `/selection/send`)
  and the Indicate selection action. `AICO_SIDECAR_HOST`, `AICO_SIDECAR_PORT`
  and `AICO_EXTENSION_IDS` are no longer read. A stored Indicate pin is hidden.

## 0.2.0 - 2026-10-23

Aico, A-Term and Tether are now one product, Aico, in one repository. The web
and phone app (formerly A-Term) lives in `web/`, the Tether session daemon in
`tether/`, and the desktop stays at the root. Both imports keep their history:
A-Term's release tags are now `a-term/vX.Y.Z` (its last release was 0.2.11);
Tether had no tags. From here on `vX.Y.Z` tags and this file cover the whole
product.

Requires Tether API v1 (`tether@default`); `scripts/install.sh --start` installs
and starts it.

### Merged

- One npm workspace (root, `tether`, `web/frontend`) with one lockfile and one
  Biome version; `npm run build` builds the desktop, Tether and the web app.
- One project identity, one quality gate (`st check`), one CI workflow and one
  tag release workflow. The web app's own CHANGELOG and RELEASING notes are
  folded in here.
- The web app is called Aico everywhere you see it, with Aico's lantern icons.
  The desktop opens it at `AICO_WEB_URL` (default `https://aico.summitflow.dev`).
- Docs live in one `docs/` tree; Tether's decision records are in `docs/adr/`.
- One installer, `scripts/install.sh` (with `--dry-run`), replaces
  `scripts/aico-install.sh` and the web app's and Tether's own installers.
- Agent shares now arrive through the default Tether (`tether@default`); the
  separate agent-user Tether is no longer needed for them.

### Web app (was A-Term)

- Sessions are owned by Tether: the web app creates, attaches, ends, renames and
  switches tools through it, and the same sessions show in the desktop and the
  browser. It follows Tether's event stream to keep its views current.
- Postgres is gone; the web app keeps only view state in
  `~/.local/state/a-term/a-term.db`.
- Control mode is the only terminal transport. Notes, the prompt library and
  session recording are removed.

### Desktop

#### Changed

- Aico is now a client of Tether, the per-user session daemon. Tether owns
  tmux servers, panes, agent launch and admission, End, roots and context hooks,
  and serves the legacy `/run/user/<uid>/aico/{control,gui-control}.sock`
  sockets for `st aico` and SummitFlow. Aico connects over Tether's API v1
  (`TETHER_SOCKET`, else `$XDG_RUNTIME_DIR/tether/${TETHER_INSTANCE:-default}/control.sock`),
  checks the API version, follows `/v1/events` with reconnect and gap resync,
  and holds the GUI channel for show, position and title.
- `aico.db` now keeps only `views` (window geometry, open state, local name
  override per session ID) and `settings`. Aico never reads, writes or drops
  the pre-Tether tables (`widgets`, `tmux_servers`, `root_requests`); only
  `tether import-aico --from PATH` reads them, from an archived copy.
- The session list shows every Tether session (Aico, A-Term, CLI and root
  origins). A-Term's old pre-Tether `summitflow-<uuid>` sessions are no longer
  listed (Tether dropped its legacy session API). The separate A-Term
  federation is gone.
- Window focus claims the tmux window size through Tether's resize claim;
  desktop auto-resize is unchanged.
- The installer (then `scripts/aico-install.sh`) requires Tether API v1 or later and no longer
  installs `aico-owner.service` or the context hooks.
- `st aico ... --surface a-term` accepts the Tether-shaped root descriptors that
  A-Term's `/v1/roots` proxy now returns.
- The Python sidecar is gone: Aico's main process now listens on
  `127.0.0.1:8005` itself, with the same `/health` identity, Host and Origin
  guards and 1 MiB body cap, plus a JSON `Content-Type` check on writes
  (`415` otherwise). `POST /selection/send` types the captures at the
  last-focused widget and replies `{records, count, delivered, reason}`.
  Indicate selection sends the newest capture again from memory.

#### Removed

- The in-process lifecycle owner, `aico-owner.service`, the owner bundle, the
  lifecycle harness, the real-session smoke, `qualify-codex-admin.py`, the
  context-hook installer and `npm run check:context` (all now in Tether, or
  retired with the code they checked).
- Agent admission environment variables (`AICO_AGENT_*`); admission is
  configured in Tether.
- The titlebar context-mandate badge; Tether has no route for it yet (see
  `docs/tether-api-gaps.md`).
- Stored selection history (`selections.db`) and the sidecar routes that read
  or stored it without delivering: `POST /selection`, `GET /selection/current`,
  `GET /selection/history` and `GET /selection/events`. The existing
  `selections.db` file is left in place. `AICO_SIDECAR_ALLOW_REMOTE` and
  `AICO_SIDECAR_PYTHON` no longer exist, and the release build no longer
  bundles a PyInstaller sidecar.
- The AppImage release pipeline: the GitHub release workflow, the
  electron-builder config, `npm run dist` and the packaged-app smoke. Aico
  installs from source only.
