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

## Source install

```bash
git clone https://github.com/elias-leslie/aico.git
cd aico
scripts/aico-install.sh
```

Launch and stop:

```bash
scripts/aico-launch.sh
scripts/aico-stop.sh
```

The launcher writes state under `${XDG_STATE_HOME:-~/.local/state}/aico`.

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

## Optional integrations

- Agent CLIs: install and authenticate `claude`, `codex`, `opencode`, `gemini`, `pi`, or `hermes` separately.
- Project catalog and screen/OCR capture: if an `st` CLI is installed, Aico can use `st projects` and `st ui` surfaces; otherwise it falls back to Personal Workspace and core widgets.
- Voice dictation: set `AICO_VOICE_WS` to a compatible local speech-to-text websocket. If it is unavailable, only voice dictation is disabled.
- Browser extension: load `extension/` unpacked in Chrome/Chromium.

## Ubuntu AppArmor note

Ubuntu 24.04+ can block Electron's sandbox from creating an unprivileged user namespace. `scripts/aico-install.sh` detects the checkout's Electron binary and, when `sudo` is available in an interactive shell, loads a path-correct `aico-electron` AppArmor profile. If it cannot do that automatically, it prints the exact manual commands to run.
