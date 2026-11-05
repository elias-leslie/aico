#!/usr/bin/env bash
set -euo pipefail
service_root="$(cd -- "${BASH_SOURCE[0]%/*}" && pwd)"
cd "$service_root"
export PYTHONPATH="$service_root${PYTHONPATH:+:$PYTHONPATH}"
"$service_root/.venv/bin/ruff" check aico_service tests
"$service_root/.venv/bin/python" -m pytest -c pyproject.toml tests
