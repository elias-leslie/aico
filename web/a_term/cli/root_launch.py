"""Fixed initial process launcher. Prompt arrives transiently, never as shell text."""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys

PROMPT_ENV = "A_TERM_ROOT_INITIAL_PROMPT"


def main() -> None:
    prompt = base64.b64decode(os.environ.pop(PROMPT_ENV), validate=True).decode("utf-8")
    argv = json.loads(base64.b64decode(sys.argv[1], validate=True))
    session_name = sys.argv[2]
    # Clear the temporary session environment before entering any tool runtime.
    subprocess.run(
        ["tmux", "set-environment", "-t", session_name, "-u", PROMPT_ENV],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
    )
    os.execvpe(argv[0], [*argv, "--", prompt], os.environ)


if __name__ == "__main__":
    main()
