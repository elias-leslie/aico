# Aico web app

The browser and phone app of [Aico](../README.md): the same Tether sessions as
the desktop, with a phone keyboard, file browsing, uploads and search.
`frontend/` is the Next.js UI, built as a static export; `server/` is the Node
server (`aico-web.service`, port 3002) that serves it with the API (`/api`),
the terminal sockets (`/ws`) and `/health`. `scripts/` holds the
`tsession`/`tclaude`/`tcodex` launchers and verification helpers.

Install and run it with the repo's [`scripts/install.sh`](../scripts/install.sh).
The [web app guide](../docs/web-guide.md) covers configuration and features;
[remote access](../docs/remote-access.md) and
[mobile verification](../docs/mobile-verification.md) cover the phone.

Develop from the repo root: `npm ci`, then `npm run check`.
