#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: scripts/bump-version.sh <major.minor.patch>" >&2
  exit 2
fi

VERSION="$1"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: version must be major.minor.patch, got: $VERSION" >&2
  exit 2
fi

python - "$VERSION" <<'PY'
import json
import re
import sys
from pathlib import Path

version = sys.argv[1]

replacements = {
    Path("pyproject.toml"): (
        r'(?m)^version = "[^"]+"',
        f'version = "{version}"',
    ),
    Path("uv.lock"): (
        r'(?m)(\[\[package\]\]\nname = "a-term"\nversion = ")[^"]+(")',
        rf"\g<1>{version}\2",
    ),
}

for path, (pattern, replacement) in replacements.items():
    text = path.read_text()
    updated, count = re.subn(pattern, replacement, text, count=1)
    if count != 1:
        raise SystemExit(f"ERROR: could not update {path}")
    path.write_text(updated)

json_files = {
    Path("frontend/package.json"): 2,
    Path("packages/notes-ui/package.json"): 4,
}

for path, indent in json_files.items():
    data = json.loads(path.read_text())
    data["version"] = version
    path.write_text(json.dumps(data, indent=indent) + "\n")
PY

echo "Updated A-Term release version to $VERSION"
