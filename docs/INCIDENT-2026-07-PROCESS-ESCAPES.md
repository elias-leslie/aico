# July 2026 process-containment incident

Status: confirmed. The Aico and shared Codex ownership repairs are deployed; a
second hardware-Xorg launch on 2026-07-13 proved that the Codex cleanup boundary
works, while also proving that containment is not permission to run direct Xorg
against the operator workstation's GPU or virtual terminals.

This document records the evidence and recovery boundary for the two processes
that destabilized `davion-sidarli`. It is intentionally specific: process names,
age, or CPU usage alone are never cleanup authority.

## Impact

- One `node --input-type=module -` process consumed one core for roughly two days.
- A stale root Xorg `:99` retained a real virtual terminal and prevented GDM's
  normal Xorg login. GDM fell back to Wayland and the display fell from DP-0 at
  5120×2160/120 Hz (8192×3456 scaled desktop) to DP-4 at 2560×1080/60 Hz.
- The shared legacy Aico application scope reached about 13.3 GB peak memory,
  2.1 GB peak swap, and 605 tasks. Unrelated durable sessions shared that scope,
  so stopping it would have destroyed user work and was not an acceptable repair.
- At 18:27 EDT on the same day, an Aftertimes performance execution launched a
  new privileged Xorg `:99` against the physical AMD GPU. The normal Xorg lost
  DRM master, Electron/Chromium GPU contexts reset, and the display remained
  black after the offending tree was removed. The operator then authorized
  graphical-login recovery; a fresh GDM-managed Xorg/GNOME session restored the
  desktop without terminating the separately managed tmux server or its three
  durable sessions.

## Exact creation paths

### Runaway Node

- Aico widget: `906cd339` (`aico-906cd339`).
- Codex session: `019f5254-99b7-70f2-9b74-ca45c487f29a`.
- Transcript:
  `~/.codex/sessions/2026/07/11/rollout-2026-07-11T13-58-23-019f5254-99b7-70f2-9b74-ca45c487f29a.jsonl`.
- Line 229 launched a here-document through the code-mode `functions.exec` path:

  ```js
  node --input-type=module - <<'NODE'
  for (const blanks of [10,20,30,40,50,60,70,80,100,200]) {
    const text = 'start\n' + '\n'.repeat(blanks) + 'end\n'
    const start=performance.now()
    const out=text.replace(/[ \t]*\r?\n(\s*\r?\n)*\s*$/,'')
    console.log(blanks, (performance.now()-start).toFixed(3), JSON.stringify(out))
  }
  NODE
  ```

- Line 230 returned an ongoing cell after ten seconds. Line 233 requested
  `wait(..., terminate: true)`; line 234 reported completion after printing only
  the 10- and 20-blank cases.
- Stdin was not left open. The shell consumed the complete here-document and
  Node entered catastrophic regex backtracking at the next input size.
- The unified-exec terminator targeted the wrapper/process group. A detached or
  reparented descendant was no longer in that kill boundary, and the broad Aico
  cgroup had no per-execution identity with which to reconcile it. Its generic
  stdin-driven argv also provided no command provenance after the transcript was
  no longer in view.

### Stale Xorg

- Aico widget: `d24ad045` (`aico-d24ad045`, project `the-aftertimes`).
- Originating Codex session: `019f5961…`; delegated performance session:
  `019f5bc2-0de3-7ac1-b82e-41e94f6307ad`.
- Transcript:
  `~/.codex/sessions/2026/07/13/rollout-2026-07-13T09-54-32-019f5bc2-0de3-7ac1-b82e-41e94f6307ad.jsonl`.
- Line 120 launched:

  ```text
  nohup env -u DISPLAY sudo -n /usr/lib/xorg/Xorg :99 -noreset -nolisten tcp -ac \
    -config …/xorg-amd.conf -logfile …/Xorg.log </dev/null >…/xorg-stdout.log 2>&1 &
  ```

- `nohup`, backgrounding, and passwordless `sudo` deliberately severed shell
  lifetime. No trap or owning transient unit was created. The root Xorg remained
  in Aico's broad application cgroup after its launcher and agent work ended.
