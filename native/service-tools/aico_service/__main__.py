"""The standalone `st service` compatibility owner."""

import os

from st_sdk import state

from .commands.service import app

state.set_compact_output(True)
app(prog_name=f"{os.environ.get('AICO_CLI_NAME') or 'st'} service")
