# Sidebar cleanup — independent Codex review

Reviewed the sidebar cleanup brief and the scoped chat/session, attention,
fleet power-status, migration, test and documentation changes. No product code
changed by this reviewer.

Findings sent to the implementer:

1. **High: stopped-peer Status rows fail the real input contract.**
   `packages/fleet/src/power.ts` omitted `next_run` for `kind: machine, state: off`.
   `packages/status/src/row.ts:187` requires that field on every machine row, so
   the all-or-none Status POST would reject the entire batch. The initial power
   tests inspected plain objects and missed this integration failure. Keep a
   heartbeat deadline in the row; the existing Status renderer already exempts
   `off` rows from becoming late. Require a regression through `parseRow` or
   `StatusStore`, including the off-to-running transition.

2. **Medium: new live-chat Finished attention omitted shared seen state.**
   `POST /api/sessions/seen` stores chat IDs, but chat session responses did not
   carry `seen_at`. A chat opened on one device would remain Finished on another.
   Tether-backed sessions already use `store.seenAt()`. Require a failing chat
   route regression for list and detail responses after marking the chat seen.

Review also checked: ended chats are filtered only from the live session list;
transcripts and the existing pushed Recent history remain; new chat provenance
is explicitly caller-declared (not authentication); old provenance remains
unknown; stopped guest state comes from Proxmox, while running, missing,
ambiguous and failed readings retain warnings; connected links take precedence.

Both findings are **resolved** in the reviewed working tree. The implementer
added the two regressions first; `review-regressions-red.txt` and its raw Vitest
receipt show the expected contract rejection and missing `seen_at` failures
(2 failed / 20 passed). The fix retains the required machine deadline and tests
its `off` rendering after that deadline; chat list, detail and rename responses
now read the shared seen map.

Independent verification: `st check vitest -- --project fleet
packages/fleet/src/power.test.ts packages/fleet/src/fleet.test.ts --project
web-server packages/web-server/src/chat.test.ts --project web-frontend
packages/web-frontend/lib/attention.test.ts` passed **49 tests** in four files.
Receipt: `reviewer-tests.txt`; raw output:
`.dev-tools/vitest-18e502ac4c38988a-2584358-de64dff4-details.txt`.
Scoped `git diff --check` passed. No unresolved source findings in this review.

Limitations: power tests inject the Proxmox reading rather than contacting the
hypervisor. The review does not establish deployment, historical chat cleanup,
final Status counts or rendered phone acceptance; the implementing lane must
supply those live checks. Provenance is explicit harness-supplied metadata,
not automatic browser-user identification.

## History-access follow-up

Reviewed the coordinator-approved extension to retained chat history in
`history.ts`, its `api.ts` registration, and new route/projection tests.
The projection preserves text, thinking, tool-call arguments, tool results and
image placeholders in the existing `HistoryEventPage` shape. Event offsets are
stable block indexes; backward `before` and forward `from` cursors are exclusive
end/inclusive start respectively, matching the page contract.

One additional compatibility finding was sent: the new `limit=0` rejection was
placed before selecting local chats, changing non-chat requests that previously
delegated unchanged to Tether (which clamps the limit to one). Keep that check
within the local-chat branch, with a delegated-ID regression. Also identified a
test-fixture mismatch: unknown non-chat IDs in `FakeTether` return an empty page,
so a new test's unconditional 404 expectation was wrong; the implementer corrected
it without changing the production fallback.

The compatibility finding is **resolved**. The implementer first reproduced the
non-chat regression (`history-delegation-red.txt`: 1 failed / 40 passed), then
removed the new rejection and made local chats clamp a zero limit to one, as
Tether already does. The production fallback forwards other IDs and options
unchanged. This final simplification introduces no new validation policy.

Independent follow-up verification: canonical `st check vitest` on web-server
`history.test.ts`, `chat.test.ts` and `api.test.ts` passed **61 tests** across three
files (final version: `reviewer-history-final-tests.txt`). Scoped `git diff --check` also passed. The
route regression exercises newest, backward and forward pages, ended-chat text,
local zero-limit clamping and non-chat fallback; the projection test covers
thinking, calls, results, image placeholders and empty transcripts. No unresolved
source findings from the follow-up. The implementing lane still owns final live
Recent transcript capture and deployment evidence.