- Direct Xorg was not headless merely because it used display `:99`. It opened
  the host GPU, input devices, `/dev/tty0`, and VT1; its own log confirmed the
  acquisition. Console flags alone are not an isolation boundary. Graphical
  tests must use Xvfb or an isolated virtual/dummy GPU that cannot acquire a
  host VT, and must remain inside the execution's cleanup scope.

### 18:27 recurrence after containment deployment

An Aftertimes agent launched a second root Xorg at approximately 18:27:30 EDT:

```text
sudo -n /usr/lib/xorg/Xorg :99 -noreset -nolisten tcp -ac \
  -config /srv/workspaces/projects/the-aftertimes/.dev-tools/agent_runs/2026-07-13-overworld-redesign-performance-final-5d06cb83/xorg-amd.conf \
  -logfile /srv/workspaces/projects/the-aftertimes/.dev-tools/agent_runs/2026-07-13-overworld-redesign-performance-final-5d06cb83/Xorg.log
```

This execution was attributable to the exact deployed Codex scope:

```text
codex-exec-16689-exec-4753744b-8018-40a6-b24e-67da75342056-10546-df02360b49d1eb74-214.scope
```

The root Xorg was PID 47906. Its execution also contained launcher PID 47427,
performance Python PID 48148, and game PID 64010. The operator's normal Xorg
(PID 6743) logged `drop master for 226:2` and removed input devices while GDM
created unsuccessful greeter sessions. Aico/Electron logged
`GL_GUILTY_CONTEXT_RESET_KHR`. These observations establish the mechanism: the
second server selected the real DRM device and displaced the already-running
desktop server; `:99` changed only the display number.

Stopping that one verified execution scope removed the launcher, root Xorg,
Python process, and game process; its cgroup subsequently reported
`populated 0`. No peer Codex execution, tmux pane scope, tmux server, or durable
session was stopped. This is real-runtime evidence that per-execution containment
now handles privilege transition, reparenting, and whole-tree cleanup.

The cleanup did not undo GPU/display-server disruption that had already occurred.
The old desktop Xorg could again answer display queries, but the user still saw a
black screen. After the offender was proven gone, the user explicitly authorized
GDM recovery; the fresh graphical session restored the display. That restart was
a recovery action for an already-damaged graphical stack, not the lifecycle fix
and not an acceptable first troubleshooting step.

The prevention boundary is therefore stricter than the cleanup boundary:

- Use unprivileged Xvfb when a test needs only the X protocol or software
  rendering.
- Use an isolated VM/Proxmox target when a test needs real Xorg, DRM, a compositor,
  GPU drivers, fullscreen behavior, or representative GPU performance.
- Never launch direct hardware Xorg on the operator workstation, with or without
  `sudo`; never treat a high display number, `-nolisten tcp`, or an execution
  cgroup as display/GPU isolation.

## Root lifecycle failure

The Electron application, durable tmux server, agent roots, temporary tools,
browser/test helpers, and privileged children all inherited one desktop-created
`app-aico-*.scope`. tmux assigned a narrow pane scope asynchronously, but Aico
started the TUI in the `new-session`/`respawn-pane` command itself. The TUI could
fork before tmux moved the pane root, leaving the agent and everything it later
spawned in the broad application scope. Process groups and parent-death signals
do not survive every `setsid`, fork, reparent, or setuid transition; cgroup
membership does.

The first containment revision exposed a second lifetime coupling during an
isolated runtime check: `systemd-run --user --scope` moved a caller-spawned tmux
process into a durable scope, but that process retained Electron/Chromium file
descriptors. After Electron was forcibly terminated, the durable tmux server
still held the synthetic Chromium debugging listener on `127.0.0.1:19223`.
Moving a process to another cgroup changes accounting and signal ownership; it
does not sanitize its inherited descriptor table.

## Repair boundary

Aico now:

1. Adopts the canonical historical socket read-only, and starts new work on an
   immutable private tmux-server generation. New generations are spawned by
   the systemd user manager as transient `.service` units with null stdin,
   journal output, exact argv expansion disabled, and `ExitType=cgroup`; they
   do not inherit Electron's descriptor table and remain active across tmux's
   daemonizing fork. Existing managed `.scope` generations remain valid
   identity evidence and are not restarted merely to migrate them. Aico
   verifies the server PID,
   `/proc` start time, exact control group, systemd InvocationID, absolute
   socket, and roster PID before interpreting session presence or absence.
