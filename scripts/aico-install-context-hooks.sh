#!/usr/bin/env bash
# Install native mandate-injection hooks for TUIs with verified dynamic hook APIs.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GEMINI_HOOK="$REPO/scripts/tui-hooks/aico-mandates-gemini.sh"
HERMES_HOOK="$REPO/scripts/tui-hooks/aico-mandates-hermes.sh"

chmod +x "$GEMINI_HOOK" "$HERMES_HOOK"

install_gemini() {
  python3 - "$GEMINI_HOOK" <<'PY'
import json
import os
import sys
from pathlib import Path

hook = sys.argv[1]
base = Path(os.environ.get("GEMINI_CLI_HOME") or Path.home() / ".gemini")
path = base / "settings.json"
base.mkdir(parents=True, exist_ok=True)
if path.exists():
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{path} is not valid JSON: {exc}")
else:
    data = {}
hooks = data.setdefault("hooks", {})
session = hooks.setdefault("SessionStart", [])
if not any(isinstance(h, dict) and h.get("command") == hook for h in session):
    session.append({
        "name": "aico-mandates",
        "command": hook,
        "timeout": 5000,  # 5s — Gemini hook timeouts are milliseconds (Hermes' YAML is seconds)
    })
path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
print(f"gemini: installed {hook} in {path}")
PY
}

install_hermes() {
  python3 - "$HERMES_HOOK" <<'PY'
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

hook = sys.argv[1]
path = Path.home() / ".hermes" / "config.yaml"
path.parent.mkdir(parents=True, exist_ok=True)
if not path.exists():
    path.write_text("# Hermes Agent CLI Configuration\n")
text = path.read_text()
installed = hook in text
if installed:
    print(f"hermes: already installed {hook} in {path}")
elif re.search(r"(?m)^hooks\s*:", text):
    raise SystemExit(
        f"{path} already has an active hooks: block; add this manually under hooks.pre_llm_call:\n"
        f"  - command: \"{hook}\"\n"
        "    timeout: 5"
    )
if not installed:
    block = f"""

# Aico mandate injection. Managed by scripts/aico-install-context-hooks.sh.
hooks:
  pre_llm_call:
    - command: "{hook}"
      timeout: 5
"""
    path.write_text(text.rstrip() + block + "\n")
    print(f"hermes: installed {hook} in {path}")

allowlist = path.parent / "shell-hooks-allowlist.json"
try:
    data = json.loads(allowlist.read_text())
except (FileNotFoundError, json.JSONDecodeError):
    data = {"approvals": []}
approvals = [
    e for e in data.get("approvals", [])
    if not (isinstance(e, dict) and e.get("event") == "pre_llm_call" and e.get("command") == hook)
]
approvals.append({
    "event": "pre_llm_call",
    "command": hook,
    "approved_at": datetime.now(tz=timezone.utc).isoformat().replace("+00:00", "Z"),
    "script_mtime_at_approval": datetime.fromtimestamp(Path(hook).stat().st_mtime, tz=timezone.utc).isoformat().replace("+00:00", "Z"),
})
data["approvals"] = approvals
allowlist.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
print(f"hermes: allowlisted {hook} in {allowlist}")
PY
}

install_gemini
install_hermes
