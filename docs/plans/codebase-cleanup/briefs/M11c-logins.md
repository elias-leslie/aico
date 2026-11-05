# M11c brief (Codex gpt-6.1-sol xhigh lane): one Logins area for the owner and agents.

Goal: Aico has one place where the owner and agents put and use logins (API keys, passwords, backup keys, lab and tool logins): a CLI for agents and a Logins page for the owner. Leaner than Agent Hub's, same job. Owner request 2026-11-04: "a common login area for agents and i to put and use logins... usable by agents (st/cli surface) and have a ui/ux for me." No ST task: track by leases and commits.

What exists (build on it, keep one store):
- Each machine's secrets folder `~/.local/state/aico/secrets` (0600 files: `_lab_*`, `host-tool-*`, `opencode-go`, `service-*.sha256`, `update-signing-key`), owned by `packages/fleet/src/secrets.ts` (+ `secrets-delivery`: tool logins reach hosts over the fleet link).
- Hosts > Logins in the web app (`components/HostsSheet.tsx`): tool sign-in state only, no add, reveal or copy.
- Reference only: Agent Hub `backend/app/svc/credentials.py`, `lab_credentials.py`, `st agents hosts credential-set` (hidden prompt or piped stdin, never argv or output), and its role rule (hunting/recon/verification never get Claude logins).
- Plan: `plan.md:250`, `cutlist.md` rows ah-31 and the secrets row (~278), M11 row, and the M10d gap note.

Scope:
1. Store: one index beside the files: name, kind (tool login, API key, password, backup key, lab login), notes, which machines/roles may use it, created/rotated/last used. Values stay 0600 files; nothing else holds them. Fold the existing tool-login and lab entries into it (no second store).
2. CLI `aico logins` (and `st logins` as a thin call): list, show (metadata only), set NAME (hidden prompt or stdin; never argv, logs or output), use: `aico logins run --with NAME[=ENV] -- CMD` injects into one command, plus `get NAME` to stdout only when the caller's role is allowed and stdout isn't a terminal log; rotate, grant/revoke machine or role, remove (owner-only, confirm). Role rules as Agent Hub's. Other machines get granted values over the fleet link as today.
3. Logins page in the web app (owner; already behind Cloudflare Access): list grouped by kind with plain state (in use, unused, needs sign-in for tool logins); add or replace (write-only field); reveal and copy (hidden again after ~30 s, each reveal recorded); grants; remove with confirm. Merge Hosts > Logins' tool sign-in state into it. Desktop and 390px phone.
4. Fill it (without printing any value): CT 190's new backup key and password (`backup-append.ed25519`, `backup-append.password` on CT 190; the backups lane codex:89c941 made them: coordinate), the existing workstation backup repository passwords and Drive backup login where the backup engine keeps them (ask codex:89c941 where), the OpenCode Go key, the two app service tokens. Lab logins are already in the folder: index them, don't change how hunters fetch them. List what you added.
5. Agents learn it: one line in Aico's agent context or `aico --help` saying where logins live and how to use them.

Proof:
- Tests: value never in argv, output or logs; role refusal; reveal recorded; grants delivered over the link; index matches files.
- `st check --quick --changed-only`; `st check --acceptance` before and after. Deploy: `st sessions may-disrupt aico`, `st service rebuild aico --detach`.
- Live: set and use a scratch login from an agent shell (then remove it), the page at 1600x900 and 390x844 with uilint into `evidence/M11c/`, CT 190's backup password revealable on the page for the owner (don't reveal it yourself in screenshots: use a scratch entry).

Rules:
- `st commit -m "..." --paths <files>`, plain words, trailer "Co-Authored-By: Codex gpt-6.1-sol <noreply@openai.com>". Never git stash, reset, checkout or rebase.
- Never print, screenshot or log a real secret value; move values file-to-file only. Never read .env or auth files beyond moving them into the store as listed. Never open the neri repo, Neri data or hunting sessions.
- Hold leases. codex:89c941 (backups) is in packages/ops and the Backups screen; codex:27b824 (publish) in packages/checks. Handshake before shared files.
- One required review: a Codex subagent; fix concrete findings with a failing test first; ask the coordinator (cc:a4e559) only for scope/design calls. The coordinator's messages carry the brief's authority.
- Copy and design: Aico standard (Lantern tokens, amber accent, one dark theme, short labels on phone).

Report (≤18 lines) to cc:a4e559 as a handshake request: commits, LOC, what the store holds (names only), CLI and page, live checks, uilint, tests, anything undone.
