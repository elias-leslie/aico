"""Root-local backup admission and slice quota; no remote probes or job cancellation."""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import math
import os
import queue
import signal
import subprocess
import sys
import threading
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

from .state import write

DEFAULT_CONFIG = Path("/etc/aico/backup-guard.json")


class Deferred(Exception):
    """A managed export can be tried after the observed condition clears."""


def load(path: Path) -> dict:
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def config(path: Path) -> dict:
    cfg = json.loads(path.read_text())
    if not (0 < cfg["sample_s"] < cfg["stale_s"]
            and 0 < cfg["recover_c"] < cfg["hot_c"] < cfg["critical_c"] <= 150
            and isinstance(cfg["hot_samples"], int) and cfg["hot_samples"] > 0
            and 0 < cfg["critical_cpu_percent"] <= cfg["hot_cpu_percent"]
            <= cfg["normal_cpu_percent"]):
        raise ValueError("Invalid guard policy.")
    if not (cfg["slice"].endswith(".slice") and cfg["scope"].endswith(".scope")):
        raise ValueError("Invalid backup units.")
    return cfg


def cpu_temperature(cfg: dict) -> float | None:
    """Read only the configured CPU package sensor. Missing/bogus is unknown."""
    def reading(path: Path) -> float | None:
        try:
            value = int(path.read_text()) / 1000
            return value if 0 < value <= 150 else None
        except (OSError, ValueError):
            return None

    cached = cfg.get("_sensor_path")
    if cached is not None:
        value = reading(cached)
        if value is not None:
            return value
        cfg.pop("_sensor_path", None)
    for hw in Path(cfg["hwmon_root"]).glob("hwmon*"):
        try:
            if (hw / "name").read_text().strip() != cfg["sensor_chip"]:
                continue
            for label in hw.glob("temp*_label"):
                if label.read_text().strip() == cfg["sensor_label"]:
                    path = label.with_name(label.name.replace("_label", "_input"))
                    value = reading(path)
                    if value is not None:
                        cfg["_sensor_path"] = path
                        return value
        except (OSError, ValueError):
            continue
    return None


def boot_id(cfg: dict) -> str:
    return Path(cfg["boot_id_path"]).read_text().strip()


def quota(cfg: dict, mode: str) -> float:
    level = "normal" if mode == "normal" else "hot" if mode == "hot" else "critical"
    return cfg[f"{level}_cpu_percent"]


def decide(cfg: dict, state: dict, temperature: float | None, now: float) -> dict:
    """Sustained heat tightens the limit; the lower recovery threshold gives hysteresis."""
    next_state = dict(state)
    old_limit = state.get("limit_mode", "normal")
    count = 0
    limit = old_limit
    if temperature is None:
        mode = "unavailable"
    elif temperature >= cfg["critical_c"]:
        mode = limit = "critical"
    elif temperature <= cfg["recover_c"]:
        mode = limit = "normal"
    elif temperature >= cfg["hot_c"]:
        count = state.get("hot_count", 0) + 1
        mode = limit = ("critical" if old_limit == "critical" else "hot"
                        if old_limit == "hot" or count >= cfg["hot_samples"] else "normal")
    else:
        mode = limit = old_limit
    next_state.update(mode=mode, limit_mode=limit, hot_count=min(count, cfg["hot_samples"]))
    episode = dict(state.get("episode", {}))
    if mode in ("hot", "critical", "unavailable"):
        if not episode or episode.get("ended_at") is not None:
            episode = {"id": uuid.uuid4().hex, "started_at": now, "peak_mode": mode}
        elif mode == "critical" or (mode == "hot" and episode.get("peak_mode") == "unavailable"):
            episode["peak_mode"] = mode
    elif mode == "normal" and episode and episode.get("ended_at") is None:
        episode["ended_at"] = now
    if episode:
        next_state["episode"] = episode
    return next_state


def persistent(state: dict) -> dict:
    """Consecutive observations are deliberately lost across restarts and downtime."""
    return {key: state[key] for key in ("mode", "limit_mode", "episode") if key in state}


def set_quota(cfg: dict, mode: str, *, run=subprocess.run) -> None:
    run(["systemctl", "--no-ask-password", "set-property", "--runtime", cfg["slice"],
         f"CPUQuota={quota(cfg, mode):g}%"], check=True, capture_output=True, text=True)


