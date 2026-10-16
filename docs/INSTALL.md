# Install and develop Aico

Install Aico from source. The AppImages on the [Releases page](https://github.com/elias-leslie/aico/releases) (latest v0.1.1, June 2026) predate the move to Tether: they manage tmux sessions themselves, without Tether. The current code on `main` requires Tether and has no AppImage release yet.

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

Install Node.js 22+ and `uv` using the methods you trust for your system. The Python sidecar requires Python 3.13+; `uv venv --python 3.13` can use an existing Python 3.13 interpreter or a uv-managed one.

Aico requires [Tether](https://github.com/elias-leslie/tether) (API v1 or
later), the per-user session daemon that owns every tmux server, agent launch,
End, root request and context hook. Install and start it from its checkout
first:

```bash
git clone https://github.com/elias-leslie/tether.git ../tether
cd ../tether                        # or wherever Tether is checked out
npm ci
scripts/install.sh --start default
tether --json version                # prints one JSON object with "apiVersion": 1
```

Tether's installer checks the durable-session prerequisites (systemd user
manager, cgroup v2, lingering). Aico itself only needs a systemd user manager
for `aico-shell.service`. Aico connects to `$TETHER_SOCKET`, else
`$XDG_RUNTIME_DIR/tether/${TETHER_INSTANCE:-default}/control.sock`. If Tether is
down, open windows keep their terminals; new sessions, End and other session
actions report that session control is unavailable until it is back.

## Source install

```bash
git clone https://github.com/elias-leslie/aico.git
cd aico
scripts/aico-install.sh
```

The installer first requires `tether --json version` to report API v1 or later
(otherwise it prints the Tether install steps and exits; set `TETHER_REPO` if your Tether checkout is not next to this one). It then runs `npm ci`, rebuilds native Electron modules, syncs the locked
Python 3.13 sidecar environment with `uv`, writes a desktop entry under
`~/.local/share/applications`, and installs the `aico-shell.service` user unit
into `${XDG_CONFIG_HOME:-~/.config}/systemd/user/`
(rendered for this checkout, followed by `systemctl --user daemon-reload`). It
is safe to rerun; rerun it after moving the checkout.

On Linux it also offers to give Electron's `chrome-sandbox` helper root
ownership and the setuid bit. Privileged steps never reuse cached `sudo` credentials. The installer prints each command first and runs it only when you answer yes in an interactive shell or set `AICO_INSTALL_PRIVILEGED=1`; otherwise you run the printed commands yourself.

```bash
AICO_INSTALL_PRIVILEGED=1 scripts/aico-install.sh
```

Launch and stop:

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
see its `docs/LIFECYCLE_HARNESS.md`. The 2026-07 incident report stays here as
history: [`INCIDENT-2026-07-PROCESS-ESCAPES.md`](INCIDENT-2026-07-PROCESS-ESCAPES.md).

## Development loop

```bash
npm run lint
npm run typecheck
npm test
npm run test:sidecar
npm run build
```

Or:

```bash
npm run check
```

Run the sidecar alone:

```bash
.venv/bin/python -m aico_sidecar
curl http://127.0.0.1:8005/health
```

Run the Electron app from the checkout:

```bash
npm start
```

To add the locked PyInstaller toolchain before building an AppImage:

```bash
uv sync --frozen --python 3.13 --extra dev --extra release
npm run dist
```

## Optional integrations

- Agent CLIs: install and authenticate `claude`, `codex`, `agy` (Antigravity), or `pi` separately; Tether's tool registry also accepts other TUI commands.
- Project catalog: Aico lists the projects Tether serves (Tether's local list, or the author's SummitFlow catalog when it is running) plus its own Personal Workspace.
- Browser extension: load `extension/` unpacked in Chrome/Chromium.

## Ubuntu AppArmor note

Ubuntu 24.04+ can set `kernel.apparmor_restrict_unprivileged_userns=1`, which blocks Electron's sandbox from creating an unprivileged user namespace. Only when that sysctl is `1`, `scripts/aico-install.sh` generates the minimal Ubuntu-style profile (`userns` for this checkout's Electron binary) named `aico-electron-<hash of the binary path>`, so separate checkouts get separate profiles. It prints the profile path and the `install`/`apparmor_parser` commands, and runs them only on opt-in as described above. The binary is in your user-writable checkout, so anything that replaces it also gets the permission. A profile named plain `aico-electron` from older installers attaches to the same binary, and two such profiles conflict so neither applies; when it targets this checkout, the installer includes its removal in the same commands. Moving the checkout leaves the old path's profile behind; remove it with `sudo apparmor_parser -R` and `sudo rm` on that file.
