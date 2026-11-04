# M4a brief (builder: Sonnet 5.5 high, native subagent). Part 1 of 2 of M4: the tray.

Goal: the Nightshift desktop tray becomes the Aico tray in `/srv/workspaces/projects/aico/native/tray` (Rust). It keeps everything it does today and reads Aico instead of Nightshift for its data.

Read first:
- `docs/plans/codebase-cleanup/cutlist.md`:
  - 1.1 (native table: `native/tray`, Rust, user unit);
  - 2.3 rows ns-04, ns-07 and ns-39;
  - the M4 row in section 4.
- `plan.md` decisions log 2026-11-03: "Tray: alerts that ended on their own stop counting as new".
- Source to port: `/srv/workspaces/projects/nightshift/desktop` (Cargo crate; `src/*.rs`, `shell-extension/`) and the data it reads: `ns/trayinfo.py` and `ns/web/inbox.py` (`nightshift inbox --json`, parity tests in `tests/test_inbox.py`).
- Aico data the tray now reads (M2 and M3):
  - GET `/api/status`, whose `summary` has the problem count and top problems, with rows on a deliberately-off machine left out;
  - Needs-you asks (`packages/notify`, `tether ask list`);
  - notices.

Scope:
1. Copy the crate into `native/tray`, including its tests. Rename what the user sees from Nightshift to Aico. Its Rust tests run in a native stage (cutlist 1.4: `cargo clippy/test` when `native/tray/**` changes).
2. Add one tray data endpoint on aico-web (loopback). It returns what `nightshift inbox --json` gives today, built from Aico's data:
   - open Status problems;
   - Needs-you asks;
   - unread agent reports.

   Unread rule: items that ended on their own (resolved, back online) leave the tray and count as nothing; only open problems and unread agent reports count. Port the parity tests against the new endpoint.
3. Point the tray at that endpoint and at Aico's links (Status page, Needs you).
4. Approve popup, FIDO, seal and daemon (ns-07):
   - Port the code unchanged, and keep the approval path working against Nightshift's executor as it does today. The grants backend moves in M5b.
   - Never read, copy or print passkey or credential material.
5. Install it as the user unit that replaces Nightshift's desktop unit. Stop and disable the old one only when the new one runs. Run `nightshift declare --host davion-sidarli --what units --hours 6 --reason '...'`.

Proof:
- `cargo test` and clippy pass, and so does `st check --quick --changed-only`.
- Live on the owner's GNOME Wayland desktop (allowed; restore focus afterwards):
  - the tray shows the current problem count (2 right now: Trends failed, Sudo use warn);
  - its panel lists them;
  - clicking one opens the Aico Status page.
- Screenshot through `st ui shot`.
- Show that an ended item doesn't count.

Rules:
- Commit with `st commit -m "..." --paths <files>`; end with "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>".
- Hold leases. Others are working in packages/web-server status files and in native/host-steward, and M4b builds the phone app.
- Never git stash, reset, checkout or rebase. Never open the neri repo or Neri data. Never read credentials, .env or key files.
- If the port needs a design call, stop and report.

Report (≤20 lines): commits, LOC, the endpoint, the live proof with screenshot path, tests, and what is still on Nightshift.
