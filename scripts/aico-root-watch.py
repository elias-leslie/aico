#!/usr/bin/env python3
"""Entry point for SummitFlow's `st aico` extension.

The root-watch client lives in Tether (`scripts/aico-root-watch.py` there, with
its tests), because Tether owns the root contract it speaks. This file keeps the
path SummitFlow's tool registry runs and hands over to Tether's installed copy
with the same arguments, environment and exit status.

`TETHER_ROOT_WATCH` overrides the target; the default is the copy
`scripts/install.sh` installs.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def target(env: dict[str, str] | os._Environ[str] = os.environ) -> Path:
    override = env.get("TETHER_ROOT_WATCH")
    if override:
        return Path(override)
    lib = env.get("TETHER_LIB_DIR") or str(Path.home() / ".local" / "lib" / "tether")
    return Path(lib) / "scripts" / "aico-root-watch.py"


def main(argv: list[str]) -> int:
    script = target()
    if not script.is_file():
        # Same shape as the client's own unavailable answers: one JSON object.
        print(json.dumps({"owner": "aico", "observation": "unavailable",
                          "reason": "tether_root_watch_missing", "path": str(script)}))
        print(f"aico-root-watch: {script} not found; run scripts/install.sh",
              file=sys.stderr)
        return 2
    os.execv(sys.executable, [sys.executable, str(script), *argv])
    return 2  # not reached


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
