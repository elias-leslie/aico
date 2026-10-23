# Agent shares

An agent shares a file or a link with `tether show` (Tether's `POST /v1/show`).
Tether copies a shared file into the exchange and publishes a `show.requested`
event; both front ends pick it up from there.

## Where shares come from

Shares are accepted only from the owner's default Tether, `tether@default`
(`$XDG_RUNTIME_DIR/tether/default/control.sock`, a socket in the owner's private
runtime directory). Events from any other instance are ignored. Agents run as
the owner, so `tether show` from any session reaches `tether@default`.

Tether writes files under `$TETHER_EXCHANGE_ROOT/agent/<session-or-none>/out/`
(default root `/srv/workspaces/exchange`). The root must already exist; Tether
creates the `agent/…/out/` directories with mode 0755.

## Web app

The web backend keeps the last 50 validated shares in memory, shared by the
event watcher and the API. Restarting the backend clears them; dropping one from
memory never removes its file. Run one backend worker so the watcher and the
API share this list.

`GET /api/a-term/shows` returns `{ "shows": [...] }` in arrival order.
`?since=<id>` returns the items after that ID; an unknown or expired ID returns
the whole list. Both this route and `GET /api/a-term/shows/<id>/file` use the
web app's normal authentication. The browser polls every ten seconds while it
is visible and again when it becomes visible. Notices stay until dismissed; a
link share offers its text and Copy only.

File reads use the backend's `tether_exchange_root` setting
(`TETHER_EXCHANGE_ROOT`, default `/srv/workspaces/exchange`, the same variable
and default as Tether's), under `agent/<session-or-none>/out/`. Every path
component is opened without following symlinks; only regular files up to
25 MiB are streamed, with bounded reads. Files download as attachments unless
PNG, JPEG, GIF or WebP magic is detected.

Each new valid share runs `nightshift push` from the backend, with a ten-second
timeout and key `show:<id>`. A failed push is logged and the share is kept. The
project identity's `hosts.browser_frontend` gives the HTTPS origin for the
`/?show=<id>` link; without it the push has no link. Opening the link selects
that share first while it is still in the list; it never visits the agent's URL.

The web app never creates, writes or cleans up exchange directories.

## Desktop

The desktop shows a notification with **Show file**, or the URL with **Copy**.
Files are copied on click into `$TETHER_EXCHANGE_ROOT/owner/shown/<id>-<name>`.
See the [README](../README.md#runtime-data-and-integrations).
