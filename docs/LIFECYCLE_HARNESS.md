# Aico lifecycle integration harness

`scripts/aico-lifecycle-harness.sh` is a destructive-to-itself host integration
test for Aico's durable-session containment contract. It uses only synthetic
`sleep` workloads. It does not launch Electron, Codex, browsers, Xorg, or any
privileged helper.

## Safety boundary

- The script unsets inherited `TMUX` before doing anything else.
- Every invocation generates a socket named `aico-lifecycle-<uid>-<run-id>` in
  a newly-created private `TMUX_TMPDIR`. Every tmux command repeats both
  `env -u TMUX` and `-L <generated-name>`; the production `aico` and default
  sockets are never opened.
- Before the first tmux command, the script rejects `aico`, `default`, unsafe
  or overlong names, an existing exact socket path, an active Unix socket with
  the generated basename, a stale socket collision under the temp filesystem,
  or a pre-existing generated server unit.
- Session names, process argv markers, PID files, and attachment helpers contain
  the same unique run ID.
- The private tmux server starts through the production ownership pattern: a
  user-manager-spawned transient `aico-tmux-server-<32hex>.service` with
  `Type=exec`, `ExitType=cgroup`, null stdin, and journal output. The harness
  proves the server PID is in that exact service before continuing.
- Cleanup stops only `tmux-spawn-<uuid>.scope` units observed directly from this
  run's pane PIDs, plus the collision-checked private server service. It validates
  recorded control-group identity before stopping anything and rejects broad
  application, session, and user scopes.
- Process cleanup uses recorded and command-line-verified PIDs, never `pkill`,
  process-name matching, or a broad Aico cgroup.
- An `EXIT`, `INT`, `TERM`, and `HUP` trap cleans the exact units, PIDs, private
  tmux server, and temporary directory even after an assertion fails.
- Cleanup never issues `tmux kill-server`, qualified or otherwise; the exact
  generated systemd service is the server ownership boundary.
- Cleanup treats `activating` and `deactivating` units as live, stops them only
  after identity validation, waits for inactive/not-found plus absence from the
  active Unix-socket table, then removes the exact private directory (including
  any inert tmux socket inode). It retains that directory if cleanup is unproven.

The test requires Linux, tmux with per-pane systemd scope integration, a running
systemd user manager, util-linux `script`/`setsid`, and cgroup v2 visibility.

## Coverage

1. Starts the private tmux server in an exact durable server service and proves
   the server PID is there.
2. Creates two bare panes and verifies each has a distinct
   `tmux-spawn-<uuid>.scope`, separate from the server, before launching work.
3. Passes `AICO_WORKLOAD_CLASS` and `AICO_SESSION_ID` with tmux `-e`, launches
   through literal `send-keys` only after containment, and proves both the
   foreground worker and detached child inherited the ownership metadata.
4. Each workload creates a `setsid` child, proving session/process-group detach
   does not escape the pane cgroup.
5. Crashes a real tmux attachment client by its exact PID and verifies the
   durable session and workload survive.
6. Reconnects using another real tmux client and detaches cleanly.
7. Exercises the real Replace-TUI ordering: `respawn-pane -k` to a bare pane,
   requires a new scope (scope reuse is a hard failure), launches the replacement,
   stops only the old scope, and proves both replacement and peer survive.
8. Force-crashes the replacement pane parent by its verified exact PID, proves
   the detached child remains attributable inside the recorded scope, and then
   removes it by stopping only that scope.
9. Stops the second session scopes and private server service and verifies no known PID,
   active scope, tmux session, or private Unix socket remains.

## Run

```bash
./scripts/aico-lifecycle-harness.sh
```

Local process/cgroup transitions should complete immediately. The harness uses
a bounded ten-second assertion wait solely so a failed migration or wedged
attachment cannot leave the test running indefinitely. Override it when running
on an unusually loaded host:

```bash
AICO_LIFECYCLE_WAIT_SECONDS=30 ./scripts/aico-lifecycle-harness.sh
```

Successful output ends with:

```text
PASS attach-client crash preserved the durable session and detached child
PASS real tmux reconnect and clean detach succeeded
PASS respawn created a new scope; old-scope cleanup preserved replacement and peer
PASS parent crash left an attributable child that exact-scope cleanup removed safely
PASS no workload PID, scope, session, or isolated tmux-server residue remains
RESULT passed=true run_id=... scopes=3 sessions=2 detached_children=3 residue=0
```

This harness intentionally is not part of the ordinary unit-test suite: a build
container without a systemd user manager or tmux's Linux scope integration
cannot provide evidence for the lifecycle behavior under test.

The final host run was `final-1783981474-39090`. It completed in under one
second, ended with `passed=true` and `residue=0`, and left the three production
Aico sessions byte-for-byte identical in the before/after roster. The run log is
kept as local verification evidence under `.dev-tools/`; generated PIDs, scopes,
socket, service, and temporary directory were absent after cleanup.
