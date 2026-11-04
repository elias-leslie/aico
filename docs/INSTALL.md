# Install and develop Aico

Install Aico from source; there is no packaged build. The old AppImages on the [Releases page](https://github.com/elias-leslie/aico/releases) (v0.1.0 and v0.1.1, June 2026) predate the move to Tether, manage tmux sessions themselves and are unsupported.

## System packages

On Debian/Ubuntu-like systems, install the basics first:

```bash
sudo apt-get update
sudo apt-get install -y \
  git curl ca-certificates build-essential tmux python3 make g++
```

Install Node.js 22+ using the method you trust for your system. Tether needs
systemd 254+, cgroup v2 and tmux at `/usr/bin/tmux`.

## Source install

```bash
git clone https://github.com/elias-leslie/aico.git
cd aico
scripts/install.sh --dry-run   # print every step; change nothing
scripts/install.sh --start
```

`scripts/install.sh` installs the whole product from this checkout:

- runs `npm ci` (one workspace: Tether, web server and front end)
  and runs `npm run build`;
- installs Tether's bundle, CLI and agent shims into `~/.local/lib/tether`
  (`TETHER_LIB_DIR`) and links `~/.local/bin/tether` (`TETHER_BIN_DIR`);
- renders the user units in `scripts/systemd/` for this checkout
  (`aico-web`, `tether@default`) plus
  the `tether@.service` template into `${XDG_CONFIG_HOME:-~/.config}/systemd/user/`,
  then reloads the user manager;
- links `~/.pi/agent/extensions/st-coord.ts` to SummitFlow's Pi coordination
  extension, only when SummitFlow is installed;
- turns on user linger so sessions survive logout.

`--start` also enables and restarts `tether@default` and `aico-web`, the web
app's one Node server on port 3002. `--skip-systemd` installs files only (no units, no
systemd checks), for clean-room runs. The installer is safe to rerun: it
rewrites only files whose content changed. Rerun it after moving the checkout.
A test Tether instance runs with `systemctl --user start tether@dev` and is never
enabled at boot.

### Remote hosts

Tether can also show and run sessions on other machines that run their own
Tether (docs/plans/remote-hosts.md). List them in `~/.config/tether/hosts.json`;
without that file Tether works exactly as before.

```json
[{ "name": "agent-work", "ssh": "agent-work",
   "socket": "/run/user/1000/tether/default/control.sock",
   "forwards": ["8001", "8003"] }]
```

`ssh` is a Host alias from `~/.ssh/config` that logs in without a prompt.
`forwards` (optional) lists workstation ports the host may reach on its own
loopback. `sync` (optional) is the path of the other host's notes-sync socket,
`/run/user/<uid>/aico/sync.sock` (the same path on every host); with it, the
same link carries notes sync (`-L <peerDir>/sync.sock:<sync>`), and both
hosts must list each other. Then turn on the link for each host:

```bash
systemctl --user enable --now tether-link@agent-work
tether hosts        # link state and session count per host
```

The link retries quietly while the host is down and never powers it on. Tether
picks up changes to hosts.json within a few seconds. The remote host runs a
stock Tether (`TETHER_HEADLESS=1` when it has no desktop); its sshd should set
`ClientAliveInterval 15`.

On a host with SummitFlow, `st service rebuild aico` deploys instead. It also
restarts `tether@default` on the new release when Tether's source (`tether/`
or its unit) changed since the release Tether runs from;
`st service rebuild aico --worker tether@default` deploys Tether alone.
Remote hosts need no copy of their own: when the hub's link to a host comes
up and the host's Tether is on an older API, the hub installs its own release
there and restarts that Tether (a host that is off is updated when it next
comes up). `tether hosts` shows each host's `apiVersion` and last `update`.

### A second machine running Aico (notes on both)

Runtime peer connections now use the [pinned fleet link](fleet-link.md). The
SSH deployment command below is a manual bootstrap/rescue route. Do not enable
SSH peer link units: configure and approve the fleet keys instead.

A host without SummitFlow (such as the gem container) gets the same build from
the workstation's checkout:

```bash
scripts/deploy-remote.sh <ssh-alias>            # copy the git-tracked tree, then scripts/install.sh --start there
scripts/deploy-remote.sh <ssh-alias> --dry-run  # show the copy; change nothing
```

It rsyncs the tracked files to `$AICO_REMOTE_DIR` (default
`/srv/workspaces/projects/aico`, where the shipped units expect the checkout;
`node_modules` and builds stay between runs) and runs `scripts/install.sh --start`
there, so there is one installer. The machine needs Node 22+ (the same major as
the workstation), npm, git, Python 3, tmux, rsync, a systemd user manager with
linger, and for notes `libheif-examples` and `rclone`. Deploy the machine
with the older database first, so a newer schema never reaches a host that
cannot read it; a different schema pauses sync and the Hosts card says so.