def tick(cfg: dict, state: dict, *, now: float | None = None, temperature=None,
         sample=cpu_temperature, enforce=set_quota, starting=False, publish=None) -> dict:
    now = time.time() if now is None else now
    if temperature is None:
        temperature = sample(cfg)
    if (not isinstance(temperature, int | float) or isinstance(temperature, bool)
            or not math.isfinite(temperature) or not 0 < temperature <= 150):
        temperature = None
    result = decide(cfg, state, temperature, now)
    if starting or result["limit_mode"] != state.get("limit_mode"):
        enforce(cfg, result["limit_mode"])
    snapshot = {
        **result, "observed_at": now, "boot_id": boot_id(cfg),
        "temperature_c": temperature, "cpu_quota_percent": quota(cfg, result["limit_mode"]),
        "admission_open": result["mode"] == "normal",
        "delivery_machine": cfg["delivery_machine"],
        "policy": {key: cfg[key] for key in (
            "hot_c", "hot_samples", "critical_c", "recover_c", "sample_s", "stale_s",
            "normal_cpu_percent", "hot_cpu_percent", "critical_cpu_percent",
        )},
    }
    if persistent(state) != persistent(result):
        write(Path(cfg["state_dir"]) / "state.json", persistent(result))
    # Heartbeat lives in tmpfs, never the journal or persistent storage.
    write(Path(cfg["runtime_dir"]) / "status.json", snapshot)
    if publish is not None and (result.get("episode"), result["mode"]) != (state.get("episode"), state.get("mode")):
        try:
            publish(status_row(cfg, snapshot, now))
        except Exception:  # noqa: BLE001 -- failed status delivery never stops local protection
            print("aico-backup-guard: status publication failed; periodic checks will reconcile.", file=sys.stderr)
    return result


def fresh(cfg: dict, snapshot: dict, now: float) -> bool:
    observed = snapshot.get("observed_at")
    return (isinstance(observed, int | float) and not isinstance(observed, bool)
            and math.isfinite(observed) and 0 <= now - observed <= cfg["stale_s"]
            and snapshot.get("boot_id") == boot_id(cfg))


def admission(cfg: dict, snapshot: dict, now: float) -> None:
    if not fresh(cfg, snapshot, now):
        raise Deferred("Backup waits for a fresh local temperature check.")
    if not snapshot.get("admission_open") or snapshot.get("mode") != "normal":
        raise Deferred("Backup waits for the host to cool and its CPU sensor to be available.")


@contextlib.contextmanager
def lock(path: Path, message: str):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("a") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise Deferred(message) from error
        yield


def run_export(cfg: dict, command: list[str], *, run=subprocess.run, now=None) -> int:
    directory = Path(cfg["runtime_dir"])
    with lock(directory / "export.lock", "Backup waits for the active host export to finish."):
        admission(cfg, load(directory / "status.json"), time.time() if now is None else now)
        active = run(["systemctl", "--no-ask-password", "is-active", "--quiet", cfg["scope"]],
                     check=False, capture_output=True)
        if active.returncode == 0:
            raise Deferred("Backup waits for the active host export to finish.")
        # A fixed scope name independently refuses overlap if this caller is lost but its job remains.
        result = run(["systemd-run", "--scope", "--quiet", "--collect",
                      f"--unit={cfg['scope']}", f"--slice={cfg['slice']}", "--", *command],
                     check=False)
        return result.returncode


def budget(cfg: dict, *, now=None) -> dict:
    """A guest exporter can read its host's ceiling without claiming another slot."""
    snapshot = load(Path(cfg["runtime_dir"]) / "status.json")
    allowed = True
    try:
        admission(cfg, snapshot, time.time() if now is None else now)
    except Deferred:
        allowed = False
    value = snapshot.get("cpu_quota_percent", cfg["normal_cpu_percent"])
    if (not isinstance(value, int | float) or isinstance(value, bool)
            or not math.isfinite(value) or not 0 < value <= cfg["normal_cpu_percent"]):
        value = cfg["normal_cpu_percent"]
    return {"quotaPercent": value, "admit": allowed, "sampleSeconds": cfg["sample_s"]}


def _notice_payload(cfg: dict, snapshot: dict, now: float, previous: dict) -> tuple[dict | None, dict]:
    current = True
    try:
        admission(cfg, snapshot, now)
    except Deferred:
        current = False
    current_sample = fresh(cfg, snapshot, now)
    episode = snapshot.get("episode", {})
    phase = snapshot.get("mode") if current_sample else "unavailable"
    if phase == "normal":
        if (not episode or "ended_at" not in episode) and (not previous or previous["phase"] == "recovered"):
            return None, previous
        phase = "recovered"
    elif phase not in ("hot", "critical", "unavailable"):
        return None, previous
    source_id = episode.get("id") if current_sample else None
    same_source = source_id and source_id == previous.get("source_id")
    continuing = previous and previous["phase"] != "recovered" and (
        source_id is None or same_source or previous.get("fallback")
    )
    episode_id = (previous["episode_id"] if same_source or continuing
                  else source_id or uuid.uuid4().hex)
    metadata = {"episode_id": episode_id, "source_id": source_id, "phase": phase,
                "fallback": source_id is None}
    return {
        "episode_id": episode_id, "phase": phase,
        "temperature_c": snapshot.get("temperature_c") if current_sample else None,
        "cpu_quota_percent": snapshot.get("cpu_quota_percent", cfg["normal_cpu_percent"]),
        "admission_open": current, "delivery_machine": cfg["delivery_machine"],
    }, metadata


def notice_payload(cfg: dict, snapshot: dict, now: float) -> dict | None:
    """Persist identity only on incident phase changes, shared by both local producers."""
    directory = Path(cfg["state_dir"])
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / "notice.lock").open("a") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        path = directory / "notice.json"
        previous = load(path)
        payload, metadata = _notice_payload(cfg, snapshot, now, previous)
        if metadata != previous:
            write(path, metadata)
        return payload


