M8b-2a is implemented, deployed and verified on desktop web.
Source commits: `f38678b8`, `ddefecbd`, `41ec7f1a` (full IDs in `M8b-2a-live.json`); evidence is committed with this report.
Source LOC: +3,778 / −5,559; net −1,781 (evidence excluded).
Deleted: Agent Hub gateway/chat view, old chat transports, StepViewer, all ui-kit chat code, vendored chat-ui tarball and chat-only dependencies/config/model proxy.
Chats now use the Aico harness and common session groups; routing, fallback, tools, questions, queue/draft, branch, Details and recovery follow the approved mockup.
Live scratch check: default implementation role + DeepSeek, two messages editing greeting.txt, Details, branch at turn 2 writing branch.txt; source transcript stayed unchanged.
Live captures here: `M8b-2a-{new-chat,first-reply,second-reply,details,branch-dialog,branch}.png`; final deployed layout: `M8b-2a-{new-chat,details,branch}-final.png`.
Stop preserved 700 streamed characters and restored the queued note once as a draft: `M8b-2a-{streaming,stopped-draft}.png`.
Real tether ask appeared in Needs you, recommended First was answered, chat returned Idle: `M8b-2a-{needs-you,answered}.png`; ask is done.
Final-source effort reset to From routing and clean end: `M8b-2a-{effort-routing,ended-final}.png`.
All 27 screenshots are 1600×900; 11 labeled component fixture states are `M8b-2a-state-*.png` (no provider calls; driver saved as .txt).
Uilint: source 173 files/3,569 items, 7 mockup views, 11 fixture states and 4 final live views: zero violations (logs here). Earlier model prose saying “terminal” triggered the vocabulary rule; content and spec were left intact.
Tests: focused source quick check 92 passed/6.7 s; final native deployment acceptance 3,237 Vitest + 1,151 Python passed/103.4 s; route/fallback/ask/stop/branch/recovery regressions included.
Direct acceptance before and after passed: 173.6 s → 140.5 s; final direct run had 3,231 Vitest passed/6 skipped and 1,151 Python passed (receipt paths in live JSON).
Managed deployment `aico-58385e3d2ed0` succeeded at `41ec7f1a`; web active and page/health 200; concurrent Tether catalog repair `e612caae` included.
One required Codex review (coordinator-approved substitute): all four findings reproduced, fixed and covered; final evidence is source-bound in `M8b-2a-live.json`.
All four created chats ended, zero open questions, both headless browser sessions closed; no Claude testing, Neri access or hunting session access.
Remaining: None within the agreed scope. Phone screens and the tester pass belong to part 2 and were not started.
