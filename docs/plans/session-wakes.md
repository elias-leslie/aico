# Session wakes (scheduled check-ins)

Owner-agreed 2026-10-26; reviewed against the code and amended 2026-10-26 (section "Review: what changed").
A session can hold a short list of scheduled wakes. At the time, the wake message is delivered to the
session's agent; the desktop reopens the session's window if it had one.

Fixed by the owner: **X (close window/tab) = pause, wakes still fire. End session = done, cancels wakes unless
the owner picks "Keep check-in".** Same rules on desktop (Electron), web and phone. Tether is the only
scheduler. No new Web Push: the existing "waiting in Aico" push covers the owner hearing about it once the
agent stops.

## Behaviour

- **Set.** Agents: `st aico wake <time> "<note>"` on their own session (`AICO_WIDGET_ID`), plus `list` and
  `cancel`. Owner: "Check in later" in the session menu on desktop (window menu and tray) and web (session
  menu); quick choices *In 1 hour*, *Tonight*, *Tomorrow morning*, plus a custom time. The quick-choice hours
  are Tether's wake policy (settings row, defaults below), not constants in the apps. The CLI accepts `HH:MM`
  (next occurrence, local time), ISO 8601, and `+2h` / `+30m` / `+1h30m`.
- **Show.** A "Check-in 5:30 PM" chip on the session in the web session list and the desktop tray row
  (weekday added when it is not today); the window/session menu lists each pending check-in with Cancel.
- **Fire** (Tether; survives Aico restarts and reboots):
  - The wake becomes *due* at its time. If the session has a desktop view and its window is closed, Tether
    asks the desktop to reopen it at its remembered place without taking focus (`show` with `ifViewed`, see
    Shape). A session the desktop never showed (web-started and never opened there) gets no window. An open
    window is left alone.
  - The message is pasted and submitted only when all hold, checked together right before the paste:
    the session is running and its tool is an agent; agent state is `idle` (not `working`, `blocked` or
    `unknown`); the input line is empty; no attached client sent a key in the last `quietSeconds`. Otherwise
    Tether re-checks on every agent-state change and every few seconds while any wake is due.
  - Missed (machine off or asleep, Tether down): a due wake fires once on the next start, as soon as the
    gates allow (after reboot restore resumed the session). All due wakes of one session go out as one
    message, so they never stack.
  - Delivery is at most once: the wake row is deleted before the paste and put back only if the paste
    reports the session not running.
  - Ended with "Keep check-in": the wake outlives the session row. At its time, if another running session
    already holds the same agent conversation, the wake is delivered there through the normal gates.
    Otherwise Tether starts a **new** session (a new session ID: IDs are never reused and an ended session
    is never resurrected in place) with the ended session's tool, project, name, origin and coordinator,
    resuming the recorded conversation, with the wake message as its resume prompt (the reboot-restore
    `withRootPrompt` path, so no idle/empty gate is needed). A session whose conversation could not be
    resumed starts fresh with the message. A desktop-started session (origin `aico`/`root`) gets a desktop
    window; a web-started one does not. Admission refusal retries every minute; any other launch failure
    retries up to `relaunchAttempts` times, then the kept wake stays listed with its error.
- **End.** The End confirmation (desktop dialog for the window menu and tray, web dialog) names pending wakes
  ("This also cancels its check-in at 5:30 PM.") and offers *End, keep check-in*. Plain End cancels them, by
  any End path (`POST /v1/sessions/:id/end`, root end, web tab close-out): a SQLite trigger on the session
  row delete removes wakes that were not kept.
- **Message the agent receives:** `[Scheduled check-in for 5:30 PM] <note>`, with `, 12 min late` when the
  delivery is more than `lateNoticeMinutes` after the time, and `, resumed after End` for a kept wake
  relaunch. Several due wakes: one bracket, notes joined with ` / `.

## Shape (extends existing code; no new daemons)

- **Store** (`tether/src/schema.ts`, `store.ts`): schema v10 adds `wakes` (`id`, `session_id` nullable,
  `due_at`, `note`, `created_at`, `created_by` agent|owner, `kept`, `ended_session` JSON snapshot,
  `attempts`, `last_error`) with an index on `due_at`, and an `AFTER DELETE ON sessions` trigger: delete the
  session's wakes with `kept = 0`, detach (`session_id = NULL`) the kept ones. No foreign key, so kept rows
  survive. Tested on a fresh DB and on a v9 DB upgraded in place.
- **Scheduler** (`tether/src/wakes.ts`, started by `daemon.ts` after startup reconciliation): one timer for
  the next due wake (clamped below the 24.8-day `setTimeout` limit), re-armed on every change; a short
  re-check interval only while some wake is due; agent-state changes nudge it. Delivery uses
  `pasteIntoRunningSession`; idle comes from `AgentStateTracker`; the empty-input check and the
  client-key quiet check read tmux (`capture-pane -e` of the visible screen, `list-clients
  #{client_activity}`).
