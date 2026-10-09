#!/usr/bin/env bash
# Compatibility entrypoint. Agent Hub owns canonical TUI context installation.
# Point AICO_AGENT_HUB_ROOT at an Agent Hub checkout when it is not at the
# default location.
set -euo pipefail

AGENT_HUB_ROOT="${AICO_AGENT_HUB_ROOT:-/srv/workspaces/projects/agent-hub}"
INSTALLER="$AGENT_HUB_ROOT/integrations/context-delivery/install.py"

if [ ! -f "$INSTALLER" ]; then
  echo "aico-install-context-hooks: Agent Hub context installer not found at $INSTALLER" >&2
  echo "Set AICO_AGENT_HUB_ROOT to your Agent Hub checkout, or skip the optional context hooks." >&2
  exit 1
fi

exec python3 "$INSTALLER" --surface antigravity
