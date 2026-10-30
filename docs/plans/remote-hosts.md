# Remote hosts: agents on other machines, driven from one Aico

Status: the owner approved this direction on 2026-10-29. It was revised after
an adversarial review. Phase 1a (the hub and the link) is built; the API is in
tether/docs/api-v1.md "Remote hosts".

Owner goal: the owner and coordinators start, watch and steer agents running
on this workstation or on a Proxmox work VM. They do it from the same Aico
pane, on the desktop and on the phone PWA. Remote sessions look like local
ones. Heavy builds and labs run off the workstation.

## Shape

The local Tether daemon is the hub. Each remote host runs a stock Tether.
Every client keeps talking to its one local socket: Electron, the web server
(the PWA path), `st aico` and SummitFlow's `tether.py`. That way all of them
see remote sessions without any federation logic of their own, as ADR 0001
intends (Tether owns sessions).

```
Aico desktop ─┐                              ┌─ tether@default on agent-work
Aico web/PWA ─┼─ local tether@default (hub) ─┼─ (more hosts later)
st aico / SF ─┘   └ peers from hosts.json     └ via tether-link@<host> ssh
```

### Hosts registry (data, not code): `~/.config/tether/hosts.json`

```json
[{ "name": "agent-work", "ssh": "agent-work",
   "socket": "/run/user/1000/tether/default/control.sock",
   "forwards": ["8001", "8003"],
   "wake": ["st", "vm", "start", "200"] }]
```

- `ssh` is an ssh Host alias, never an IP address.
- `forwards` is optional, per host. It lists the workstation SummitFlow and
  Agent Hub ports exposed to that host through `-R`.
- `wake` is optional. It is the command that powers the host on.

### Link: `tether-link@<host>.service` (a user unit on the workstation)

- Command: `ssh -N -M -S $XDG_RUNTIME_DIR/tether/peers/<host>/ssh.ctl`, plus
  `-L .../<host>/control.sock:<socket>` and the
  `-R 127.0.0.1:<p>:127.0.0.1:<p>` forwards.
- ssh options: `ExitOnForwardFailure=yes`, `StreamLocalBindUnlink=yes`,
  `ServerAliveInterval=15`, `ConnectTimeout=5` and `BatchMode=yes`.
- It restarts quietly with backoff. It never powers a host on.
- On the VM side, sshd uses `ClientAliveInterval 15`.

### Hub (the local tether daemon)

- **Peers** are read from hosts.json. Each peer is a `TetherClient` on its
  forwarded socket.
- **Session list:** `GET /v1/sessions` (and runs) merges local sessions with
  the peers' sessions.
  - Peers are queried in parallel, with a short timeout and a circuit
    breaker per peer.
  - Each descriptor gains `host: string | null`, where null means local.
  - When a peer is unreachable, its last-known items stay in the list,
    marked `peer: {state: "offline"|"powered_off"|"connecting", since}`.
    They are never reported as gone.
- **Routing:** per-session routes (`/v1/(sessions|widgets|roots|wakes)/:id/...`)
  are forwarded verbatim to the owning peer, using an id→host map.
  - Ids stay global (8 hex characters).
  - A duplicate id at merge is logged, and the local copy wins.
- **Events:** the hub follows each peer's event stream and re-emits the
  events with `host`. When a peer reconnects, it emits a resync event.
- **GUI channel:** the hub holds each peer's `/v1/gui/channel` and bridges it
  into its own channel.
- **Create:** `POST /v1/sessions` and `POST /v1/roots` accept `host`.
  - If the host is powered off, the hub runs `wake`.
  - It then waits for the link and the forwarded Agent Hub to be healthy
    before forwarding the create.
- **Lineage:** when a remote root is created with `launchedBy` set to a local
  coordinator, the hub records the foreign `coordinatorId` and colour on the
  peer.
- **Tools and projects:** `/v1/tools` and `/v1/projects` accept `?host=`.

### Clients (Electron, web server)

- **Attach:** when the descriptor has a `host`, the client builds
  `/usr/bin/ssh -F /dev/null -T -o BatchMode=yes -o ProxyCommand=false -S <ctl> <alias> -- env LANG=C.UTF-8 /usr/bin/tmux -u -C -S '<sock>' attach-session -t '<target>'`.
  - The inputs come from hosts.json and from Tether's answer. Each remote
    argument is shell-quoted.
  - `controlArgv` and `socketArgsOf` know about the ssh prefix. Paste
    (`load-buffer`) uses the same prefix.
  - The tmux socket path is validated against the host's state-dir pattern.
