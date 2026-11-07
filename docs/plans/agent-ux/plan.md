# Agent UX from the Box Yard review (owner approved 2026-11-07)

Sources: docs/box-yard-comparison-2026-11-07.md, docs/box-yard-adversarial-review-2026-11-07.md, docs/agentsystemlabs-repos-review-2026-11-07.md, the creator's video (aico video https://youtu.be/nl3bSrUfvXQ). Harness-agnostic: built through Tether's adapters and Aico's hooks; never patch a vendor tool.

1. One owner-question channel (`tether ask`): aico-hook refuses Claude AskUserQuestion in every session (coordinators and owner-started too) with a redirect message; Codex hook refuses request_user_input / request_user_input_async after one live test; Codex adapter recognises request_user_input_async as blocked (a real call on 2026-11-05 never reached Needs you); agy ask_question stays detected as the fallback card. Pi has no question tool.
2. "Doing now" line per working session: Claude, Codex, Pi from the existing transcript readers; agy from its database. No model calls.
3. Session names: typed name, then Claude's terminal title, Codex thread name (~/.codex/session_index.jsonl), Pi session name, then the first prompt.
4. History search: text scan over the Claude, Codex and Pi readers, labelled with the tools it covers; agy and Aico agent once they have readers.
5. Continue a terminal session in another tool with a recap (transcript tail + git status): `--continue-from` and a button on the used-up notice. The Aico agent chat already has this.
6. Exact-shape secret masking (known token formats, private keys, bearer) on Recent and History transcripts; not the broad mask (it hides git hashes).
7. Per-project split on Quota and `aico usage show` for Claude and Codex; other providers read "not tracked by project". No role split (no data).

Skipped: side-by-side pin, read-only diff view, coding-prompt lines, fake test agent, follow-up chip, spoken read-back, dev-server relay, permission-prompt taps, permanent perf suite. Peer copy of unfinished work: only inside the Failover item.
