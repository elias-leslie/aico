#!/usr/bin/env python3
"""Run argv through the existing same-user advisory admission lanes."""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Sequence

from st_sdk.admission import _LEASE_ENV, HeavyWorkError, admission_state, heavy_work


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--label", required=True, help="Public operation label; omit secrets.")
    parser.add_argument("--class", dest="work_class", choices=("heavy", "light"), default="heavy",
                        help="light: short work with its own one-at-a-time lane, never behind a full gate or build. "
                             "It cannot start heavy work under it, and waits as heavy while the host is under pressure.")
    parser.add_argument("command", nargs=argparse.REMAINDER, help="Executable and arguments after --.")
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("an executable is required after --")
    try:
        # Under a light lane already, it stays there: heavy couldn't start under it.
        under_light = os.environ.get(_LEASE_ENV, "").startswith("light:")
        work_class = args.work_class if admission_state().admit or under_light else "heavy"
        with heavy_work(args.label, work_class=work_class) as work:
            result = work.run(command, check=False)
    except HeavyWorkError as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1
    except OSError as exc:
        print(json.dumps({"error": "Tool could not be started."}), file=sys.stderr)
        return 127 if isinstance(exc, FileNotFoundError) else 126
    return result.returncode if result.returncode >= 0 else 128 - result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
