#!/usr/bin/env bash
# Complete outgoing history verifier from the deployed SummitFlow release (like
# scripts/st), so a half-saved checkout edit cannot weaken or break it. The live
# checkout's scripts/lib/publication-pre-push is used only before a first deploy.
release="${SUMMITFLOW_SERVICE_STATE_ROOT:-$HOME/.summitflow/services}/projects/summitflow/current/source/scripts/lib/publication-pre-push"
hook=/srv/workspaces/projects/summitflow/scripts/lib/publication-pre-push
[[ -f $release ]] && hook=$release
exec bash "$hook" "$@"
