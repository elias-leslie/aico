#!/usr/bin/env bash
set -euo pipefail
sdk_root="$(cd -- "${BASH_SOURCE[0]%/*}" && pwd)"
cd "$sdk_root"
export PYTHONPATH="$sdk_root${PYTHONPATH:+:$PYTHONPATH}"
"$sdk_root/.venv/bin/ruff" check st_sdk tests tools_run.py
"$sdk_root/.venv/bin/ty" check
"$sdk_root/.venv/bin/python" -m pytest -c pyproject.toml tests
