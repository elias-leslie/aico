#!/usr/bin/env bash
set -euo pipefail
service_root="$(cd -- "${BASH_SOURCE[0]%/*}" && pwd)"
cd "$service_root"
# The venv is not committed and the SDK is a path dependency (not editable): a stale one would test an
# SDK this tree does not ship. Every SDK source change bumps its version. The stage can't sync it itself:
# st check runs it offline, and an acceptance worktree's venv is the main checkout's.
want="$(python3 -c "import tomllib; print(tomllib.load(open('../st-sdk/pyproject.toml', 'rb'))['project']['version'])")"
have="$(.venv/bin/python -c "import importlib.metadata as m; print(m.version('summitflow-st-sdk'))" 2>/dev/null)" || have="none"
if [ "$have" != "$want" ]; then
    echo "service-tools venv has SDK $have, the tree has $want: run 'uv sync --locked --directory native/service-tools'" >&2
    exit 1
fi
export PYTHONPATH="$service_root${PYTHONPATH:+:$PYTHONPATH}"
"$service_root/.venv/bin/ruff" check aico_service tests
"$service_root/.venv/bin/python" -m pytest -c pyproject.toml tests
