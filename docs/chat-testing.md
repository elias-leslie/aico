# Testing chats

Agents must identify chats they create for tests. On `POST /api/chat` (and
`POST /api/chat/:id/branch`), send `startedBy` with the initiating agent session
(e.g. `codex:<session-id>`) and `testing: true`, alongside the normal role, folder
and message. This is caller-declared provenance, not an authentication claim.
New unmarked chats record `startedBy: "owner"`; older chats retain unknown
provenance (`null`). A test start without an agent session is refused.

For browser UI tests, add these fields to the create/branch request in the
browser test harness. Record the created IDs. End each original and branch via
the normal End chat action or `DELETE /api/sessions/:id`, including after a failed
test. End preserves the transcript and Recent entry; it removes the chat from
Sessions. Never end an owner's chat as test cleanup.

Finished means an unseen completed reply in a live chat. Opening it clears that
attention state; ending the chat removes it from Sessions even if never opened.
