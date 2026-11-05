"""The standalone `st service` compatibility owner."""

from st_sdk import state

from .commands.service import app

state.set_compact_output(True)
app(prog_name="st service")
