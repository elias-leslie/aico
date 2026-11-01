# Changelog

## Unreleased

### Added

- Launch defaults: `st aico create` without `--model` takes the model, effort,
  Codex Daybreak and (for review, verification and other) Blank Slate from
  Agent Hub's launch table (`st models route --role ROLE --tool TOOL`), and
  says what it filled in `launchDefault`. Explicit flags win; resume takes
  none. `--work-role` is checked against Agent Hub's registry, so a typo fails
  at launch.
- Delivery classes (Tether API 24, schema 28). A queued line is a wake or
  ride-along (`ride` on `POST /v1/sessions/:id/deliveries`). Ride-along lines
  never paste or wake a puller alone: they join the next wake, or the
  session's next turn (`GET /v1/sessions/:id/due?ride=1`). A lane's repeated
  went-idle line is ride-along, and a lane that already told its launcher
  during the turn that ended sends no went-idle line (`from` on a delivery).
  SummitFlow sends bare acknowledgements and `st sessions send --fyi` notes as
  ride-along.
- Delivery class fixes (Tether API 25, review of the above). A ride-along line
  never turns a queued wake ride-along, and a failed paste puts a wake back as
  a wake. A coordination request or ack to a lane counts as its launcher acting
  on it, so the lane's next went-idle line wakes again. Only a request (not an
  ack, `reply` on a delivery) hides a lane's went-idle line, and only one sent
  since the lane's previous idle. Ride-along lines are peeked and confirmed
  (`GET …/due?ride=peek`, `DELETE …/due?token=`), so a hook that times out
  loses none. A request sent in a turn whose went-idle line was still held
  never hides the next turn's line, and a ride-along line's `from` records no
  send (it moved `st aico wait`'s default since).
- Tether stops and reports a model switch (Tether API 22, schema 26). It
  follows each session's own record (Claude Code transcript, Codex rollout, Pi
  session) and treats a served model other than the launch model as a switch;
  spelling differences of the same model are not, and allowed alternates per
  tool live in `~/.config/tether/model-alternates.json` (none by default). A
  refusal fallback or a substituted model gets Escape at once (never into an
  open dialog, again if the other model keeps answering); a `/model` change is
  only reported; Claude Code pausing on a flagged request is reported as
  paused. The launcher of a lane gets one line per switch with the new model,
  the refusal category, the last commit, whether the worktree changed since,
  and how to recover (`st aico root rewind REQ`, or relaunch from a handoff;
  Codex and Pi have no rewind). A session nobody launched gets the owner a
  Nightshift notice, and Aico shows the switch above the session. New
  `POST /v1/sessions/:id/rewind` and `st aico root rewind` drive Claude Code's
  rewind list (conversation only), reading every screen back and refusing on
  any mismatch.
- Launched lanes start lean. Tether trims a session by its work role at every
  launch, from data in `tether/src/lifecycle/tui/lane-tools.json`: Claude Code
  lanes other than coordinators start without Artifact, Workflow,
  Claude-drafted feedback, Chrome and claude.ai connectors, plus
  `--disallowedTools` for tools the role didn't use in a week. A fresh lane
  drops from about 45K to 23K tokens. Coordinators and sessions nobody
  launched keep everything.
