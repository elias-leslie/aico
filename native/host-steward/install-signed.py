#!/usr/bin/env python3
"""Install only an archive signed by Aico's pinned update key."""
import argparse
from pathlib import Path

from host_steward.installer import install, policy

parser = argparse.ArgumentParser()
parser.add_argument("archive", type=Path)
parser.add_argument("signature", type=Path)
args = parser.parse_args()
cfg = policy()
receipt = Path(cfg["receipt"]) if cfg.get("receipt") else None
install(args.archive, args.signature, Path(cfg["public_key"]), cfg["archive_prefix"], receipt=receipt)
