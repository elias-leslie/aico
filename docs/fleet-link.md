# Fleet link (M11a)

The Tether daemon owns one TLS 1.3 connection per configured peer pair. The
machine with the lower short hostname dials; either end opens channels. Control
HTTP, event streams, terminal processes, uploads, notes sync and job leases use
that connection. SSH is a manual administration/rescue route, never a fallback.

Each machine generates an Ed25519 key in its Aico state directory, mode 0600.
Node's crypto and TLS implement all cryptography. OpenSSL only issues the
self-signed certificate wrapper: Node 22 can read X.509 certificates but has no
certificate issuance API. The certificate is not a CA or a trust root. Both ends
check its Ed25519 public key against the root-owned allowlist before accepting
application traffic. Hello/auth signatures bind the names and protocol version
to the TLS exporter, preventing a captured auth frame from being reused on a
new connection. See [Node TLS](https://nodejs.org/docs/latest-v22.x/api/tls.html)
and [Node crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html).

`contracts/fleet-frames.schema.json` defines hello, auth, control, event, sync and
terminal-view frames. Channel opens name a local service (control, sync, jobs)
or carry a command argv (exec). Data frames carry bytes as base64. Terminal
commands preserve literal argv, stdout, stderr, stdin and exit status.

## Enrollment

Run `tether fleet identity` on the new machine. Its JSON contains only the
machine's public key, short hostname and enrollment code. Save that public JSON
on the approving machine, then run:

```sh
tether fleet enroll /path/to/public-enrollment.json
```

The existing Needs-you ask shows the machine and code. Compare it with the
new machine's display. Once the owner answers Approve, a root invocation of
`tether fleet approve PUBLIC_FILE ASK_ID ALLOWLIST` checks the exact answered
question and atomically adds that pin. Reject, an open ask, another code or a
replacement key is refused. The daemon never writes pins. Initial enrollment
uses the owner's administration route to distribute the approved public
allowlist to both machines. No existing credentials are copied.

The allowlist is a JSON list of `{ "name": "short-hostname", "publicKey":
"base64-SPKI" }`. It must be root-owned and not group/world writable. Removing
a pin disconnects its live connection and prevents reconnect without restarting
the daemon. An unreadable or malformed allowlist fails closed.

## Configuration

`AICO_FLEET_CONFIG`, otherwise `~/.config/aico/fleet.json`, contains deployment
data. A missing file leaves a standalone machine. Required fields:

- `machine`: this machine's lower-cased short hostname.
- `stateDir`: its Aico state directory; `allowlist`: the public root-owned file.
- `listen`: `{ "address": "LAN-IP", "port": PORT }`.
- `peers`: `[{ "name": "peer-short-hostname", "endpoint": { "address": "LAN-IP", "port": PORT } }]`.
- `syncSocket`, optional `jobsSocket`, and `peerRoot`: local service/proxy paths.
- `retryMinMs`, `retryMaxMs`, `deadMs`, `statusMs`, and `statusUrl`.

Listeners must name an existing local private IPv4 or loopback address. Public
addresses, wildcard binds, DNS names and IPv6 are refused. Peer addresses are
also literal private IPv4/loopback addresses. Declare live listeners with
Nightshift before starting them. There is no internet ingress path.

The `hosts.json` catalog still owns presentation, wake and placement metadata.
Only names present in the fleet configuration are federated. Use the actual
short hostname, not the old SSH alias. Old per-host link units are compatibility
units that start the daemon; they no longer start SSH. Unenrolled machines stay
unavailable until enrolled; the 14-host enrollment and signed updates are M11b.
Production automatic unsigned peer updates are disabled.

Reconnect uses jittered exponential backoff. Transport liveness uses socket
silence, without a ping/probe deadline. Status writes use the existing loopback
M1 endpoint. Each peer gets a machine link row with last/next seen; disconnected
rows become late, and the M1 machine rule marks that machine's rows unknown.

## Job leases

Each job may set `lease_host` (default: home) and `workers` (default: home only).
The configured holder alone stores the lease in its jobs.db. Portable jobs can
use the always-on container as holder while preferring the workstation for
execution. Jobs needing local hardware or files keep their home-only worker
list. All workers must have the same job definition.

Claim, renew, complete, read and run-now reach the configured holder through
`jobs.sock` over the fleet connection. The holder supplies its own clock, TTL,
schedule and eligible workers. A backup waits one lease period past the due
time. Claim increments the durable fence and changes the lease id; an old
holder's renew/result is refused after takeover. Work is not killed for taking
long. Jobs must remain idempotent: fencing rejects the stale result, not the
external side effect the old worker may already have made.

There is no lease fallback during a partition. If the sole authority is down,
workers cannot claim. To survive the home execution machine going off, put the
lease authority on another agreed machine. There is no leader election or
consensus. A runner restart preserves fences in the holder's jobs.db.

## Verification

`st check --quick --changed-only` exercises frame fixtures, real local TLS
connections, control/sync traffic in both directions, unknown/revoked keys,
reconnect, enrollment answer binding, and fenced takeover through two TLS
peers. The cross-machine drill is separate: stop the home runner mid-job,
observe the second machine complete under the next fence, then submit the old
result and observe refusal. Local TLS tests do not establish that live drill.