2. Creates each pane as a bare shell, waits for tmux's narrow
   `tmux-spawn-<uuid>.scope`, verifies its exact control group/InvocationID, then
   launches the TUI. Failure to prove containment blocks the workload.
3. Persists stable server/session/pane IDs, current and former scope identities,
   launch intent, and a one-use gate dispatch nonce. Replacement and startup
   reconciliation are generation-checked and fail closed on unknown state; a
   dispatched gate is never auto-replayed after a crash.
4. Stops only the exact owned pane scope. If a sudo/root descendant prevents the
   user manager from signaling the tree, it writes that already-validated
   cgroup's `cgroup.kill` and verifies it empty. Directory device/inode identity
   prevents a removed/recreated cgroup race.
5. Preserves all lifecycle-v0 sessions read-only. Users create a new managed
   widget and move work deliberately; Aico never respawns or broad-kills the
   historical application scope merely to force a migration.
6. Installs a generation-specific tmux `pane-exited` hook that synchronously
   writes a durable runtime marker. An in-process filesystem watcher retains it
   as level-triggered crash evidence, coalesces events, defers busy widgets until
   their lifecycle operation releases, and leaves no long-lived helper process.
7. Requires `Linger=yes` before creating durable work, so graphical logout does
   not tear down the user manager or intended tmux sessions.

A-Term discovers both the historical socket and validated active generation
sockets through read-only SQLite access. Generation-qualified source IDs prevent
same-name sessions on different sockets from colliding.

The shared Codex unified-exec repair applies the same finer-grained cgroup
principle to each temporary tool execution. It is required for cancel/completion
cleanup without retiring the durable agent session itself.

### Shared Codex launcher deployment

- The shared Codex repair is commit
  `448b1493346fbb82ae1a1b2d846622347f54ca4f` on branch
  `fix/linux-execution-containment`.
- The installed native binary has SHA-256
  `e7c5941f39c8162473d3a5647084d9159a8190ac1a104996952c426aa2f9ee13`.
  The pre-deployment binary is preserved at
  `~/.local/share/codex-rollbacks/0.144.3-448b149/` with SHA-256
  `37e6f5953f191b04f7b62cb07dae90f51d0947ad89f0355665b421fbde28700b`.
- Each covered execution receives a stable execution ID, an owning transient
  systemd scope, structured ownership logs, an owner-liveness pipe, and exact
  scope cleanup. `cgroup.kill` removes descendants that fork, call `setsid`,
  reparent, or cross to root through `sudo`, without touching the durable agent
  or another execution.
- Five lifecycle regressions passed: normal completion, cancellation, peer
  isolation, owner EOF/parent loss, and a root `sudo` child. The execution-scope
  manager regression also passed.
- Deployment was inode-safe: Codex processes already running at installation
  kept the previous executable inode and were not interrupted. New Codex starts
  use the patched binary; an existing durable session gains this protection when
  its Codex process is next restarted.

This deployment currently covers Linux local **non-TTY unified exec with empty
inherited file descriptors**. It does not yet claim containment for PTY or
inherited-FD executions, MCP/browser tool hosts, or a child that deliberately
migrates itself to another cgroup. A package update can replace the host hotfix
until the branch is released through the normal Codex distribution channel.

## Safe recovery

1. Copy the affected widget's **Session diagnostics** and inspect its stable
   session/scope/InvocationID and resources.
2. Confirm the process belongs to that exact execution or pane scope. Do not use
   process name, elapsed time, or CPU alone.
3. Stop only the exact temporary execution or pane scope through its owner.
4. Verify `cgroup.events` reports `populated 0`, the specific PID is gone, and
   peer tmux sessions still exist and reconnect.
5. For a legacy process with no trustworthy narrow owner, preserve peer sessions
   and investigate transcript/parent/cgroup evidence manually. Never stop the
   broad Aico, user, graphical-session, or GDM scope as a shortcut.
6. Remove a stale test Xorg through its proven execution scope first. Verify
   `cgroup.events` reports `populated 0`, `/tmp/.X11-unix/X99` and the exact Xorg
   PID are gone, and tmux peers remain. Do not edit display configuration, GDM
   policy, or desktop extensions.
