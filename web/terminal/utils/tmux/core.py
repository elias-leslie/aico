"""Core tmux primitives: error type, command runner, session name validation, constants."""

from __future__ import annotations

import re
import subprocess

from ...logging_config import get_logger

logger = get_logger(__name__)

TMUX_COMMAND_TIMEOUT = 10  # seconds for tmux subprocess calls
TMUX_SESSION_PREFIX = "summitflow-"
_SESSION_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9_\-]+$")

# Secrets filtered from tmux session environments
FILTERED_ENV_VARS = {
    "DATABASE_URL",
    "CF_ACCESS_CLIENT_ID",
    "CF_ACCESS_CLIENT_SECRET",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "SECRET_KEY",
    "JWT_SECRET",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "GITHUB_TOKEN",
    "GITLAB_TOKEN",
    "SLACK_TOKEN",
    "DISCORD_TOKEN",
}


class TmuxError(Exception):
    """Error interacting with tmux."""


def validate_session_name(name: str) -> bool:
    """Validate tmux session name to prevent injection attacks."""
    return bool(_SESSION_NAME_PATTERN.match(name)) and len(name) < 256


def run_tmux_command(args: list[str], check: bool = False) -> tuple[bool, str]:
    """Run a tmux command with standardized error handling.

    Returns: (success, output_or_error)
    Raises: TmuxError if check=True and command fails
    """
    cmd = ["tmux", *args]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=TMUX_COMMAND_TIMEOUT)
        if result.returncode == 0:
            return True, result.stdout.strip()

        error_msg = result.stderr.strip() or f"tmux exited with code {result.returncode}"
        logger.debug("tmux_command_failed", cmd=args, error=error_msg)
        if check:
            raise TmuxError(error_msg)
        return False, error_msg
    except subprocess.TimeoutExpired as err:
        error_msg = f"tmux command timed out after {TMUX_COMMAND_TIMEOUT}s"
        logger.error("tmux_command_timeout", cmd=args)
        if check:
            raise TmuxError(error_msg) from err
        return False, error_msg
