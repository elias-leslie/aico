# M10d-2 review resolutions

The required Codex review is in `review-codex.md`.

- Stage inputs: a synchronized regression reads a dependency before another lane changes it. The stage fails and the scoped commit refuses; unrelated simultaneous commits pass. Before/after stage and pre-commit checks use explicit `inputs`, never `quick_paths` selectors. A separate regression reproduced and fixed that distinction.
- Native children: hook metadata for Agent/Task launch, SubagentStart, PostToolUse and SubagentStop lives in Tether. Startup/resume/compaction lists unfinished children and transcript last-write age without reading transcript text. An owner-approved Claude settings checkpoint wires Agent and SubagentStop; a fresh Haiku print session returned READY. No silence-based end or redrive.
- History: SessionStart binds before polling; a retained retirement closes late-bound/late-scanned conversations. Claude harness names normalize to the history tool. Codex assistant final-channel messages mark completion. Pre-migration ended conversations without a saved root/conversation relationship cannot safely be backfilled; their unknown relationship is preserved.
- Pairing origins: the legacy environment or site-configured action origins carry into new pairing links, with a failing-first config regression.

The same-session hold regression now covers the original shared-identity symptom: holds accumulate independently and the CLI returns a handle-specific release command.
