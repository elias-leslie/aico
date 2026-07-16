#!/usr/bin/env bash
# Compatibility entrypoint. Agent Hub owns canonical TUI context installation.
set -euo pipefail

exec python3 \
  /srv/workspaces/projects/agent-hub/integrations/context-delivery/install.py \
  --surface gemini
