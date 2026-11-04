# M11b review fixes (same Codex lane; Opus review of c3df2435, 2026-11-04)

Fix each item with the regression test named. Deploy once at the end under your integration hold, check it live, update `evidence/M11b/result.json`, then release the hold. Same rules as briefs/M11b.md. Keep it lean: no new layers.

1. **No rotating logins over the link** (`secrets.ts:136-139`, `fleet.ts:152-160`). Settled with you: only static logins are delivered (Claude setup-token, OpenCode Go key, ST agent token). Refuse an entry whose tool login rotates (Codex, Pi OAuth) at the sender and the receiver, and delete the code path that would copy one. Test: a rotating entry is refused.
2. **No downgrade by a stale signed release** (`install-release.sh:42-43`, `update.ts:198`):
   - `install-release.sh` removes `$lib_dir/signed-update.json` when the repo has none.
   - `pushRelease` requires the signed payload's hash of `dist/tether.mjs` to equal the running release's.
   - Test: a stale envelope is refused.
3. **Replay** (`releases.ts`). Sign the API version and the release hash. `receive-update` refuses anything older than what's installed, and an equal one is a no-op. Test: an older signed release is refused.
4. **Login delivery folders** (`secrets.ts:49`). Check only the secrets folder strictly; the auth file is still written 0600 into an existing 0755 tool folder. Update the `tool-logins.json` map before or with the files, so a revoke always removes what was written. Test: a 0755 tool folder works, and a failed delivery leaves nothing untracked.
5. **Test the real update path** (`update.test.ts`). Drop `installTestRelease` (the old SSH copy). Test:
   - `pushRelease`'s full-role check and its refusal of an unsigned release;
   - `receive-update`;
   - `pushToolLogins` refusing an unpinned or worker sender;
   - the push made when the link comes up.
6. **Install result reaches the hub** (`fleet-cli.ts:159-173`). `receive-update` reports the install's real outcome, busy (`UPDATE_BUSY_EXIT`) included, so the hub retries busy on the next link-up as before and records the actual error otherwise. Test: busy, then retried.
7. Take `push-update`'s remote socket from the worker's hosts entry, not the local uid (`fleet-cli.ts:129`).
8. `install-worker.sh:29` verifies `signed-update.json` against the update pins before installing.
9. `authFile` is a fixed path per tool, not any dot-path (`secrets.ts:86`).

Report (≤15 lines): commits, each item, tests, the live checks (a worker updated by a signed push; a stale or older release refused), and the hold released.
