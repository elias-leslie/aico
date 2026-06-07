"""Run the sidecar: `python -m aico_sidecar`.

Host/port come from the environment (AICO_SIDECAR_HOST/PORT); Electron's main
process spawns this and waits for /health.
"""

from __future__ import annotations

import ctypes
import signal
import sys

import uvicorn

from aico_sidecar.app import create_app
from aico_sidecar.config import Settings


def _die_with_parent() -> None:
    """Get SIGTERM'd if Electron (our parent) dies — even via crash/SIGKILL,
    where its `before-quit` handler (and so Sidecar.stop()) never runs and would
    otherwise leave us orphaned holding the port. Linux-only; a no-op elsewhere.
    """
    if sys.platform != "linux":
        return
    PR_SET_PDEATHSIG = 1
    ctypes.CDLL("libc.so.6", use_errno=True).prctl(PR_SET_PDEATHSIG, signal.SIGTERM)


def main() -> None:
    _die_with_parent()
    settings = Settings.from_env()
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, log_level="info")


if __name__ == "__main__":
    main()
