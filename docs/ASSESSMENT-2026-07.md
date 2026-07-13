# Aico engineering and product assessment — July 2026

## Verdict

Aico is a useful Linux desktop control surface around durable tmux sessions,
but the incident baseline was **not best-in-class**. Its strongest product idea
is the combination of small reconnectable terminal widgets and deliberate
context delivery into the user's existing CLI agents. Its weakest property was
the one users must trust most: Aico could not explain or end temporary process
trees without risking unrelated durable work.

The containment repair changes that boundary rather than hiding symptoms:
durable tmux servers, durable panes, temporary Codex executions, desktop
runtime processes, and external sessions now have distinct identities and
lifetime rules. The three historical sessions remain deliberately read-only
from a lifecycle perspective; absence, collision, or ambiguous identity always
preserves work.

## What Aico is and what it should become

**Today:** an Electron/xterm desktop companion whose widgets attach to tmux,
launch terminal agents, accept browser/desktop context, and remain available
from a tray and A-Term.

**Target:** the trustworthy local supervisor for multiple long-running agents:
every process explains its widget, project, server generation, pane, execution,
resource use, and cleanup authority; crashes degrade to a recoverable state
without broad kills or desktop disruption.

## Evidence-based strengths

- tmux is the durable source of terminal truth; closing a window detaches rather
  than terminating work.
- Stable widget records and explicit external-session records support reconnect.
- Agent launch definitions are centralized and continue to use configured agent
  slugs rather than provider/model IDs.
- Context capture is on demand rather than an always-on screen recorder.
- The managed service separates Electron/Chromium/sidecar lifetime from durable
  user scopes and requires user lingering for normal logout durability.
- Lifecycle diagnostics expose exact identifiers and systemd accounting instead
  of treating a process name or age as ownership.

## Incident root-cause map

See [the incident report](INCIDENT-2026-07-PROCESS-ESCAPES.md) for exact commands
and transcript locations.

1. Aico started tmux, agent roots, and temporary tools under one desktop
   `app-aico-*.scope`.
2. The real TUI was supplied during `new-session`/`respawn-pane`, before tmux's
   asynchronous per-pane cgroup move completed. A fork could therefore remain
   in the broad desktop scope.
3. Codex unified exec cancelled a wrapper/process group, not an immutable
   per-execution cgroup. `setsid`, reparenting, or privilege transition could
   outlive that boundary.
4. The Node incident received complete stdin and then entered catastrophic
   regular-expression backtracking. Generic stdin-driven argv carried no owner.
5. The Xorg incident deliberately used `nohup`, backgrounding, and `sudo`
   without an owning unit. Display `:99` did not make direct hardware Xorg
   headless; it acquired a real VT and blocked GDM's Xorg login.
6. No durable execution ID, cgroup identity, or startup reconciliation record
   remained with either escaped process. Broad Aico cleanup was unsafe because
   it also contained unrelated sessions.
7. A second Aftertimes launch at 18:27 EDT used `sudo -n` to start direct Xorg
   `:99` with a generated AMD config. It displaced the normal Xorg's DRM master,
   caused Electron GPU context resets, and left the physical display black. The
   deployed Codex execution scope identified and removed the complete privileged
   tree without harming tmux peers, but cleanup could not reverse disruption
   already inflicted on the graphical stack; operator-authorized GDM recovery
   was subsequently required.

## Ranked findings and disposition