Once per machine, as drop-ins (they survive redeploys):

```ini
# ~/.config/systemd/user/aico-web.service.d/host.conf
[Service]
Environment=AICO_HOST_NAME=gem          # the name this host writes on its rows; workstation on the other side
# ~/.config/systemd/user/tether@default.service.d/headless.conf   (a machine with no desktop)
[Service]
Environment=TETHER_HEADLESS=1
```

Then list each machine in the other's `hosts.json` with `ssh`, `socket` and
`sync`, and enable `tether-link@<name>` on both sides. Both doors then
list every host's asks and shares (Tether's hub relays them; an answer goes to the host that owns the ask), and
only the owning host pushes.

A machine without Nightshift (the gem container) sends its pushes through the Proxmox host: set
`AICO_PUSH_SSH=pve-alerts` in an `aico-web.service.d` drop-in and give the container an ssh alias `pve-alerts` for
`root@<pve>` with its own key. On the Proxmox host that key is forced to
[`native/pve-sender/aico-push`](../native/pve-sender/aico-push) (copy it to `/usr/local/sbin/aico-push`, mode 0755):

```
restrict,from="<container ip>",command="/usr/local/sbin/aico-push" ssh-ed25519 AAAA... aico-gem-push
```

The script reads one Aico notice on stdin, checks every field, and sends it with the dead-man alarm's own sender
(`nightshift.deadman.send`, so the app route and Web Push, with credentials only root holds there), once per key.
The notice's optional `open` link (Aico origin only, plain, at most 300 characters) is what a tap or the Open button opens.
The key opens no shell and takes no arguments from the caller. The host firewall must let the container reach port 22
(one rule in the node's `host.fw`). Such a push has no Nightshift item (it shows in the Proxmox push log, tag
`aico-push`) and cannot be resolved afterwards.

Another guest uses the same script with its own key: the forced command carries the caller's name
(`command="/usr/local/sbin/aico-push portfolio"`; no name means `aico`). `CALLERS` in the script holds each caller's
allowed `source`, key form, link host (`aico.` or `port.` in Nightshift's `open_hosts`), size limits, severities and
dedupe window, so one caller's key cannot send another's notices. `portfolio` (Portfolio-AI on VM 180, key line
`restrict,from="<vm ip>",command="/usr/local/sbin/aico-push portfolio" ... portfolio-vm180-push`) takes the notice
Portfolio-AI builds for `nightshift push --json` as is: kinds alert/todo/info, keys `portfolio-ai:...`, `actions` and
`cooldown` ignored, `push: "tray"` sent as a silent info, and a repeat of a key is dropped only within 24 hours.
The Hosts card shows "different Aico version" when the two bundles differ
(`hello.build_id` is a fingerprint of the server bundle, `AICO_BUILD_ID` overrides it).

Aico connects to `$TETHER_SOCKET`, else
`$XDG_RUNTIME_DIR/tether/${TETHER_INSTANCE:-default}/control.sock`. If Tether is
down, open views keep their terminals; new sessions, End and other session
actions report that session control is unavailable until it is back.

Configuration is read from environment variables only; see
[Configuration](project-guide.md#configuration) for how to set them for the managed
units. The web app keeps its tabs in `${XDG_STATE_HOME:-~/.local/state}/aico/web.db`.

Tether keeps diagnostics for each session (ownership ID, tmux server generation and socket, session and
pane IDs, pane scope, resource use and lifecycle warnings). Session lifecycle,
historical `/tmp/tmux-$(id -u)/aico` sessions and incident recovery are Tether's;
see [`packages/tether/docs/LIFECYCLE_HARNESS.md`](../packages/tether/docs/LIFECYCLE_HARNESS.md). The 2026-07 incident report stays here as
history: [`INCIDENT-2026-07-PROCESS-ESCAPES.md`](INCIDENT-2026-07-PROCESS-ESCAPES.md).

## Development loop

```bash
npm run check                                # lint, type checks, TypeScript tests, build
uv sync --locked --directory native/host-steward  # Python env for Tether's operator scripts
native/host-steward/.venv/bin/pytest -q            # their tests, from the repo root
```

## Optional integrations

- Agent CLIs: install and authenticate `claude`, `codex`, `agy` (Antigravity), or `pi` separately; Tether's tool registry also accepts other TUI commands.
- Project catalog: Aico lists the projects Tether serves (Tether's local list, or the author's SummitFlow catalog when it is running).
