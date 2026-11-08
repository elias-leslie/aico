# Command-line user test leftovers (Nov 8)

Found by Haiku testers working from --help alone; not fixed in that round. Reports: evidence/cli-test-2026-11-08/.

Needs a decision or more than a line:
- "[st] Waiting for shared ...-work lane" reads like a fault. Rewording needs an st_sdk release (byte-pinned in native/st-sdk/releases.txt) plus the copy in native/git-outgoing/git_outgoing/heavy_work.py.
- An acked handshake whose sender has ended can't be closed by anyone and shows in pulse until it expires at 24 hours. Pulse now says it waits on its sender. Letting others close it risks hiding an ack from a live sender with a stale anchor.
- Testers can't delete a note they made: no CLI delete, by design (the owner's, on the Notes page). The web API route works. Decide whether an agent may delete a note it made itself.
- A lane told by root send to run `st sessions confirm` took the message for a notification and refused.
- `aico logs PROJECT` is a dead end for a project-owned job, such as Refresh property valuations under Portfolio: no unit, no pointer to where the job's log lives.

Small:
- `st models --help` says `aico models` (both work; in packages/context, which another lane owned).
- `aico logins list` calls `backup-append.ed25519.pub` an API key (packages/fleet/src/logins.ts:437 guesses from the name).
- `aico logins list` says usable where `show` says Unused (help explains it); `logins edit` output leaves out state and activity.
- `st browser session create` prints raw JSON; `st browser observe` output runs 23-68 KB.
- `display_path` in native/st-sdk/st_sdk/details.py prints repo-root-relative `details:` paths for Python tools, which don't open from a subfolder (needs an st_sdk release).
- First `st browser check` once hit CDP connection refused; not reproduced.
- `routines list` shows each routine's own zone, named; `jobs list` shows local time with no zone name.

Other areas:
- `aico status --search X --json`: the summary ignores the filter (status area).
- `aico usage` Codex line wording (usage area).
- Files > Shared stays stale after a remove until reload (web).
