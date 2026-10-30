# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately by opening a GitHub security advisory for this repository or by contacting the maintainer through the GitHub profile linked from the repository owner account.

Do not include public exploit details until the issue is triaged.

## Supported versions

Aico is early software. Security fixes are made on `main` only. The old AppImage releases (v0.1.0 and v0.1.1) predate the move to Tether and do not receive fixes, and no new packaged builds are made; install from source to get them.

## Security notes

- Tether serves its API only on a private Unix socket
  (`$XDG_RUNTIME_DIR/tether/<instance>/control.sock`: directory 0700, socket
  0600) and never listens on the network. The socket's file permissions are the
  only authentication, so any process running as the same user can call it.
  Reports that show another user, or a network peer, reaching the API or a
  Tether-owned tmux server are in scope.
- The web app binds to loopback and refuses other sites' pages (origin checks on
  the terminal WebSocket and on writes). With no login of its own (the default),
  it must not be exposed beyond localhost except behind an identity-aware
  gateway (Cloudflare Access on the author's host).
- Aico does not need provider API keys itself; configure third-party AI CLIs using their own secret storage.
- Keep `.env`, local state, logs, screenshots, and browser profiles out of commits.
