#!/usr/bin/env bash
# Legacy compatibility shim. Active Gemini settings point at the canonical
# client directly; retaining this delegate prevents an old config from falling
# back to a second context renderer.
set -euo pipefail

exec "${AGENT_HUB_CONTEXT_CLIENT:-$HOME/.local/bin/agent-hub-context-client}" \
  hook --surface gemini
