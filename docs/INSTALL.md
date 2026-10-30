# Install and develop Aico

Install Aico from source; there is no packaged build. The old AppImages on the [Releases page](https://github.com/elias-leslie/aico/releases) (v0.1.0 and v0.1.1, June 2026) predate the move to Tether, manage tmux sessions themselves and are unsupported.

## System packages

On Debian/Ubuntu-like systems, install the basics first:

```bash
sudo apt-get update
sudo apt-get install -y \
  git curl ca-certificates build-essential tmux python3 make g++ \
  libgtk-3-0 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libgbm1 libasound2t64 libxss1 libxtst6 libxrandr2 libxdamage1 \
  libxcomposite1 libxkbcommon0 libxshmfence1 libpango-1.0-0 libcairo2
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

- runs `npm ci` (one workspace: desktop, Tether, web server and front end),
  makes sure Electron's binary is present, and runs `npm run build`;
- installs Tether's bundle, CLI and agent shims into `~/.local/lib/tether`
  (`TETHER_LIB_DIR`) and links `~/.local/bin/tether` (`TETHER_BIN_DIR`);
- renders the user units in `scripts/systemd/` for this checkout
  (`aico-shell`, `aico-web`, `tether@default`) plus
  the `tether@.service` template into `${XDG_CONFIG_HOME:-~/.config}/systemd/user/`,
  then reloads the user manager;
- writes `~/.local/share/applications/aico.desktop`;
- links `~/.pi/agent/extensions/st-coord.ts` to SummitFlow's Pi coordination
  extension, only when SummitFlow is installed;
- turns on user linger so sessions survive logout.

`--start` also enables and restarts `tether@default` and `aico-web`, the web
app's one Node server on port 3002. The desktop's `aico-shell.service` is started by
`scripts/aico-launch.sh`. `st service rebuild aico` restarts it only while it runs, so
once you quit the desktop app, deploys leave it off. `--skip-systemd` installs files only (no units, no
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

Electron's sandbox needs unprivileged user namespaces. When the kernel
restricts them, the installer offers an AppArmor profile (see the
[AppArmor note](#ubuntu-apparmor-note) below). Only when namespaces stay
unavailable (no profile installed, or the kernel turns them off) does it offer
to give Electron's `chrome-sandbox` helper root ownership and the setuid bit.
Privileged steps never reuse cached `sudo` credentials. The installer prints each command first and runs it only when you answer yes in an interactive shell or set `AICO_INSTALL_PRIVILEGED=1`; otherwise you run the printed commands yourself.

```bash
AICO_INSTALL_PRIVILEGED=1 scripts/install.sh
```

Aico connects to `$TETHER_SOCKET`, else
`$XDG_RUNTIME_DIR/tether/${TETHER_INSTANCE:-default}/control.sock`. If Tether is
down, open windows keep their terminals; new sessions, End and other session
actions report that session control is unavailable until it is back.

Launch and stop the desktop app:

```bash
scripts/aico-launch.sh
scripts/aico-stop.sh
```

The launcher writes its pidfile, lock, and `launcher.log` under
`${XDG_STATE_HOME:-~/.local/state}/aico`. Configuration is read from environment
variables only; see [Configuration](project-guide.md#configuration) for how to
set them for the managed unit.

Use **Copy session diagnostics** inside a widget to copy Tether's diagnostics
for that session (ownership ID, tmux server generation and socket, session and
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

Run the Electron app from the checkout:

```bash
npm start
```

## Optional integrations

- Agent CLIs: install and authenticate `claude`, `codex`, `agy` (Antigravity), or `pi` separately; Tether's tool registry also accepts other TUI commands.
- Project catalog: Aico lists the projects Tether serves (Tether's local list, or the author's SummitFlow catalog when it is running) plus its own Personal Workspace.

## Ubuntu AppArmor note

Ubuntu 24.04+ can set `kernel.apparmor_restrict_unprivileged_userns=1`, which blocks Electron's sandbox from creating an unprivileged user namespace. Only when that sysctl is `1`, `scripts/install.sh` generates the minimal Ubuntu-style profile (`userns` for this checkout's Electron binary) named `aico-electron-<hash of the binary path>`, so separate checkouts get separate profiles. It prints the profile path and the `install`/`apparmor_parser` commands, and runs them only on opt-in as described above. The binary is in your user-writable checkout, so anything that replaces it also gets the permission. A profile named plain `aico-electron` from older installers attaches to the same binary, and two such profiles conflict so neither applies; when it targets this checkout, the installer includes its removal in the same commands. Moving the checkout leaves the old path's profile behind; remove it with `sudo apparmor_parser -R` and `sudo rm` on that file. With the profile installed, the installer leaves `chrome-sandbox` alone; without it, it offers the setuid helper as the fallback.