- **Pid:** after attaching, the client reads `#{client_pid}` in the control
  session. The resize claim and "Viewing on" use that pid.
- **Reattach:** when a link is lost but the generation is unchanged, the
  client reattaches on the peer's resync or reconnect, with bounded retries.
  This covers the desktop and the web `TerminalHub`.
- **UI:**
  - Remote windows get a host badge.
  - The + dialog gets a host picker.
  - Windows show an offline or powered-off state.
  - A Hosts panel shows each host's state, power, resources and sessions,
    plus sign-in state per tool.

### Agents on a host

- Paths mirror the workstation: projects live at
  `/srv/workspaces/projects/<p>` on the VM too.
- Checkouts of claude-config, codex-config, agent-hub, aico and summitflow
  are pushed from the workstation. Work projects are checked out on demand.
- Retained work comes back to the workstation by fetching branches, or
  through Neri and Agent Hub records. Nothing on the host is durable.
- The remote Tether runs with `TETHER_HEADLESS=1`.
- Snapshots are taken only when the Tether catalog is empty. Rollback and
  poweroff end sessions first. Clones are made from a clean snapshot.

### Credentials: split by whether the login rotates

- **Non-rotating** logins are served by Agent Hub at launch. This covers
  Claude Code via a dedicated `claude setup-token` token run by the
  unmodified CLI, API keys such as Pi's opencode-go and minimax keys, and
  agy's Google login if it is verified not to rotate.
  - Agent Hub owns a per-tool map, keyed by tool slug, recording the
    credential, how it is delivered and whether it rotates. It also has a
    narrow endpoint scoped to a per-host bearer token. Revoking that token
    revokes the host.
  - On the host, one PATH shim (`~/.local/bin/<tool>` →
    `agent-hub-cred-exec <tool>`) fetches the credential over `-R 8003`,
    sets the env var or a tmpfs auth file symlinked into the tool's real
    config dir, then execs the next tool binary (the context launcher). The
    shim fails closed.
  - Never point a tool's whole config dir at tmpfs: Tether reads session
    files there for agent state and resume.
- **Rotating** logins (Codex CLI, Pi OAuth entries) are signed in on the
  host itself and stay on its disk.
  - Never hand Agent Hub's own Codex pair to a host: refresh-token reuse
    detection would break Agent Hub's provider.
  - Take the clean snapshot after sign-in, so rollback keeps the login.
    Each clone signs in separately.
- **Sign-in UX**: the Hosts entry offers Sign in per tool. It opens a
  short-lived Aico terminal on that host running the tool's own
  device-code or paste-code login (`claude setup-token`,
  `codex login --device-auth`, Pi `/login`), so it also works from the
  phone. For the non-rotating tier, `agent-hub credential push` on the host
  posts the result to Agent Hub. Status comes from a host-side
  `login status` call through the hub.
  - Desktop: the action registry, reached from the lantern menu and the
    command palette.
  - PWA: a section in `SessionSidebar` or the new-session sheet.
- Out of scope: the `agent-hub` tool, a chat with no pane, runs on the
  workstation; the `shell` tool needs no login. The owner token file is
  never copied to a host.

### Power

- **Start:** only on create, via `wake`.
- **Stop:** a timer on the guest powers it off after 15 minutes with all of
  these true:
  - zero sessions;
  - no pending wakes;
  - low load;
  - no ssh sessions other than the link.

### Cross-host messaging

`st sessions send` to a remote agent goes through the hub's
`POST /v1/sessions/:id/inject`. Waits use the agent state in descriptors.
The `_coord.json` ledger stays per host.

## Phases

1. **Hub, link and client attach.**
   - 1a: the Tether daemon hub and the link unit.
   - 1b: Electron and web attach over ssh, the remote pid, reattach, the
     badge and the picker.
2. **Create on a host:** wake, readiness gate, lineage, `st aico create --host`
   and VM bring-up.
3. **Credentials:** the Agent Hub API, the per-tool rows and the Hosts panel.
4. **Finish:** cross-host send, the idle poweroff timer and snapshot hygiene.
   Then an adversarial code review and an end-to-end test: launch from a
   coordinator, send a message, watch on the phone, roll the VM back.
