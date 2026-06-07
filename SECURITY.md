# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately by opening a GitHub security advisory for this repository or by contacting the maintainer through the GitHub profile linked from the repository owner account.

Do not include public exploit details until the issue is triaged.

## Supported versions

Aico is early source-release software. Security fixes are made on `main` until tagged releases exist.

## Security notes

- The sidecar binds to `127.0.0.1` by default. Do not expose it to a network unless you understand the unauthenticated local-control API.
- Aico does not need provider API keys itself; configure third-party AI CLIs using their own secret storage.
- Keep `.env`, local state, logs, screenshots, and browser profiles out of commits.