| Severity | Finding and impact | Root repair | Verification |
| --- | --- | --- | --- |
| Critical | Temporary Node/root-Xorg descendants could escape cancellation and destabilize the host. | Codex per-execution systemd scopes plus exact `cgroup.kill`; Aico gate-first pane launch and exact pane scopes. Direct hardware-Xorg tests are prohibited on the operator host and must use Xvfb or an isolated VM according to test needs. | Detached, setsid, root, cancel, parent-crash, and isolation regressions; the 18:27 recurrence's exact scope removed root Xorg, Python, game, and launcher processes with `populated 0` while all three tmux sessions survived. |
| Critical | One broad scope mixed Electron, durable sessions, agents, and tools. | Managed desktop service, immutable tmux-server generations, stable pane/session IDs, and per-execution identities. | Compare cgroups/InvocationIDs and preserve peer tmux roster across restart/retire. |
| High | A caller-spawned durable tmux `.scope` inherited Electron/Chromium descriptors and could retain a listening socket after Electron died. | New generations are user-manager-spawned transient `.service` units with clean stdio and `ExitType=cgroup`; existing `.scope` generations remain compatible. | Kill only an isolated Electron parent, compare the tmux server FD table, and prove the synthetic debugging port is released while tmux remains reconnectable. |
| Critical | Cached/name-only tmux absence could target the wrong generation after socket replacement. | Fresh roster PID + persisted PID/starttime/cgroup/unit/Invocation classification before absence-authorized cleanup. | Socket collision and transport-failure tests; destructive paths fail closed. |
| High | Legacy rows or same-name sessions could be recreated/rebound silently. | `legacy-unclassified` state, write-once stable IDs, and no cross-live-generation rebind. | Migration, renamed/name-reuse, and generation-CAS tests. |
| High | A crash around a typed gate launcher could replay or corrupt launch input. | Input suppression during lifecycle changes, recursive cgroup inspection, `C-u`, verified gate intent, and persisted one-use launch dispatch nonce. | Partial line, extra descendant, stale CAS, and crash-point tests. |
| High | A detached pane could die while Aico stayed open and leave descendants until restart. | Managed-server `pane-exited` hook, durable generation event marker, in-process watcher, and exact reconciliation. | Closed-widget detached-child runtime test; peer session remains. |
| High | A closed dead session could not heal when reopened. | Exact absent-row reconciliation under the widget lifecycle token before recreation. | Reopen without Aico restart; dead binding clears only after exact scope cleanup. |
| High | A-Term assumed every Aico session used the historical socket. | Read-only discovery of validated active Aico generation sockets with generation-qualified source IDs. | A-Term unit suites, real synthetic socket, API/browser verification. |
| High | Sidecar/voice/browser boundaries accepted more unbounded or untrusted input than needed. | Loopback/origin validation, bounded payloads/concurrency, transcript redaction, media permission restriction, and managed cleanup. | API/WebSocket/runtime browser tests. |
| Medium | Startup repeated server probes per widget. | Reuse one freshly verified server roster for positive startup presence; re-probe immediately before destructive absence cleanup. | Many-widget probe-count regression. |
| Medium | Resource warnings are mostly diagnostic/on-demand, not proactive. | Keep exact accounting and add warning-only event sampling after lifecycle correctness; never auto-kill by age/name. | Synthetic CPU/memory/swap pressure surfaces one owner and no kill. |

## Security and reliability boundaries

- Durable user sessions are preserved indefinitely unless the user explicitly
  retires a **managed and exactly verified** session.
- Historical lifecycle-v0 work is attachable but cannot be respawned or retired
  automatically; its former descendants cannot be attributed safely.
- External tmux sessions are attach-only. Forgetting an attachment never kills
  the external server or session.
- A managed socket collision, unreachable live server, split pane, changed
  InvocationID, malformed roster, or incomplete cgroup evidence blocks mutation.
- Privileged descendants are removable only through the already-validated
  narrow cgroup. A process name, age, PID alone, or broad application scope is
  never cleanup authority.
- Containment is not hardware/display isolation. Xvfb is the allowed host path
  for X-protocol/software-rendering tests. Work needing real Xorg, DRM, GPU
  drivers, a compositor, fullscreen behavior, or representative GPU performance
  belongs in an isolated VM/Proxmox target, never in a second direct Xorg on the
  operator workstation.
- A dispatched-but-still-gated launcher is preserved rather than replayed after
  a crash. An explicit replacement can supersede a recursively verified
  singleton gate, but an unresolved same-scope pending generation remains
  blocked. This trades automatic recovery for at-most-once safety.

## Roadmap

### Phase 0 — host safety (implemented in this repair)

- Immutable server/session/pane ownership and gate-first launch.
- Exact whole-tree cleanup and crash/startup reconciliation.
- Codex unified-exec containment and deployment.
- Detached-pane event reconciliation.
- A-Term multi-socket compatibility.
- Managed service and sidecar/input hardening.

The Codex portion is deployed from
`448b1493346fbb82ae1a1b2d846622347f54ca4f`. The installed native binary
SHA-256 is
`e7c5941f39c8162473d3a5647084d9159a8190ac1a104996952c426aa2f9ee13`; the
preserved pre-deployment rollback SHA-256 is
`37e6f5953f191b04f7b62cb07dae90f51d0947ad89f0355665b421fbde28700b`.
Five lifecycle cases (normal completion, cancellation, peer isolation, owner
EOF/parent loss, and a root `sudo` child) and the scope-manager regression
passed. Installation did not restart active Codex processes: existing sessions
continue on their old executable inode until their Codex process restarts, while
new starts use the patched binary.

### Phase 1 — operator trust