- The Health panel follows Nightshift's item stream instead of polling every
  minute. `aico-web` keeps one connection to Nightshift's `GET /api/stream`
  while at least one page listens (closed when none does, reconnected with
  backoff, a fresh one after five minutes with no bytes) and relays it at
  `GET /api/nightshift/stream`: `live` (whether that connection is up) and
  `changed` (Nightshift's items or top line moved; a batch becomes one). The
  page reads `/api/nightshift/view` again on `changed` and polls it every
  minute only while the feed is down, so a Nightshift that isn't answering
  still shows Health unknown, never OK.
- Repeat went-idle lines from a lane back off (Tether schema 25). After a
  lane's first went-idle line, the next one needs the lane idle with no turn
  for `laneRepeatQuietSeconds` (600), doubling per repeat up to
  `laneRepeatQuietMaxSeconds` (1800), so a lane waiting on its own work with
  short turns in between no longer wakes its launcher every few minutes, and
  one that stalls is still heard within 30 minutes. The receiver sending to
  the lane or arming a wait on it, a new generation, a blocked line or an
  `ended` starts over at the normal floor; the streak is kept across Tether
  restarts. Blocked and ended lines are unchanged. Log: `lane=<id> idle again:
  repeat N goes out after Ns quiet`.
- A lane's queued report lines go once the receiver has ended that lane: when
  an End names `endedBy`, the sessions it spares the `ended` line (the ender,
  and the root when the ender is the launcher) also lose that lane's
  still-undelivered went idle, blocked or exit lines through the delivery
  queue's withdraw. Delivered lines, explicit watchers, other receivers and
  Ends without `endedBy` are unchanged.
- No lane `ended` line for the session that ended the lane itself (Tether API
  21, schema 24). `st aico root end` sends End `endedBy` (the caller's own
  session) to a local Tether at 21 or later; Tether records it in the lane's
  outbox row and the reporter skips that receiver, and the root too when the
  ender is the lane's launcher, logging each skip. Explicit watchers, other
  receivers, an owner's close, an agent that exited and a remote relay report
  as before; so do outbox rows from before schema 24.
- Pi roots through a per-session entry (Tether API 20): `POST /v1/roots` and
  `st aico create --tool pi --entry NAME:ARG` run Pi through the host's
  entries.json program on every launch, with `TETHER_ENTRY_TOOL=pi`. The host
  picks each launch's conversation id (`AICO_ROOT_FRESH_SESSION_ID`, a new
  one per launch, unset again in the agent's own environment); the launch
  line gives Pi `--session-id` with it (`--session <id>` on a resume). Tether
  reads the id back from the entry process's environment and Pi's state from
  `<home>/.pi/agent/sessions/*/<time>_<id>.jsonl` by that exact id through the
  contained entry readers (a link, FIFO or replaced parent reads as nothing),
  never by scanning and never the host `~/.pi`. Explicit model, effort and
  Agent Hub context are kept for recovery, restart, wakes and reboot restore.
  A Pi root's restart with nothing to resume (entry or not) now starts its new
  conversation under a host-chosen id too, so it stays found and resumable.
  The hub sends a `pi` root's entry only to a host at API 20 or later (else
  `400 entry_unsupported`, nothing sent); the CLI checks `/v1/version` (20)
  and skips this computer's Pi provider check for an entry. No auth,
  credential or relay change.
- Entry home containment: Tether's host-side reads of an entry home (Claude
  session files, Codex rollouts and their tail, crash-recovery transcripts)
  open without following a last-component symlink or blocking on a FIFO and
  check the open descriptor is a regular file or directory inside the home
  before reading; the tailed rollout is re-checked on every read. A link or
  swapped path leading outside reads as nothing. Rollout scan limits are
  `TETHER_ENTRY_ROLLOUT_SCAN` / `TETHER_ENTRY_ROLLOUT_OPEN` (2000 / 32).
- A root's explicit launch options are kept (schema 23,
  `session_launch_options`): crash recovery, restart, wakes and reboot
  restore launch its agent with the created model, effort, Daybreak and
  Agent Hub context, for every tool, entry or not. `st aico create --entry`
  checks `/v1/version` first (15 for Claude Code, 19 for Codex).

- Codex roots through a per-session entry (Tether API 19): `POST /v1/roots`
  and `st aico create --tool codex --entry NAME:ARG` run Codex through the
  host's entries.json program on every launch (first, restart, crash
  recovery, reboot restore), as for Claude Code. The entry process carries
  `TETHER_ENTRY_TOOL`; Tether reads Codex's thread, turn and resume id only
  from the entry home's `.codex/sessions` rollouts (user thread written last;
  subagent rollouts skipped), never the host's `~/.codex`. Explicit model,
  effort and Daybreak ride the launch line's `AICO_ROOT_*` variables; the CLI
  skips this computer's Codex catalog checks for an entry. A missing or
  malformed entry, or a stored tool no entry runs, exits 78 without starting
  the agent; a host below API 19 gets `entry_unsupported` for a Codex entry
  (Claude entries still go to 15+). No login or credential handling changed.

- `st aico wait cmd [--timeout 6h] [--note T] [--key K] [--block] -- ARGV...`
  (Tether API 18): Tether runs the waiter's watcher command as the transient
  user unit `aico-wait-<ref>` (idle CPU weight, 512M, bounded by the wait's
  deadline), not started while Nightshift admission is red, and reads how it
  ended from the unit's ExecStopPost record on exit and at start: exit 0 is
  `[Ready] … succeeded`, any other end `[Wait over] … failed (exit N / signal /
  timeout / oom-kill)` or `could not start`. The unit is stopped and its files
  dropped once the wait is over or its waiter ended. The CLI gates it on
  `/v1/version` >= 18; `st aico nudge cmd REF` starts a deferred one now.
- Stale-line withdraw (Tether API 18): `DELETE
  /v1/sessions/:id/deliveries?source=` takes back a producer's undelivered
  line (one being pasted cannot be stopped, but does not come back if that
  paste fails). An ask's `[Ask] filed` line to the launcher is withdrawn once
  the ask is answered, done or withdrawn.
