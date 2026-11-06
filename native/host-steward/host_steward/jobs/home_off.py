"""host-steward home-off: home is going off on purpose; tell each paired phone app so its outage alarm stays quiet.

Run by the root unit host-steward-home-off.service at its ExecStop, i.e. at a clean poweroff of the workstation
(Before=cloudflared.service: it stops after the tunnel is down, so nothing reaches home through the tunnel once the app
has the home-off). A queued reboot, kexec or soft-reboot sends nothing: a reboot is meant to come back, and one that
doesn't alarms as any outage does. Port of Nightshift's homeoff.

One FCM data message per paired app (a `p` push with kind "home-off"; builds that predate it read a plain ping and show
nothing). Nothing is shown on the phone. Best effort inside the unit's stop budget (budget_s in data/watch.toml): every
network call is bounded by the deadline. The phone registry, FCM access token and Firebase key are the heartbeat's route
(data/heartbeat.json); root uses the token its fcm-token timer keeps, and mints one only without a current token.
"""

from __future__ import annotations

import argparse
import json
import re
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

from host_steward import fcm_wire
from host_steward.watch_settings import settings

NAME = "home-off"
HELP = "tell the paired phone apps this workstation is powering off on purpose (root; the unit's ExecStop)"

KIND = "home-off"
REBOOT_TARGETS = (
    "reboot.target",
    "kexec.target",
    "soft-reboot.target",
)  # systemd.special: the ones that come back
JOB_TIMEOUT_S = 5
TOKEN_MIN_LEFT_S = 60.0
HEARTBEAT_DATA = Path(__file__).resolve().parents[1] / "data" / "heartbeat.json"


def queued_target(listing: str) -> bool:
    """Whether `systemctl list-jobs --no-legend --plain` output holds a start job of a reboot-like target."""
    for fields in (line.split() for line in listing.splitlines()):
        if len(fields) >= 3 and fields[1] in REBOOT_TARGETS and fields[2] == "start":
            return True
    return False


def reboot_queued(run: Callable[..., Any] = subprocess.run) -> bool:
    """Whether this shutdown is a reboot: systemd holds the target's start job while it stops the units (ExecStop runs
    then). Unknown (systemctl fails) reads as no reboot, which keeps the send."""
    try:
        res = run(
            ["systemctl", "list-jobs", "--no-legend", "--plain", *REBOOT_TARGETS],
            capture_output=True,
            text=True,
            timeout=JOB_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return res.returncode == 0 and queued_target(res.stdout)


def plaintext(now: float, host: str) -> bytes:
    return json.dumps(
        {"v": 1, "id": f"h{int(now)}", "ts": int(now), "kind": KIND, "host": host}
    ).encode()


def message(dev: dict[str, Any], plain: bytes, ttl_s: int) -> dict[str, Any]:
    """The FCM v1 body: data only (no notification block), so Android hands it to the app and shows nothing."""
    ct = fcm_wire.encrypt(dev["enc_pub"], dev["auth"], plain)
    # HIGH: a dozing phone takes it now, before its next outage probe; NORMAL waits for a maintenance window
    return {
        "message": {
            "token": dev["fcm_token"],
            "data": {"t": "p", "ct": fcm_wire.b64u(ct)},
            "android": {"priority": "HIGH", "ttl": f"{ttl_s}s"},
        }
    }


def paired_devices(route: dict[str, Any]) -> list[dict[str, Any]]:
    """The phones that can be pushed to (same projection as the heartbeat's)."""
    devices = json.loads(Path(route["devices"]).read_text())
    if not isinstance(devices, list):
        return []
    return [
        {key: dev[key] for key in ("fcm_token", "enc_pub", "auth")}
        for dev in devices
        if isinstance(dev, dict)
        and dev.get("fcm_token")
        and not dev.get("token_gone")
        and dev.get("enc_pub")
        and dev.get("auth")
    ]


def access_token(route: dict[str, Any], now: float) -> tuple[str, str] | None:
    """(project, token): the kept one while current, else minted from the Firebase key (not stored)."""
    try:
        kept = json.loads(Path(route["token"]).read_text())
        if (
            kept.get("access_token")
            and kept.get("project_id")
            and float(kept.get("expires_at", 0)) - now > TOKEN_MIN_LEFT_S
        ):
            return str(kept["project_id"]), str(kept["access_token"])
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    try:
        account = json.loads(Path(route["account"]).read_text())
        token, _ = fcm_wire.mint(account, now)
        return str(account["project_id"]), token
    except (OSError, ValueError, TypeError, KeyError):
        return None


def post(project: str, token: str, body: dict[str, Any], timeout: float) -> int:
    req = urllib.request.Request(
        fcm_wire.FCM_URL.format(project=project),
        data=json.dumps(body).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return int(resp.status)
    except urllib.error.HTTPError as exc:
        return int(exc.code)
    except Exception:  # noqa: BLE001 -- unreachable, reset, timed out: the phone then alarms as it would today
        return 0


def send(
    route: dict[str, Any],
    cfg: dict[str, Any],
    deadline: float,
    now: float | None = None,
    send_one: Callable[[str, str, dict[str, Any], float], int] = post,
) -> str:
    """One home-off message to every paired app; a line for the unit's log. Stops trying at `deadline` (epoch s)."""
    now = time.time() if now is None else now
    try:
        devices = paired_devices(route)
    except (OSError, ValueError, KeyError):
        devices = []
    if not devices:
        return "app home-off: skipped (no paired app)"
    tok = access_token(route, now)
    if tok is None:
        return "app home-off: skipped (no FCM access token)"
    project, token = tok
    host = re.sub(r"[^A-Za-z0-9._-]", "", socket.gethostname()) or "the-workstation"
    plain = plaintext(now, host)
    codes = []
    for dev in devices:
        left = deadline - time.time()
        if left <= 0.5:
            codes.append("no time")
            continue
        try:
            body = message(dev, plain, int(cfg["ttl_s"]))
            codes.append(
                str(send_one(project, token, body, min(float(cfg["request_timeout_s"]), left)))
            )
        except (KeyError, TypeError, ValueError):
            codes.append("bad device record")
    return "app home-off: " + ", ".join(codes)


def add_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--heartbeat-data", type=Path, default=HEARTBEAT_DATA, help=argparse.SUPPRESS
    )


def main(
    args: argparse.Namespace, data: dict[str, Any], post_rows: Callable[..., bool] | None = None
) -> int:
    del data, post_rows
    if reboot_queued():
        print("reboot queued: no home-off sent")
        return 0
    cfg = settings("home-off")
    deadline = time.time() + float(cfg["budget_s"])
    route = json.loads(Path(args.heartbeat_data).read_text())["route"]
    out: list[str] = []

    def work() -> None:
        try:
            out.append(send(route, cfg, deadline))
        except Exception as exc:  # noqa: BLE001 -- best effort: a failed send is only a line in the log
            out.append(f"app home-off not sent ({type(exc).__name__})")

    thread = threading.Thread(
        target=work, daemon=True
    )  # a send still running at the deadline ends with the process
    thread.start()
    thread.join(max(deadline - time.time(), 0))
    print(out[0] if out else "app home-off: not done within the stop budget")
    return 0
