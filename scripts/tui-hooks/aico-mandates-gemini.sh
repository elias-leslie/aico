#!/usr/bin/env bash
# Gemini SessionStart hook. stdout must be JSON only.
set -euo pipefail

cat >/dev/null || true

context="$(st mandates 2>/dev/null || true)"
if [ -z "${context//[[:space:]]/}" ]; then
  printf '{}\n'
  exit 0
fi

python3 -c '
import json
import sys

context = sys.stdin.read()
print(json.dumps({"hookSpecificOutput": {"additionalContext": context}}))
' <<<"$context"
