# Tether lifecycle integration harness

Two host integration tests prove Aico's durable-session containment contract against a running Tether instance. Both drive the instance only through its v1 control socket, the way Aico and A-Term do, so they test the daemon as deployed rather than the library in isolation. They are not part of the unit suite: a build container without a systemd user manager, linger and tmux's Linux scope integration cannot provide this evidence.

| Script | Workload | Proves |
| --- | --- | --- |
| `scripts/tether-lifecycle-harness.sh [INSTANCE]` | synthetic `sleep` children in shell sessions | the full containment contract below |
| `scripts/tether-real-session-smoke.sh [INSTANCE] [TOOL]` | one real agent TUI (`codex` by default) | a real agent starts contained, paints, takes input, survives a client crash and ends cleanly |

Both default to the `dev` instance and refuse `default`. They are adapted from Aico's `scripts/aico-lifecycle-harness.sh` (which drove a private tmux socket directly) and `scripts/aico-real-session-smoke.sh` (which drove the packaged Electron app over CDP). Here Tether owns the tmux servers, so the scripts exercise Tether's own server provisioning instead of reimplementing it.

## Safety boundary

- Both scripts unset inherited `TMUX` and `TMUX_PANE` first.
- They refuse `default` and any name outside `[a-z0-9][a-z0-9-]{0,31}`, and stop unless `$XDG_RUNTIME_DIR/tether/<instance>/control.sock` is a listening socket.
- They touch only sessions they created, through the API, and remember each one. Cleanup on `EXIT`, `INT`, `TERM` and `HUP` reads each session's current generation and Ends it, which stops only that session's exact pane scope (Tether's End contract). Attach clients are killed by their recorded PIDs.
- They never call `tmux kill-server`, `pkill`, or `systemctl stop` on anything. A server unit exits by itself when its last session ends; the scripts only wait for that.
- Temporary files live in a fresh 0700 directory under `/tmp`, removed on exit.
- No prompt is ever submitted to an agent, so the real-session smoke makes no model request.

## Lifecycle harness coverage

1. The instance is healthy, `lifecycle` is `ready`, and it is not `default`.
2. Two shell sessions are created through `POST /v1/sessions` and reach `running`.
3. The tmux server PID is inside its exact `tether-<instance>-tmux-server-<id>.service` with `ExitType=cgroup` and null stdin, and its environment holds only allow-listed names plus the three server identity markers.
4. Each pane runs in its own `tmux-spawn-<uuid>.scope`, separate from the server, with `AICO_OWNER=aico`, `AICO_WIDGET_ID`, `AICO_SESSION_ID` and `AICO_AGENT_SLUG`, and without `AICO_TMUX_SOCKET`.
5. Each pane starts a foreground `sleep` and a `setsid` child; both stay in the pane scope with their markers, and the child is its own session leader.
6. Capture and scrollback answer, and an End with a wrong generation is refused as `409 stale_generation`.
7. Without a GUI, `title` renames the session through the generation fence and `position` answers `503 gui_unavailable`.
8. A real tmux client attaches with the API's exact argv; its resize claim is applied; it is killed by PID and the session survives; a second client reconnects and detaches.
9. With `TETHER_HARNESS_RESTART=1` (the default) the harness restarts `tether@<instance>` and proves both sessions, scopes, children and generations are unchanged.
10. Respawn moves the first session to a new scope; the old scope and its detached child are gone; the peer is intact.
11. A pane exit while detached is reconciled through the pane-exit marker, then the session is Ended.
12. Ending the second session retires its exact scope and its detached child.
13. `GET /v1/legacy-sessions` answers (read-only).
14. No workload PID, scope or session from the run remains, and the server unit exited once empty.

## Real-session smoke coverage

1. Creates a session as A-Term would (`origin: "a-term"` with a fresh `aTermSessionId`) and waits for `running`.
2. The agent's process runs inside the pane scope, and the pane carries `AICO_OWNER`, `AICO_AGENT_SLUG`, `AICO_WIDGET_ID` and `A_TERM_SESSION_ID`, never `AICO_TMUX_SOCKET`.
3. The first frame paints, a real attach client's resize claim is applied, typed input is delivered, and killing the client leaves the agent running. If a first-run dialog (for example a folder-trust prompt) swallows the typed text, the script prints a `WARN` instead of failing, because delivery itself was acknowledged.
4. End retires the session; no agent process, scope or session remains.

It exits `3` with `SKIP` when host agent admission defers the start (memory pressure or too many agents).

## Run

```bash
scripts/install.sh --start dev           # build, install and (re)start tether@dev
scripts/tether-lifecycle-harness.sh dev
scripts/tether-real-session-smoke.sh dev codex
scripts/tether-real-session-smoke.sh dev claude-code
```

`TETHER_HARNESS_WAIT_SECONDS` (default 15) and `TETHER_SMOKE_WAIT_SECONDS` (default 30) bound each wait so a wedged step cannot hang. `TETHER_HARNESS_RESTART=0` skips the daemon restart step.

Successful output ends with:

```text
PASS no workload PID, scope or session from this run remains (server exited when empty)
RESULT passed=true run_id=... checks=14 scopes=3 sessions=2 detached_children=2 residue=0
```

and for the smoke:

```text
RESULT passed=true run_id=... tool=codex checks=4 residue=0
```
