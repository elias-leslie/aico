# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately by opening a GitHub security advisory for this repository or by contacting the maintainer through the GitHub profile linked from the repository owner account.

Do not include public exploit details until the issue is triaged.

## Supported versions

Aico is early software. Security fixes are made on `main` only. The tagged AppImage releases (v0.1.0 and v0.1.1) predate the move to Tether and do not receive fixes; install from source to get them.

## Security notes

- Aico's capture listener binds only to a loopback address (`127.0.0.1:8005` by default) and refuses any other. It has no authentication, so it accepts writes only from native clients and the pinned browser extension, and only with a loopback `Host` header.
- Aico does not need provider API keys itself; configure third-party AI CLIs using their own secret storage.
- Keep `.env`, local state, logs, screenshots, and browser profiles out of commits.
