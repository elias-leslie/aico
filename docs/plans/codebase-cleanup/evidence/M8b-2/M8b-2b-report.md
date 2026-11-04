M8b-2b is implemented, deployed and verified live.
Source commits: 4eab2572, cf12bb0c, f8b3c7d1, 9924eb91, e2e76c88, 830ca202, 5ea59796, a221fd7a.
Code and tests: +1,592 / −152; net +1,440 across 30 package files; evidence excluded.
Managed deployment aico-0632d52b0bbf succeeded at a221fd7a; page and health 200, web active.
Full acceptance before → final: 147.1 s → 145.4 s; 3,251 Vitest passed / 6 skipped and 1,151 Python passed.
Every source checkpoint passed the quick gate; final answer-path focused suite: 58 passed. A flaky fleet test port race was fixed test-only with coordinator approval.
48 screenshots here: 17 main phone captures and 31 tester captures; six requested phone screens at 390×844 plus dialogs, Details, Stop, draft recovery and ended state.
Uilint: source and every captured phone view passed with zero violations; snapshots and log are M8b-2b-*-ui.json and M8b-2b-uilint.txt.
Real photo + text uploads reached the model correctly; uploads survive Back, queued/failed drafts recover, and chat captures do not auto-file into Notes.
Real-user Pi/DeepSeek Flash testers: phone completed all six journeys; desktop passed five initially. Its Needs you failure was reproduced and fixed, then a fresh natural request filed a question with one call and received its answer.
Tester fixes: question guidance, correct chat answer destination, full folder/cache explanation, distinct branch names, unfinished-branch wording and readable phone composer choices.
One required Codex subagent review completed; coordinator validated the findings. Regressions and live checks cover its fixes and two later draft-loss cases.
Hunting was selectable with Start enabled at phone width; Hunting/Recon start payload tests passed. No hunting session was started; no Neri data or credentials read; no Claude chat models used.
Keyboard viewport/coarse pointer were emulated; the pending upload view held a real XHR completion callback. Physical Android camera/keyboard was not tested; Android opens Aico in Custom Tabs.
All 6 main chats and 4 tester chats verified Ended with zero questions; 2 Pi roots and 3 browsers closed; own test captures removed through the app.
Receipts, checks, capture methods and screenshot hashes: M8b-2b-live.json; original tester reports and their dispositions are alongside it.
Remaining: None within the agreed scope.