- Antigravity (agy) state: Tether reads an agy session's conversation database
  (`~/.gemini/antigravity-cli/conversations/<id>.db`, the conversation the
  pane's agy holds open) read-only each poll: a step waiting on the user is
  blocked (`input needed`), a step still going or a newest step no finished
  executor run covers is working, else idle (`stateSource`
  `agy-conversation`). agy sessions now take lane reports (via
  `st aico watch`), waits, deliveries and ask answers by the gated paste;
  `wait_unsupported` / `delivery_unsupported` no longer apply to them. agy's
  bare `>` prompt reads as an empty input line.
- `TETHER_LIFETIME_BOUNDARY=container`: a Tether inside a supervised long-lived
  container treats the container as the lifetime boundary instead of host
  logind Linger, once it verifies it is in a container, its user manager is up
  and its own cgroup is under its UID's `user@UID.service`. Managed pane and
  cgroup ownership checks are unchanged. Unset keeps the Linger check; any
  other value refuses startup.
- Deliveries (Tether API 16): `POST /v1/sessions/:id/deliveries {source, line}`
  queues one line on a session's gated delivery queue (the one lane reports and
  waits ride), coalesced by source while undelivered; `GET /v1/deliveries/:id`
  says `queued`, `delivered` (via paste, turn or native) or `dropped`.
  SummitFlow's coordination inbox moves its pane typing onto it. Native
  pullers: `GET /v1/sessions/:id/due?wait=55` hands a session's due lines to
  Claude Code's asyncRewake hook or Pi's extension while one is attached,
  instead of pasting. Schema v21.
- Wait pull kinds (Tether API 17): `st aico wait job|reply|run|ask|host|tap
  REF` waits on a SummitFlow service job (`done`), a coordination request you
  sent (`acked`, `closed`), a workflow run (`finished`, `needs-you`), an owner
  ask (`answered`), a hub host (`connected`) or a Nightshift tap (`decided`),
  read from each owner read-only (files watched, a 60 s look; a job whose
  runner died is asked of `st service result` as an idle-weight unit, never on
  red admission). `POST /v1/waits/check` / `st aico nudge KIND REF` re-reads at
  once. A run's pause and an ask's answer now ride the event queue, and a wait
  on the same thing by the session already told fires without a second line.
  `--until ended` on a session that already ended fires at once instead of
  `404`; waits that are over are pruned also with nothing armed. Aico web's End
  dialog offers keeping waits alone.
- Asks from ended lanes (schema v22): an ask records the session that launched
  the asker; its answer goes there once the asker has ended (`answerTo`, shown
  on the ask card); a lane filing an ask tells its launcher in one line; a
  session ending with open asks hands them to its launcher in one line.
- The native pullers themselves: `tether/scripts/aico-due.py`, run by
  claude-config's `hooks/aico-due.sh` asyncRewake hook (exit 2 with the lines
  wakes Claude), and Pi's `tether/integrations/pi/aico-due.ts` extension
  (`sendUserMessage` follow-up), linked as `~/.pi/agent/extensions/aico-due.ts`.
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
- Placement on this computer's containers and on a named host:
  placement.json `hosts.<name>.room: "local"` judges a host that runs on this
  computer (a Neri hunt container) by Nightshift's reading and this computer's
  reserve, with its reservations and this computer's counted once as one room;
  a sleeping one with `wake` fits by that room and is woken by the create.
  With `capabilitiesOn: "local"` its capabilities (live-ready) are probed on
  this computer, which owns the slot's sandbox and proxy, asleep or running.
  `st aico create --host NAME --needs ...` (`POST /v1/roots` `host` + `needs`)
  rechecks that host and holds its reservation before the create goes there,
  or answers `at_capacity` with its reason; release is unchanged (only on a
  definite end). Default-pool behaviour is unchanged. Tether API 14.
- Per-session entry: `POST /v1/roots` `entry: {name, arg}` runs a Claude
  Code root through the program `~/.config/tether/entries.json` names on the
  host that runs it (`<argv> <arg> -- /bin/sh -c '<line>'`), on every launch
  including restart, crash recovery and reboot restore, so a Neri hunter runs
  inside its hunt container from its first instruction. Its state, resume id
  and transcript are read from the entry's `home` (container pids, no hooks);
  an unknown name is `unknown_entry`, a malformed one is refused with the
  reason, and a launch whose entry left entries.json exits instead of running
  on the host. Kept wakes never restart such a session. Schema v20, Tether
  API 15.
- Lane reports: a lane started with `st aico create` tells whoever launched it
  when it finishes a turn, is blocked on a prompt, or ends, as one line pasted
  once the receiver is idle (`[Ready] lane "Store lane" finished after 6m ·
  st aico root status neri-r1`). No subscription and no check-in needed;
  turns shorter than the poll and turns during a Tether restart count, nothing
  repeats after a restart. `st aico watch LANE` / `st aico unwatch LANE` add
  or drop a receiver. Tether API 12.