def status_row(cfg: dict, snapshot: dict, now: float, machine: str | None = None) -> dict:
    """One guard row for immediate transitions and the existing periodic reconciliation."""
    machine = machine or cfg["machine"]
    payload = notice_payload(cfg, snapshot, now)
    phase = payload["phase"] if payload else "normal"
    temperature = snapshot.get("temperature_c") if phase != "unavailable" else None
    cpu = payload["cpu_quota_percent"] if payload else snapshot["cpu_quota_percent"]
    condition = "CPU temperature unavailable." if temperature is None else f"CPU {temperature:g} C."
    allowed = payload["admission_open"] if payload else snapshot.get("admission_open", False)
    meaning = f"{condition} {'Backups may start' if allowed else 'New backups wait'}; CPU limit {cpu:g}%."
    sender_cfg = load(Path(cfg["sender_config"]))
    deadline = sum(sender_cfg.get(key, 0) for key in ("tick_s", "status_relay_s", "slack_s"))
    row = {"id": f"{machine}/check-backup-guard", "what": "Backup thermal guard", "kind": "check",
           "machine": machine, "state": "failed" if phase == "critical" else "warn"
           if phase in ("hot", "unavailable") else "ok", "meaning": meaning,
           "last_run": datetime.fromtimestamp(now, UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
           "next_run": datetime.fromtimestamp(now + max(deadline, cfg["stale_s"]), UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
           "actions": [{"kind": "log", "ref": "journalctl -u aico-backup-guard.service"}]}
    if payload is not None:
        row["guard"] = payload
    return row


def publish_row(cfg: dict, row: dict, *, run=subprocess.run) -> bool:
    """Reuse the PVE sender's existing loopback transport; no probes or phone route."""
    sender_cfg = load(Path(cfg["sender_config"]))
    result = run(sender_cfg["status_command"], input=json.dumps([row]), text=True,
                 capture_output=True, timeout=30, check=False)
    return result.returncode == 0


class Publisher:
    """A phase queue keeps both critical and recovery while the sensor loop stays local."""

    def __init__(self, cfg: dict, publish=publish_row):
        self.items = queue.Queue()
        self.cfg, self.publish = cfg, publish
        self.thread = threading.Thread(target=self.work, daemon=True, name="backup-guard-status")
        self.thread.start()

    def __call__(self, row: dict) -> None:
        self.items.put(row)

    def work(self) -> None:
        while True:
            row = self.items.get()
            try:
                if row is None:
                    return
                try:
                    if not self.publish(self.cfg, row):
                        raise OSError("Status transport refused the row.")
                except Exception:  # noqa: BLE001 -- delivery is independent of enforcement
                    print("aico-backup-guard: status publication failed; periodic checks will reconcile.", file=sys.stderr)
            finally:
                self.items.task_done()


def daemon(cfg: dict) -> int:
    directory = Path(cfg["runtime_dir"])
    with lock(directory / "daemon.lock", "The local backup guard is already running."):
        (directory / "status.json").unlink(missing_ok=True)
        subprocess.run(["systemctl", "--no-ask-password", "start", cfg["slice"]],
                       check=True, capture_output=True, text=True)
        state = persistent(load(Path(cfg["state_dir"]) / "state.json"))
        publisher = Publisher(cfg)
        stopping = threading.Event()

        def stop(_signal, _frame):
            stopping.set()

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        first = True
        try:
            while not stopping.is_set():
                started = time.monotonic()
                state = tick(cfg, state, starting=first, publish=publisher)
                first = False
                # Signals interrupt this wait without killing an export or extra timer wakeups.
                stopping.wait(max(0, started + cfg["sample_s"] - time.monotonic()))
        finally:
            (directory / "status.json").unlink(missing_ok=True)
            publisher.items.put(None)
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="aico-backup-guard")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("daemon", help="Sample local CPU temperature and enforce backup CPU quotas")
    sub.add_parser("status", help="Show the last local guard sample")
    sub.add_parser("budget", help="Read the host CPU ceiling for a guest exporter")
    export = sub.add_parser("run", help="Admit and limit one host backup export")
    export.add_argument("argv", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    try:
        cfg = config(Path(args.config))
        if args.command == "budget":
            print(json.dumps(budget(cfg)))
            return 0
        if args.command == "status":
            snapshot = load(Path(cfg["runtime_dir"]) / "status.json")
            print(json.dumps(snapshot))
            admission(cfg, snapshot, time.time())
            return 0
        if os.geteuid() != 0:
            raise ValueError("The backup guard must run as root.")
        if args.command == "daemon":
            return daemon(cfg)
        command = args.argv[1:] if args.argv[:1] == ["--"] else args.argv
        if not command:
            raise ValueError("A host export command is required.")
        return run_export(cfg, command)
    except Deferred as error:
        print(f"aico-backup-guard: {error}", file=sys.stderr)
        return 75
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(f"aico-backup-guard failed ({type(error).__name__}); check its service and policy.",
              file=sys.stderr)
        return 1
