"""The [section] of data/watch.toml: settings of input-watch, display-guard and home-off."""

from __future__ import annotations

import tomllib
from functools import cache
from pathlib import Path
from typing import Any

PATH = Path(__file__).with_name("data") / "watch.toml"


@cache
def settings(section: str) -> dict[str, Any]:
    with PATH.open("rb") as handle:
        return tomllib.load(handle)[section]
