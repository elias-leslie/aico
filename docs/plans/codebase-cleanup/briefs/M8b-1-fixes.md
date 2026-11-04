# M8b-1 review fixes (builder: Opus 5.5 high, fresh native subagent; Opus review 2026-11-04)

Context: M8b-1 (commits e9588843, 9ce073a9, 9a24e899; brief briefs/M8b-1.md) is deployed. Fix each item with the regression test named, deploy, check it live, and report. Code: `packages/agent/src` (tools.ts, run.ts, transcript.ts, cli.ts), `packages/agent/data/harness.json`.

1. **High: the hunting role's containment can be escaped** (`tools.ts:684-691`, `contain_command`). `unshare --net` leaves socket files reachable, and bash inherits the full environment: `systemctl --user` answers inside it, `$XDG_RUNTIME_DIR` holds 8 sockets, and `TETHER_SOCKET` and tmux can start an unconfined session. The read, edit and write tools run in-process with no containment.
   - Fix: run contained bash under bwrap (or `unshare --mount`) with a private `/run/user/$UID` and `/tmp`, and clear the `DBUS*`, `TETHER*`, `TMUX*` and `XDG_RUNTIME_DIR` variables.
   - For contained roles, limit write and edit to the working folder; a write to `~/.config/systemd/user` or the folder's `.git/hooks` is refused.
   - Tests:
     - `systemctl --user`, the Tether socket and tmux fail inside;
     - writes outside the folder or into `.git/hooks` are refused;
     - the namespace test fails, rather than skipping, when the contain tool is missing on this host.
2. **Two processes resuming one run** (`transcript.ts` resume, `cli.ts` runRequest). Claim the run atomically: an owner pid/lease column, set only when there's no holder or the holder is dead. Refuse otherwise. Test: a concurrent resume is refused.
3. **Our own exceptions treated as provider errors** (`run.ts:636-640`). Fall back only when the provider stream itself errored: set a flag in the `streamFn` wrapper. Test: a listener or SQLite exception ends the run as an error with no fallback.
4. **Secrets in `meta`** (`transcript.ts` message()). Drop `details` from `meta` for withheld call ids (Pi's edit tool puts the diff there). Test: a withheld edit stores no diff.
5. Count turns from assistant rows only (`load()`), so a crash after the prompt doesn't skip a turn. Test.
6. `--resume X` with nothing to continue refuses without changing the row (today it marks a finished run `error`). Test.
7. On resume, start from the model that last answered, not the head of the chain. Name the fallback turn honestly in the log (T+1).
8. Times: `aico sessions show` and `list` print UTC (18:53 for 13:53 EST). Show local time everywhere a person reads it.
9. Remove the 4 new `no-cycles` entries in `.dependency-cruiser-known-violations.json` (cycles among `packages/tether` `aico-agent.ts`, `agent-state.ts`, `registry.ts`) by breaking the cycles.

Proof: tests above; `st check --quick --changed-only`. Deploy: check `st lease --list --all` for a hold, take `st lease --hold deploy`, `st sessions may-disrupt`, `st service rebuild aico --detach --worker tether@default`, release. If acceptance fails on `aico check`'s vitest issue (the M10b-1 builder is fixing it), deploy with `ST_AICO_CHECKS=0` and say so. Live: a hunting-role run where bash tries `systemctl --user` and a socket, both refused; `aico sessions show` in local time.

Rules: commit with `st commit -m "..." --paths <files>` in plain words, ending with "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>". Hold leases; M10b-1 (packages/checks), M9-1 (packages/webtools, context) and M10c-1 (packages/ops) run at the same time. Never git stash, reset, checkout or rebase. Never open the neri repo or Neri data, or read credentials. Small commits that leave everything working.

Report (≤15 lines): commits, each item, tests, live checks.
