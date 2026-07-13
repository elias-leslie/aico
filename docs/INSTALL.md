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
Python 3.13 sidecar environment with `uv`, and writes a desktop entry under
`~/.local/share/applications`.
On Linux it also configures Electron's `chrome-sandbox` helper with root ownership when passwordless `sudo` is available; otherwise it prints the manual `sudo chown`/`chmod` commands needed before launching the sandboxed app.

Launch and stop:

```bash
scripts/aico-launch.sh
scripts/aico-stop.sh
```

The launcher writes state under `${XDG_STATE_HOME:-~/.local/state}/aico`.

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
- Voice dictation: set `AICO_VOICE_WS` to a compatible local speech-to-text websocket. If it is unavailable, only voice dictation is disabled.
- Browser extension: load `extension/` unpacked in Chrome/Chromium.

## Ubuntu AppArmor note

Ubuntu 24.04+ can block Electron's sandbox from creating an unprivileged user namespace. `scripts/aico-install.sh` detects the checkout's Electron binary and, when `sudo` is available in an interactive shell, loads a path-correct `aico-electron` AppArmor profile. If it cannot do that automatically, it prints the exact manual commands to run.