7. If the offender is gone but the physical display remains black, graphical
   recovery may require restarting the damaged GDM-managed Xorg/GNOME session.
   Do so only with explicit operator authorization and only after preserving and
   rechecking the separately managed tmux roster; never use it as the initial
   cleanup or substitute for fixing the unsafe launcher.

## Regression evidence

`scripts/aico-lifecycle-harness.sh` uses a collision-checked private tmux socket
and synthetic `sleep` trees. It covers bare-pane placement, detached `setsid`
children, attachment crash/reconnect, pane replacement, parent crash, exact
scope cleanup, peer isolation, server durability, and zero residue. See
[`LIFECYCLE_HARNESS.md`](LIFECYCLE_HARNESS.md).

The shared Codex regressions separately cover the temporary unified-exec
boundary described above: five lifecycle cases plus the scope-manager test.

## Host verification before the 18:27 recurrence

These host checks were performed without opening, stopping, or renaming the
production tmux server. The host booted at `2026-07-13 18:18:08 EDT`; that boot
removed the earlier `/tmp`-backed isolated test state, so the synthetic harness
was rerun against a newly generated private socket after boot.

### Before and after accounting

| Boundary | Incident baseline | Pre-recurrence observed state |
| --- | --- | --- |
| Desktop/Aico runtime | One broad scope: 605 tasks, 4.8 GB current/13.3 GB peak memory, 1 GB current/2.1 GB peak swap | `aico-shell-runtime.service`: 91 tasks, 395 MB current/401 MB peak memory, zero swap |
| Durable tmux server | Inherited the desktop process tree and could retain Electron descriptors | `aico-tmux-server-403a7acfd6200f748efa5dfe4e4fb500.service`, PID 8636, parented by the user manager, 15 descriptors, zero Electron resource or Aico user-data descriptors |
| Durable sessions | Shared the broad application scope | Three separately owned `tmux-spawn-<uuid>.scope` units with distinct InvocationIDs and explicit widget/project/session metadata |
| Confirmed residue | Runaway stdin Node and stale root Xorg `:99` | No matching Node, root Xorg/Xvfb, harness marker, isolated UI marker, or temporary lifecycle unit; swap remained zero |

The three production sessions were identical immediately before and after the
final harness run:

```text
aico-906cd339|$1|1783981135|1
aico-bc6056c3|$0|1783981135|1
aico-d24ad045|$2|1783981135|1
```

Harness run `final-1783981474-39090` created two private sessions, three pane
scopes, and three detached `setsid` children. It exercised attach-client crash,
real reconnect, pane replacement, parent crash, old-scope cleanup, and peer
isolation, then reported `passed=true` and `residue=0`. The production roster
above was unchanged.

An isolated real Electron run supplied the separate UI/crash evidence. Its new
manager-spawned tmux service held 9 descriptors versus 78 on the deliberately
retained caller-spawned comparison server, held no Electron/user-data file and
no Chromium debug listener, and survived forced Electron-main termination.
The debug listener was released, the durable session reattached through a new
Electron process, and detached user and `sudo` children remained attributable
to the exact pane scope. Exact root-descendant removal is additionally covered
by the deployed Codex execution-scope regression; the final harness uses only
unprivileged synthetic sleeps by design.

The rebuilt production UI was then inspected as the running Electron
application: all three windows rendered and remained attached, the Aico window
was captured at 3560×3360, and the sidecar health probe returned HTTP 200. At
that checkpoint there was no uncaught exception, unhandled rejection, renderer
error, fatal error, or failed lifecycle operation. Two one-time xterm idle-queue
warnings (153–154 ms) and the host's non-fatal Mesa loader warning remained.

That clean checkpoint must not be read as a zero-runtime-error claim for the
remainder of the boot. The later Aftertimes hardware-Xorg recurrence caused
documented Electron GPU context resets and a black desktop. Exact scope cleanup
removed the new privileged execution without tmux loss, but the user-authorized
GDM recovery was still needed to recreate the damaged graphical session. The
production tmux roster remained:

```text
aico-906cd339|$1|1783981135
aico-bc6056c3|$0|1783981135
aico-d24ad045|$2|1783981135
```
