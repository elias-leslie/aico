"""A-Term constants - shared across services, storage, and APIs.

This module defines session mode constants.
Agent tool commands and process names are now stored in the agent_tools DB table.
"""

from typing import Literal

# Shell mode constant - agent tool modes are dynamic (agent_tools.slug)
SHELL_MODE = "shell"

# Maximum number of panes allowed
MAX_PANES = 6

# Agent state machine states (stored in claude_state column)
AgentState = Literal["not_started", "starting", "running", "stopped", "error"]