- Waits: `st aico wait session ID|REQ [--until finished|idle|blocked|ended]
  [--timeout 2h] [--note T] [--key K]` tells an agent with one line when
  another session is ready, or that the wait timed out, instead of a check-in
  at a guessed time. A session that is already ready fires at once; each wait
  fires once, and only a cancel is quiet. `--block` holds the command and
  prints the line, for subagents and agents outside Aico. `st aico waits`,
  `st aico wait cancel`, and `st aico wait time` (= `st aico wake`).
  Tether API 13.

### Fixed

- A lane's went-idle line wakes its launcher again after a message reached
  the lane. A request sent while the lane was finishing a turn, then pasted
  after the lane's went-idle line, used to leave the end of that work as a
  ride-along repeat, so the launcher was never woken. Tether now counts what
  reaches a lane when the lane gets it: a pasted or taken line (not its own
  wait lines or an agent's check-in), a send typed into it, or its own reply.
  Repeats with nothing in between still ride along.
- A lane that asked its launcher something earlier in a turn, then answered
  the launcher with a ride-along yes, still sends that turn's went-idle line,
  so the launcher wakes to the answer. The ride-along reply clears the lane's
  "told" mark.
- Placement releases the reservations held on a host taken out of
  hosts.json, so they no longer show as open forever (it logs each one).
- Lane lines go to the session that launched the lane, not the root
  coordinator. A lane's went idle, blocked and ended lines (and model-switch
  lines) go to its launcher only; the root gets them when it launched the
  lane, or in place of a launcher that has ended or whose agent exited. A
  session on another host launched by a lane here tells that lane. A
  receiver with its own session wait on the lane that fires on the event,
  including a `--block` client's (Tether schema 27 keeps its session as
  `waits.armed_by`), hears it from the wait and gets no line, and nobody
  stands in (a `--block` client only while it is still asking). A launcher
  here that ends its session on another host no longer gets that session's
  ended line: `st aico root end` names it in the `Tether-Ended-By` header
  (Tether API 23) and the hub keeps it for the relayed end. Before, every
  ended and blocked line from a lane's helper also woke the root, and a lane
  waiting on its hunters heard each one twice (Neri coordinator, 2026-11-01).
- agy state: a step left RUNNING (a background command, an abandoned row) no
  longer pins an agy session working once the run covering the newest step has
  ended; an old waiting step a later run passed is not blocked. A conversation
  with no steps or no database yet reads idle with no time, not unknown. Tether
  looks at the agy process's own files every poll, so a first prompt or a
  conversation switch is seen at once; the presence lock wins over another
  conversation's open database. A draft line that is just `>` is no longer
  taken for agy's prompt mark (it counts only under the input box's rule).
- `wait cmd`: a wait that ends while its unit is still starting stops the unit
  once the start returns; none starts past its deadline; a start that failed
  or timed out still stops any unit it left; a late result after a slow stop is
  swept. A watcher systemd stopped at its runtime limit reads as the wait timing
  out, not failing.

- Agent waits P2 review fixes (Tether API 17, schema v22): an ask's answer goes up the chain (asker while it is there, even with its state unknown; else its launcher; else its coordinator, now recorded); a launcher that ends hands on the asks it holds; an answer queued to a session that ends before it goes out is queued again to the next one up. A run a wait is armed on is read by id after its launcher ended or Tether restarted, and how runs ended is kept across restarts; a `needs-you` run wait goes quiet only once the pause note is queued to the waiter. A delivery being pasted reads `queued`, not `dropped`; a native poll whose client has gone takes no line; `due?wait=0` holds nothing; a source over 120 characters is a 400. The hand-off line fits `noteMaxChars`. `st aico wait`/`nudge` report Tether down as unreachable, not too old. Pi's puller runs only interactive, one per session, waits after an empty answer, and hands Pi a line Tether already gave it even while stopping.
- The first create on a VM that `st vm rollback` had just powered off no
  longer fails with `host_unavailable` ("went away while its services were
  checked"): the create now wakes the host and goes ahead.
- Blank Slate Claude Code sessions keep the user's Bypass Permissions
  acceptance (`skipDangerousModePermissionPrompt`), so they no longer stop at
  the accept screen.

### Changed

- Tether's memory guard reads Nightshift's `memory_state` when admission.json has it: Nightshift's `state`
  now also goes amber/red on low disk, which must not warn about memory or kill a tool job. Placement on
  this computer closes on an amber or red disk, agent launches and `wait cmd` starts on red; crash recovery
  no longer waits on a disk-only amber and says "host admission" in its waiting reason.
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