- A hub view aggregating current and peak CPU, memory, swap, task count, age,
  server health, pending cleanup, and launch state for every widget/execution.
- Warning-only notifications for exact scopes crossing evidence-based pressure
  thresholds; link directly to diagnostics and targeted recovery.
- Explicit, identity-verified tmux socket recreation for a live-unreachable
  generation and a guided copy/move workflow for historical sessions.

### Phase 2 — agent supervision

- First-class Agent Hub session/profile/routing visibility by agent slug.
- Per-execution cancellation state and provenance surfaced beside terminal work.
- Backpressure/flow metrics for high-output PTYs and browser/test workloads.

### Phase 3 — broader distribution

- Validate the systemd/cgroup contract in the shipped AppImage and document
  supported distributions/tmux builds.
- Accessibility audit for keyboard traversal, screen readers, reduced motion,
  contrast, and multi-monitor responsive placement.

## Tempting changes not to pursue

- No watchdog that kills by process name, elapsed time, CPU, or memory alone.
- No arbitrary session TTL or unattached-session reaper.
- No broad kill of `app-aico-*`, the user manager, tmux server, GDM, or the
  graphical session as initial cleanup or a root-cause repair. After exact
  offender removal and tmux preservation are proven, an explicitly authorized
  GDM restart can be a last-step recovery for an already-damaged graphical stack.
- No display-resolution, `monitors.xml`, GDM, Wayland/Xorg-policy, or extension
  changes as a lifecycle workaround.
- No automatic migration of historical sessions whose descendants are not
  attributable.
- No wholesale rewrite of Electron/tmux: the verified failure was ownership and
  launch ordering, not tmux durability itself.

## Remaining risks

- Codex containment currently covers Linux local non-TTY unified exec with empty
  inherited file descriptors. PTY and inherited-FD executions, MCP/browser tool
  hosts, and children that deliberately migrate to another cgroup need
  equivalent owner integration.
- The locally deployed Codex binary is a host hotfix and can be replaced by a
  package update until commit `448b1493346fbb82ae1a1b2d846622347f54ca4f`
  is released through the normal distribution channel.
- A same-user local process can still interact with loopback services; origin
  checks are not strong per-process authentication.
- Live-unreachable tmux generations fail closed but do not yet expose a guided
  SIGUSR1 socket-recreation action.
- Dead server tombstones and private socket directories need conservative,
  reference-aware garbage collection; accumulation is preferable to deleting
  absence evidence prematurely.
- Production startup still emitted two one-time xterm idle-task deadline
  warnings (153–154 ms) while three large terminal windows restored
  concurrently. There were no renderer errors or sustained stalls at that
  pre-recurrence startup checkpoint, but startup frame latency remains a
  measurable performance target rather than a reason to suppress the upstream
  warning. The later hardware-Xorg execution caused separate, documented GPU
  context resets and must not be conflated with this xterm timing result.
- The Mesa loader reports a permission warning for one GBM driver search path.
  Chromium's GPU process remained functional and substantially below the prior
  repaint baseline, so changing host graphics policy was explicitly out of
  scope for this lifecycle repair.
- Per-execution containment prevents a privileged child from becoming an
  unattributed long-lived orphan, but it cannot prevent immediate GPU/VT damage
  while a deliberately launched direct hardware Xorg is alive. The operational
  prohibition and VM/Xvfb boundary must be enforced at the originating shared
  launcher or test workflow; a cgroup is cleanup authority, not a device sandbox.

## Final assessment and confidence

Confidence is **high** in the repaired Linux ownership boundary: source
transcripts identify both incident launch paths, unit tests exercise fail-closed
identity transitions, the host harness proves detached-child and peer-isolation
behavior, Codex regressions include a privileged child, and the 18:27 recurrence
proved exact removal of a live root-Xorg execution without tmux loss. Confidence
is **medium** outside that
boundary because PTY/inherited-FD Codex executions, MCP/browser tool hosts, and
cross-cgroup escape remain explicitly uncovered, and execution containment is
not a GPU/VT sandbox.

Aico is now substantially safer and more trustworthy, but it is not yet
unqualified best-in-class. The critical attribution and orphan-cleanup defect is
fixed for the covered execution path. Prevention of direct host-hardware Xorg
must still be enforced by the originating test workflow and isolation policy;
the recurrence showed that exact cleanup can succeed after the workstation has
already been disrupted. The remaining differentiators are that enforced launch
boundary, an aggregate operator view, first-class execution provenance in the
UI, broader tool-host containment, and measured startup/accessibility work.
Those needs do not justify another broad Aico lifecycle rewrite.
