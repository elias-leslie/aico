# Install and develop Aico

Aico is currently distributed as a source-installed Linux desktop app.

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

Aico's durable-session contract also requires:

- a running systemd user manager and cgroup v2 (`/sys/fs/cgroup/cgroup.controllers`),
- tmux per-pane systemd scopes (`tmux-spawn-<uuid>.scope`), and
- `Linger=yes` for the desktop user so graphical logout does not stop the user
  manager and intended tmux sessions.

The installer enables and verifies linger. If policy prevents that, run:

```bash
sudo loginctl enable-linger "$USER"
```

New sessions are blocked rather than launched without these guarantees. Aico
never terminates existing sessions merely because a prerequisite becomes
temporarily unavailable.

## Source install

```bash
git clone https://github.com/elias-leslie/aico.git
cd aico
scripts/aico-install.sh
```

The installer runs `npm ci`, rebuilds native Electron modules, syncs the locked
Python 3.13 sidecar environment with `uv`, writes a desktop entry under
`~/.local/share/applications`, and installs the `aico-shell.service` and
`aico-owner.service` user units into `${XDG_CONFIG_HOME:-~/.config}/systemd/user/`
(rendered for this checkout, followed by `systemctl --user daemon-reload`). It
is safe to rerun; rerun it after moving the checkout.

On Linux it also offers to give Electron's `chrome-sandbox` helper root
ownership and the setuid bit. Privileged steps never reuse cached `sudo` credentials. The installer prints each command first and runs it only when you answer yes in an interactive shell or set `AICO_INSTALL_PRIVILEGED=1`; otherwise you run the printed commands yourself.

```bash
AICO_INSTALL_PRIVILEGED=1 scripts/aico-install.sh
```

The optional TUI context hooks (`AICO_INSTALL_CONTEXT_HOOKS=1`) need an Agent Hub
checkout; set `AICO_AGENT_HUB_ROOT` if it is not at
`/srv/workspaces/projects/agent-hub`.

Launch and stop:

```bash
scripts/aico-launch.sh
scripts/aico-stop.sh
```

The launcher writes its pidfile, lock, and `launcher.log` under
`${XDG_STATE_HOME:-~/.local/state}/aico`. Configuration is read from environment
variables only; see [Configuration](project-guide.md#configuration) for how to
set them for the managed unit.

Use **Copy session diagnostics** inside a widget to inspect its stable ownership
ID, tmux server generation/socket, session and pane IDs, gate-dispatch state,
exact pane scope, systemd InvocationID, CPU, memory, swap, task count, age, and
lifecycle warnings. Targeted incident recovery is documented in
[`INCIDENT-2026-07-PROCESS-ESCAPES.md`](INCIDENT-2026-07-PROCESS-ESCAPES.md).

Historical lifecycle-v0 sessions stay on `/tmp/tmux-$(id -u)/aico` and remain
attachable but lifecycle-read-only. Do not broad-kill them to migrate. Create a
new managed widget and move work deliberately; A-Term lists both historical and
catalogued managed-generation sockets.

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

- Agent CLIs: install and authenticate `claude`, `codex`, `opencode`, `gemini`, `pi`, or `hermes` separately.
- Project catalog and screen/OCR capture: if an `st` CLI is installed, Aico can use `st projects` and `st ui` surfaces; otherwise it falls back to Personal Workspace and core widgets.
- Voice dictation: Aico connects to `ws://127.0.0.1:8003/api/voice/ws?user_id=aico&app=aico` unless `AICO_VOICE_WS` names another compatible speech-to-text websocket. If nothing answers, only voice dictation fails.
- Browser extension: load `extension/` unpacked in Chrome/Chromium.

## Ubuntu AppArmor note

Ubuntu 24.04+ can set `kernel.apparmor_restrict_unprivileged_userns=1`, which blocks Electron's sandbox from creating an unprivileged user namespace. Only when that sysctl is `1`, `scripts/aico-install.sh` generates the minimal Ubuntu-style profile (`userns` for this checkout's Electron binary) named `aico-electron-<hash of the binary path>`, so separate checkouts get separate profiles. It prints the profile path and the `install`/`apparmor_parser` commands, and runs them only on opt-in as described above. The binary is in your user-writable checkout, so anything that replaces it also gets the permission. A profile named plain `aico-electron` from older installers can be removed with `sudo apparmor_parser -R /etc/apparmor.d/aico-electron && sudo rm /etc/apparmor.d/aico-electron`.
