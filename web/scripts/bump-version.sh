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


def replace_project_version(text: str, version: str) -> str:
    lines = text.splitlines(keepends=True)
    in_project = False
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped == "[project]":
            in_project = True
            continue
        if in_project and stripped.startswith("[") and stripped.endswith("]"):
            break
        if in_project and re.match(r'^version = "[^"]+"', line):
            lines[index] = re.sub(r'(^version = ")[^"]+(")', rf"\g<1>{version}\2", line)
            return "".join(lines)
    raise SystemExit("ERROR: could not update pyproject.toml [project].version")


replacements = {
    Path("uv.lock"): (
        r'(?m)(\[\[package\]\]\nname = "a-term"\nversion = ")[^"]+(")',
        rf"\g<1>{version}\2",
    ),
}

pyproject = Path("pyproject.toml")
pyproject.write_text(replace_project_version(pyproject.read_text(), version))

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
