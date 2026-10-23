# Security Policy

## Reporting a Vulnerability

Please report suspected vulnerabilities using
[GitHub's private vulnerability reporting](https://github.com/elias-leslie/tether/security/advisories/new).

Include:

- affected component or endpoint
- reproduction steps or proof of concept
- expected impact
- any known workaround or mitigation

Do not open a public GitHub issue for a suspected security problem.

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest `main` | Yes |
| older commits and snapshots | No |

## Response Expectations

Security reports are handled on a best-effort basis. No formal SLA is offered.

## Trust boundary

Tether serves its API only on a private Unix socket
(`$XDG_RUNTIME_DIR/tether/<instance>/control.sock`: directory 0700, socket
0600). It never listens on the network. The socket's file permissions are the
only authentication, so any process running as the same user can call the API.

An app that puts Tether behind its own HTTP surface, as A-Term does, must keep
its own authentication in front of it and must not treat loopback traffic as
authenticated. Reports that show another user, or a network peer, reaching the
API or a Tether-owned tmux server are in scope.