- **Empty input line** (per tool, from the visible screen): find the last prompt line (`❯` Claude Code,
  `›` Codex). Claude Code's input runs to the next `────` rule; Codex's to the next blank line. Drop dim
  (SGR 2) runs, which are placeholders ("Ask Codex to do anything"), then all escapes and whitespace. Empty
  means no draft. No prompt line found counts as a draft (wait). Tools with no agent-state source (Pi, shell)
  cannot take wakes: set returns `409 wake_unsupported`; a wake whose session later switches to such a tool
  waits.
- **Routes** (`lifecycle-api.ts` + `wakes.ts`): `GET /v1/wakes` (all wakes, kept ones included, plus the
  policy), `GET /v1/sessions/:id/wakes`, `POST /v1/sessions/:id/wakes` `{dueAt, note, createdBy?}`,
  `DELETE /v1/wakes/:wakeId`, `PATCH /v1/wakes/:wakeId` `{dueAt}`, `GET`/`PUT /v1/wake-policy`.
  `POST /v1/sessions/:id/end` takes optional `keepWakes`. The descriptor gains `wakes: [{id, dueAt, note,
  createdBy}]`, so `session.updated` carries changes to both apps live; kept wakes publish `wakes.changed`.
  API version 3; the apps' `MIN_TETHER_API_VERSION` becomes 3 (End's new field). Typed in
  `src/client/contracts.ts`, client calls in `src/client/client.ts`.
- **GUI**: the `show` command gains optional `ifViewed: true`: the desktop reopens the window only if it has
  a view row for the session, without focusing it, and answers `no_view` otherwise.
- **Wake policy** (settings key `wake_policy`, defaults): `laterMinutes` 60, `tonightHour` 21,
  `morningHour` 8, `maxPerSession` 5, `noteMaxChars` 500, `quietSeconds` 15, `lateNoticeMinutes` 5,
  `relaunchAttempts` 15.
- **`st aico wake`**: `tether/scripts/aico-root-watch.py` (the `aico.roots` extension executable) with its
  help and an on-demand usage entry in SummitFlow `scripts/lib/extensions/aico.json`. `set`, `list`,
  `cancel`; own session by default, `--widget-id` for another.
- **Desktop**: tray row detail and a "Check-ins" submenu (Cancel per wake), "Check in later" in the window
  menu with the quick choices, End dialogs with the wake line and *End, keep check-in* (`session-actions.ts`,
  `tray.ts`, renderer `actions.ts`). In-window End shows the native dialog only when the session has wakes.
- **Web**: chip in the session list, "Check in later" in the session menu (quick choices, custom
  `datetime-local`), End dialog line and option (`web/frontend`); `web/server` routes proxy to Tether.

## Verify

- Unit tests per layer: migration (fresh and v9 upgrade, trigger keep/cancel), scheduler (next-due timer,
  catch-up, no stacking, at-most-once, idle/blocked/unknown gates, empty-input parser on real captures, quiet
  gate), kept-wake relaunch and conversation-elsewhere, routes and validation, contracts, CLI time parsing,
  UI components.
- `st check` per repo touched.
- Live (G:c4b3f43b; end only sessions created for the test): a test session with a wake 2 min out, window
  closed with X -> window reopens, message lands once idle; window open with text typed but unsent -> waits,
  lands after the draft is cleared; End + Keep check-in -> a new session resumes the conversation and gets
  the message; plain End -> wake gone; web chip/menu at phone width (screenshots); restart tether@default
  with a pending wake -> still fires; existing session IDs/generations and the tmux server unit PID unchanged
  across the Tether deploy.

## Review: what changed from the first plan

1. End deletes the session row and retires its ID, so "relaunch the session" cannot reuse the row or ID. A
   kept wake keeps a snapshot (tool, project, name, origin, coordinator, conversation ID read at End) and
   relaunches as a new session. Wakes are not foreign-keyed to sessions; a delete trigger cancels unkept ones
   on every End path, not just the one the dialog uses.
2. "Input line empty" had no source. Tether now reads the visible prompt line per tool (placeholders are
   dim), and also waits until no attached client has typed for `quietSeconds`, which closes the race between
   the check and the paste while the owner is typing.
3. Pi and shells report no agent state, so "wait until idle" can never pass; wakes are refused there instead
   of hanging. A wake follows the session ID, not the generation: after a respawn or tool switch it goes to
   whatever agent runs then, and waits if none.
4. A plain `show` would also pop a window for web-only sessions and steals focus; `show` gains `ifViewed`.
5. "Missed: never stack" made concrete: one message per session for all due wakes; delivery at most once.
6. A kept wake whose conversation is already running elsewhere (resumed by hand) is delivered there instead
   of starting a second agent on the same conversation.
7. Quick-choice hours and limits are Tether wake-policy data shared by both apps.
8. End's new `keepWakes` field raises the API version (the API's own rule), so the apps' minimum goes to 3.
