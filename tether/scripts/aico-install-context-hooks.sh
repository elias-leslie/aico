#!/usr/bin/env bash
# Compatibility entrypoint. Agent Hub owns canonical TUI context installation.
# The Agent Hub checkout is $AICO_AGENT_HUB_ROOT, else
# $TETHER_PROJECTS_DIR/agent-hub; with neither set it stops instead of guessing.
set -euo pipefail

if [ -n "${AICO_AGENT_HUB_ROOT:-}" ]; then
  AGENT_HUB_ROOT="$AICO_AGENT_HUB_ROOT"
elif [ -n "${TETHER_PROJECTS_DIR:-}" ]; then
  AGENT_HUB_ROOT="$TETHER_PROJECTS_DIR/agent-hub"
else
  echo "aico-install-context-hooks: set AICO_AGENT_HUB_ROOT to your Agent Hub checkout, or TETHER_PROJECTS_DIR to the folder holding it." >&2
  exit 1
fi
INSTALLER="$AGENT_HUB_ROOT/integrations/context-delivery/install.py"

if [ ! -f "$INSTALLER" ]; then
  echo "aico-install-context-hooks: Agent Hub context installer not found at $INSTALLER" >&2
  echo "Set AICO_AGENT_HUB_ROOT to your Agent Hub checkout, or skip the optional context hooks." >&2
  exit 1
fi

exec python3 "$INSTALLER" --surface antigravity
