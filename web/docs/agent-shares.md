# Agent handoffs

A-Term accepts `show.requested` only from `TETHER_AGENT_SOCKET` (default
`/run/tether/agent/default/control.sock`). It retains the last 50 validated
metadata records in memory, shared by the event watcher and API. Restarting
the backend clears them; evicting metadata never removes exchange files.
Run one backend worker so the watcher and polling requests share this ring.

`GET /api/a-term/shows` returns `{ "shows": [...] }` in arrival order.
`?since=<id>` returns items after that retained ID. An unknown or expired ID
returns the retained ring. Both this endpoint and
`GET /api/a-term/shows/<id>/file` use the existing browser-route authentication.
The browser polls every ten seconds while visible and on becoming visible.
Toasts remain until dismissed; URL shares offer text and Copy only.

File reads use `TETHER_EXCHANGE_ROOT` (default `/srv/workspaces/exchange`),
under `agent/<session-or-none>/out/`. The owner service needs read/traverse
permission there. Every path component is opened without following symlinks;
only regular files up to 25 MiB are streamed, with bounded reads. Files download
as octet-stream attachments unless PNG, JPEG, GIF or WebP magic is detected.
Uploads and their age cleanup remain in their existing upload directory.

Each new valid handoff attempts `nightshift push` from the owner backend,
with a ten-second timeout and key `show:<id>`. Nightshift must be installed
and configured for that service user. Push failures are logged and do not
discard the handoff. The existing project identity's `hosts.browser_frontend`
supplies the HTTPS origin for `/?show=<id>` links; without that host, push
omits `--open`. Opening this link selects that handoff first while it remains
in the ring; it never visits the agent's URL.

Deploy the backend and frontend together using the normal managed release.
No exchange directory is created, written or cleaned up by A-Term.
