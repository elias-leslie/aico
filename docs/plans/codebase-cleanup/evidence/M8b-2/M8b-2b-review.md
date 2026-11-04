Required Codex review: native subagent `phone_chat_review`, completed 2026-11-04. Read-only review of the milestone brief, mockup notes, changed frontend/backend recovery paths, capture integration, and renderer; no provider calls or live checks by the reviewer.

The coordinator validated the five defects and Stop pointer concern through coordination handshakes. Fixes were implemented in 4eab2572; the cache draft fix was added in f8b3c7d after live validation.

| Finding | Fix and evidence |
| --- | --- |
| Uploads aborted on Back and selected files disappeared. | Per-chat upload queue survives component unmount. Regression failed first. Live: held a real upload's load callback, went Back and reopened; Saving and both files remained, then completed and sent. |
| An unclosed `**First` lost characters. | Only complete markdown tokens are formatted. Regressions failed first; live reply renders First in strong text. |
| Chat captures could auto-file in Notes/Groceries or raise handoff notices. | Uploads carry a chat group; extraction preserves the reading without planning a filing route. Regression failed first. |
| Failed photo preparation hid the saved draft and Try again lost the prompt. | Restored attachment draft is applied once from SSE; retry sends the original prompt and file refs. Resolver-failure/retry regression failed first. |
| A direct question arriving after a file was prepared dropped the file on free-text answer. | Answer contract includes attachment refs. Regression failed first. |
| Phone Stop might vanish on pointer blur before click. | Pointerdown keeps message focus. Live pointer click stopped the reply on the first tap, with TEXTAREA focused and composer above the emulated keyboard. |
| Additional live finding: Back could reopen an older cached text draft. | Draft persistence updates the query cache immediately; regression failed first and passes after the fix. |

Test logs and final live receipts are referenced by M8b-2b-live.json. Physical Android keyboard/camera UI was not exercised; the Android app opens allowed Aico links in Custom Tabs. Phone checks use the deployed web app at 390×844 with an emulated visible viewport and coarse pointer where needed.

Real-user follow-up: desktop and phone Pi testers both used DeepSeek Flash with only the page and browser help. The desktop tester could not get a question into Needs you; the phone tester succeeded only after a second request and extensive tool discovery. A fresh live DeepSeek chat reproduced the missing question. Chat-only context now names the existing `tether ask` command; an identical fresh request then filed a real question with one bash call and its First answer arrived as a new chat message. The question was answered immediately by the test driver.

A final answer-path regression confirmed that option answers from either the chat card or the shared Needs you panel cleared an unrelated saved composer draft and its attachment refs. Both cases failed first. The answer path now preserves those drafts; a free-text answer sent from the composer still consumes its own draft. The live check retains the pending next message and file while its test question is answered.
