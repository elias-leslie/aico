# Running lane transfer

`join` is not a supported hunt transfer: `applyCoordinator` explicitly clears `launched`,
and Neri's launch record retains its old reporting and egress coordinator. The separate
API 29 transfer preserves reporting and runtime identity. See
[the API contract](../packages/tether/docs/api-v1.md#transfer-a-running-lane-api-29).

For a running Neri hunt, the coordinator executes:

```sh
st neri hunt transfer CASE --to NEW_SESSION --from OLD_COORDINATOR --json
```

`NEW_SESSION` and `OLD_COORDINATOR` are the eight-character Aico session IDs. This delegates
to `st aico widget coordinator transfer NEW_SESSION --widget-id LANE_SESSION --from
OLD_COORDINATOR`, then updates Neri's record. Do not use the lower-level operation alone
for a hunt. The implementation agent does not move the live lane.

Record metadata before and after, using the public surfaces (substitute the exact IDs):

```sh
st tether --json sessions get LANE_SESSION |
  jq '{id,generation,resumeId,status,coordinatorId,parentId,launched,tmux}'
st neri hunt status CASE --json |
  jq '{state,reports_to,coordinator,coordinator_transfer,booked,session,container}'
```

After transfer, `coordinatorId` and `parentId` equal `NEW_SESSION`, `launched` is true,
Neri's `reports_to` names the same session, and `coordinator` is `aico-widget-NEW_SESSION`.
The intent is null, the hunt remains started, and generation, native resume ID, tmux identity,
container and booking match the baseline. Use the existing runtime status surface if the
native PID/container PID also needs comparison; transfer never calls the runtime helper.
No target interaction is needed to validate metadata.

Synthetic regression coverage:

- `coordinator-transfer.test.ts`: actual HTTP route over a private synthetic daemon,
  helper lineage, launched flag, exact generation and ownership preservation, unchanged
  placement reservation, stale/busy/missing/unlinked refusals, safe repeat, existing/future
  question routing and transactional rollback. Launch, end, respawn, tool and project
  replacement functions are spied and must remain unused.
- `lane-reports.test.ts`: queued former-coordinator report withdrawn, next completed turn
  reaches the new coordinator, generation/cursor retained.
- `test_aico_widget.py`: both generations pinned, exactly one public mutation, qualified
  receipt and distinct false/unknown outcomes, without logging session content.
- Neri `test_hunt_transfer.py` and `test_egress.py`: routing-only record change, repeat and
  interrupted-response recovery, unchanged container/needs/native holder, egress to the new
  coordinator, no old routing during an unfinished transfer, current native-ID resolution.

The original synthetic HTTP test failed before the route existed. Managed focused checks
and the repository gates verify this coverage. These are synthetic results, not evidence
that a live hunt has been moved. Deployment is verified separately by API version and CLI
help without submitting a transfer.

Aico's command facade reads Neri's deployed owner manifest so `st neri hunt transfer --help`
and capability discovery expose the command. The retained bundled manifest is only a fallback
when the owner manifest is missing or invalid; the old Neri-specific exception hid hunt help.

Limits: one Tether authority, a linked lane and a running top-level destination. Explicit
watches and lines already delivered or being sent keep their history; old turns are not
replayed. Answered Aico asks and Neri's case/program owner-page asks keep their existing
history and owner. An uncertain Neri outcome keeps a durable intent; repeat the exact command
to finish it. No new hunt stage, service, database migration or direct database repair is used.
