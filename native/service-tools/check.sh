#!/usr/bin/env bash
set -euo pipefail
service_root="$(cd -- "${BASH_SOURCE[0]%/*}" && pwd)"
cd "$service_root"
# The venv is not committed and the SDK is a path dependency (not editable): sync it to uv.lock when its
# installed SDK is not the one in the tree, so this stage tests the SDK it ships with. Every SDK source
# change bumps that version. Only then is uv (and a build) needed.
want="$(python3 -c "import tomllib; print(tomllib.load(open('../st-sdk/pyproject.toml', 'rb'))['project']['version'])")"
have="$(.venv/bin/python -c "import importlib.metadata as m; print(m.version('summitflow-st-sdk'))")"
if [ "$have" != "$want" ]; then
    uv sync --locked --quiet || {
        echo "service-tools venv has SDK $have, the tree has $want: run 'uv sync --locked --directory native/service-tools'" >&2
        exit 1
    }
fi
export PYTHONPATH="$service_root${PYTHONPATH:+:$PYTHONPATH}"
"$service_root/.venv/bin/ruff" check aico_service tests
"$service_root/.venv/bin/python" -m pytest -c pyproject.toml tests
