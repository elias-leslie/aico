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
loopback. Then turn on the link for each host:

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
see [`tether/docs/LIFECYCLE_HARNESS.md`](../tether/docs/LIFECYCLE_HARNESS.md). The 2026-07 incident report stays here as
history: [`INCIDENT-2026-07-PROCESS-ESCAPES.md`](INCIDENT-2026-07-PROCESS-ESCAPES.md).

## Development loop

```bash
npm run check                                # lint, type checks, TypeScript tests, build
uv sync --locked --directory tether/scripts  # Python env for Tether's operator scripts
tether/scripts/.venv/bin/pytest -q            # their tests, from the repo root
```

## Optional integrations

- Agent CLIs: install and authenticate `claude`, `codex`, `agy` (Antigravity), or `pi` separately; Tether's tool registry also accepts other TUI commands.
- Project catalog: Aico lists the projects Tether serves (Tether's local list, or the author's SummitFlow catalog when it is running).
