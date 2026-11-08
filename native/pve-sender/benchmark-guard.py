#!/usr/bin/python3 -I
"""Synthetic loop overhead only: tmpfs sensor/state, no cgroups or real backup."""
from __future__ import annotations

import json
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from pve_sender import backup_guard as guard


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="aico-guard-bench-", dir="/dev/shm") as work:
        root = Path(work)
        cfg = guard.config(HERE / "backup-guard.json")
        cfg.update(runtime_dir=str(root / "run"), state_dir=str(root / "state"),
                   hwmon_root=str(root / "hwmon"), boot_id_path=str(root / "boot"))
        (root / "boot").write_text("benchmark-boot")
        hw = root / "hwmon" / "hwmon0"
        hw.mkdir(parents=True)
        (hw / "name").write_text("k10temp")
        (hw / "temp1_label").write_text("Tctl")
        (hw / "temp1_input").write_text("60000")
        state = guard.tick(cfg, {}, enforce=lambda *_: None, starting=True)
        start = time.process_time()
        samples = 200
        for _ in range(samples):
            state = guard.tick(cfg, state, enforce=lambda *_: None)
        cpu = time.process_time() - start
        rss_kib = next(int(line.split()[1]) for line in Path("/proc/self/status").read_text().splitlines()
                       if line.startswith("VmRSS:"))
        print(json.dumps({
            "samples": samples, "cpu_ms_per_sample": round(cpu * 1000 / samples, 3),
            "rss_mib": round(rss_kib / 1024, 2),
            "sample_s": cfg["sample_s"],
            "evidence": "synthetic tmpfs sensor and heartbeat; cgroup command stubbed",
        }))


if __name__ == "__main__":
    main()
