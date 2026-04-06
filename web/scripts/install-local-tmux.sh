#!/usr/bin/env bash
set -euo pipefail

# Minimum tmux version required by A-Term.
# All features used (capture-pane -e -J, window-size latest,
# a-term-features sync) are available in tmux 3.2+.
MIN_TMUX_MAJOR=3
MIN_TMUX_MINOR=2

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMUX_CONFIG="${REPO_ROOT}/config/tmux/tmux.conf"
TMUX_CONF_LINK="${HOME}/.tmux.conf"

if [[ ! -f "${TMUX_CONFIG}" ]]; then
  echo "missing tmux config: ${TMUX_CONFIG}" >&2
  exit 1
fi

# ── Check for tmux ──────────────────────────────────────────────
if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is not installed." >&2
  echo "" >&2
  echo "Install it with your package manager:" >&2
  echo "  Ubuntu/Debian: sudo apt install tmux" >&2
  echo "  Fedora/RHEL:   sudo dnf install tmux" >&2
  echo "  Arch:          sudo pacman -S tmux" >&2
  echo "  macOS:         brew install tmux" >&2
  exit 1
fi

# ── Version check ───────────────────────────────────────────────
TMUX_VERSION_STR="$(tmux -V 2>/dev/null || true)"
# Extract major.minor from strings like "tmux 3.4" or "tmux 3.6a"
if [[ "${TMUX_VERSION_STR}" =~ tmux[[:space:]]+([0-9]+)\.([0-9]+) ]]; then
  TMUX_MAJOR="${BASH_REMATCH[1]}"
  TMUX_MINOR="${BASH_REMATCH[2]}"
else
  echo "could not parse tmux version from: ${TMUX_VERSION_STR}" >&2
  echo "please ensure tmux >= ${MIN_TMUX_MAJOR}.${MIN_TMUX_MINOR} is installed" >&2
  exit 1
fi

if (( TMUX_MAJOR < MIN_TMUX_MAJOR || (TMUX_MAJOR == MIN_TMUX_MAJOR && TMUX_MINOR < MIN_TMUX_MINOR) )); then
  echo "tmux ${TMUX_MAJOR}.${TMUX_MINOR} is too old (need >= ${MIN_TMUX_MAJOR}.${MIN_TMUX_MINOR})" >&2
  echo "upgrade with your package manager or build from source" >&2
  exit 1
fi

# ── Symlink config ──────────────────────────────────────────────
if [[ -e "${TMUX_CONF_LINK}" && ! -L "${TMUX_CONF_LINK}" ]]; then
  echo "refusing to replace existing ${TMUX_CONF_LINK}; move it to ~/.tmux.local.conf first" >&2
  exit 1
fi

ln -sfn "${TMUX_CONFIG}" "${TMUX_CONF_LINK}"

echo "tmux $(tmux -V | awk '{print $2}') — ok (>= ${MIN_TMUX_MAJOR}.${MIN_TMUX_MINOR})"
echo "config link: ${TMUX_CONF_LINK} -> ${TMUX_CONFIG}"
