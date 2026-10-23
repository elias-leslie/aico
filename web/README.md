# Aico web app

The browser and phone front end of [Aico](../README.md): the same Tether
sessions as the desktop, with a phone keyboard, file browsing, uploads and
search. `frontend/` is the Next.js UI (port 3002); `a_term/` is its Python
backend (port 8002, the `a_term` module name stays until the backend moves to
Node).

Install and run it with the repo's [`scripts/install.sh`](../scripts/install.sh).
The [web app guide](../docs/web-guide.md) covers configuration and features;
[remote access](../docs/remote-access.md) and
[mobile verification](../docs/mobile-verification.md) cover the phone.

Develop from the repo root: `npm ci`, `(cd web && uv sync --locked --extra dev)`,
then `npm run check` and `web/.venv/bin/pytest -q`.
