# Post-audit quick fixes (Codex gpt-6.1-sol high lane). Two Status rows that keep alarming for known states.

1. ECC (owner 2026-11-05: corrected errors on davion-gem are a known non-issue; global memory 11c8391d). The pve-sender ECC check (`davion-gem/check-ecc`) should go failed only for uncorrected errors or a clear jump in the corrected-error rate (threshold as data in its config, not code); corrected errors in already-seen places stay OK with a plain note. No owner ask or push for corrected errors.
2. Portfolio-AI backup while VM 180 is off (owner decision: it stays off): `external/portfolio-ai-complete` and the "Portfolio-AI full backup" row read "off" like other stopped VMs, showing the last good backup date, instead of failed. When VM 180 runs, the normal check applies again.

Proof: failing test first for each; quick check; signed install on gem (pve-sender) and workstation as earlier lanes did; Status shows the new states live; `aico pulse --brief` no longer lists either as CRIT.

Rules: `st commit -m "..." --paths <files>`, trailer "Co-Authored-By: Codex gpt-6.1-sol <noreply@openai.com>"; never stash/reset/checkout/rebase; hold leases; never open Neri; never read credentials; never start VM 180; declare host changes as earlier lanes did; one Codex-subagent review. Ask the coordinator (cc:a4e559) only for scope calls. No ST task.

Report (≤8 lines) to cc:a4e559 as a handshake request.
