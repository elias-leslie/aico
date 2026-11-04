"""Auth-config and listener tripwire (detection only; the workstation and the PVE host).

Port of ns/checks/tripwire.py. It keeps a sha256 + owner/mode/type signature of sudoers (and every file sudo includes),
sshd_config(.d), pam.d and root's and the owner's authorized_keys, plus the non-loopback listening TCP/UDP sockets.
The first run baselines silently. A change is recorded as an event, the baseline moves to the new state, and the event
stays a problem for `hold_hours`. Nothing is ever modified or blocked.

Network novelty is a record, never an alert (owner 2026-10-31): a listener change is a note naming who opened it unless
the internet reaches it through a cloudflared ingress rule or a root login from outside the workstation falls in its
window. dpkg/ucf staging files are never tracked. A change to a file a package owns, made while dpkg touched that
package since the previous check, is a note; so is a daemon listener from a system unit out of such a package. Changes
traced at observation time to our own agent sessions or services (attribution.py), a `host-steward declare` covering
the change (declare.py), and a daemon coming back after a boot are notes too. Anything nothing explains is a failed
signal. Owner decision 2026-10-24: every agent is the owner with root, so nothing asks "was this you?".

Not ported: Nightshift's install receipts and apt.upgrade receipts (the root executor they came from is gone; a
change an installer makes is declared instead).

State (root-owned): <state_dir>/tripwire/<host>.json, the same layout Nightshift kept, so its baselines carry over.
"""

from __future__ import annotations

import contextlib
import fcntl
import functools
import glob
import hashlib
import json
import os
import re
import stat as statmod
from collections.abc import Callable, Generator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from host_steward import attribution, core, declare, listeners
from host_steward.checks import pve
from host_steward.core import Ctx, Signal

ID = "tripwire"
STATE_TAIL = 50  # events kept per host
_INCLUDE = re.compile(r"^[ \t]*[@#]include(dir)?[ \t]+(.*?)[ \t]*$")


# ---------------------------------------------------------------- sudoers walk and file signatures


def include_path(arg: str, host: str | None = None) -> str:
    """An include line's path as sudo reads it: in double quotes, or up to the first unescaped blank; a backslash
    makes the next character literal (an escaped blank or quote); %h is the short host name."""
    if host is None:
        import socket

        host = socket.gethostname().split(".")[0]
    out: list[str] = []
    quoted = arg.startswith('"')
    i = int(quoted)
    while i < len(arg):
        c = arg[i]
        if (quoted and c == '"') or (not quoted and c in " \t"):
            break
        if c == "\\" and i + 1 < len(arg):
            out.append(arg[i + 1])
            i += 2
            continue
        if c == "%" and arg[i + 1 : i + 2] == "h":
            out.append(host)
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def sudoers_walk(
    patterns: list[str], max_files: int = 200, host: str | None = None
) -> list[tuple[str, str]]:
    """Every file sudo reads, as (path, how): the patterns ('r'), plus what their @include ('i') and @includedir ('d')
    lines (and legacy #include/#includedir) name, followed recursively (relative names resolve against the including
    file's directory, as sudo does). A path an include line names is 'i' even when a pattern listed it first: sudo
    reads it whatever its name. Unreadable files are listed but not followed. sudo skips @includedir entries ending in
    '~' or holding a '.'."""
    out: dict[str, str] = {}
    todo = [
        (p, "r")
        for pat in patterns
        for p in (sorted(glob.glob(pat)) if any(c in pat for c in "*?[") else [pat])
    ]
    while todo and len(out) < max_files:
        p, how = todo.pop(0)
        if os.path.isdir(p) or not os.path.lexists(p):
            continue
        if p in out:
            if how == "i":
                out[p] = "i"
            continue
        out[p] = how
        try:
            text = Path(p).read_text(errors="replace")
        except OSError:
            continue
        for line in text.splitlines():
            m = _INCLUDE.match(line)
            name = include_path(m.group(2), host) if m else ""
            if not name:
                continue
            target = os.path.normpath(os.path.join(os.path.dirname(p), name))
            if m and m.group(1):  # a directory: its entries, skipping what sudo skips
                todo += [
                    (f, "d")
                    for f in sorted(glob.glob(os.path.join(glob.escape(target), "*")))
                    if not f.endswith("~") and "." not in os.path.basename(f)
                ]
            else:
                todo.append((target, "i"))
    return list(out.items())


# The PVE hop's copy of sudoers_walk (bash): `ns_sudoers_k PATH...` prints '<how>\t<path>' for every file sudo reads
# from PATH... (a path an include names again is printed once more as 'i'), with the same parsing and skip rules.
# At most 200 files. Shell text for the PVE host, not data.
SUDOERS_WALK_SH = r"""ns_host=$(hostname 2>/dev/null); ns_host=${ns_host%%.*}
ns_inc() { local a=$1 o="" q=0 i=0 c; [ "${a:0:1}" = '"' ] && q=1 i=1
  while [ "$i" -lt "${#a}" ]; do c=${a:i:1}
    if [ "$q" = 1 ] && [ "$c" = '"' ]; then break; fi
    if [ "$q" = 0 ] && { [ "$c" = " " ] || [ "$c" = $'\t' ]; }; then break; fi
    if [ "$c" = "\\" ] && [ $((i + 1)) -lt "${#a}" ]; then o+=${a:i+1:1}; i=$((i + 2)); continue; fi
    if [ "$c" = % ] && [ "${a:i+1:1}" = h ]; then o+=$ns_host; i=$((i + 2)); continue; fi
    o+=$c; i=$((i + 1)); done; printf '%s' "$o"; }
ns_sudoers_k() { local -A seen=(); local todo=() kinds=() n=0 p k d line arg t f
  local re='^[[:blank:]]*[@#]include(dir)?[[:blank:]]+(.*[^[:blank:]])[[:blank:]]*$'
  for p in "$@"; do todo+=("$p"); kinds+=(r); done
  while [ ${#todo[@]} -gt 0 ] && [ $n -lt 200 ]; do p=${todo[0]} k=${kinds[0]}; todo=("${todo[@]:1}"); kinds=("${kinds[@]:1}")
    { [ -e "$p" ] || [ -L "$p" ]; } && [ ! -d "$p" ] || continue
    if [ -n "${seen[$p]+x}" ]; then [ "$k" = i ] && printf 'i\t%s\n' "$p"; continue; fi
    seen[$p]=1; n=$((n + 1)); printf '%s\t%s\n' "$k" "$p"; [ -r "$p" ] || continue; d=$(dirname -- "$p")
    while IFS= read -r line || [ -n "$line" ]; do [[ $line =~ $re ]] || continue
      local dir=${BASH_REMATCH[1]}; arg=$(ns_inc "${BASH_REMATCH[2]}"); [ -n "$arg" ] || continue
      case "$arg" in /*) t=$arg;; *) t=$d/$arg;; esac; t=$(realpath -m -s -- "$t")
      if [ -n "$dir" ]; then for f in "$t"/*; do case "${f##*/}" in *~|*.*) continue;; esac; [ -e "$f" ] || [ -L "$f" ] || continue
        todo+=("$f"); kinds+=(d); done
      else todo+=("$t"); kinds+=(i); fi
    done < "$p"; done; }
"""

# Root ssh logins of the last 26 hours, read-only and bounded, appended to the PVE tripwire section as context:
# 'S<TAB>ip<TAB>port' (this hop's own connection), 'K<TAB>ssh-keygen -l line' per authorized key (fingerprint ->
# comment), 'A<TAB>short-unix journal line' per accepted root publickey login, then 'AOK' when the journal read worked
# (as root: a non-root hop cannot read sshd's entries and would report no logins).
ROOT_LOGINS = (
    'read -r ns_ci ns_cp _ <<< "$SSH_CONNECTION"; printf "S\\t%s\\t%s\\n" "$ns_ci" "$ns_cp"; '
    'ssh-keygen -lf /root/.ssh/authorized_keys 2>/dev/null | head -n 50 | sed "s/^/K\\t/"; '
    'if [ "$(id -u)" = 0 ] && a=$(journalctl -q -t sshd -t sshd-session --since -26h -o short-unix --no-pager '
    '2>/dev/null); then printf "%s\\n" "$a" | grep -F "Accepted publickey for root from " | tail -n 200 '
    '| sed "s/^/A\\t/"; echo AOK; fi'
)
_ACCEPTED = re.compile(
    r"Accepted publickey for root from (\S+) port (\d+) ssh2: \S+ (SHA256:[A-Za-z0-9+/=]{20,})"
)


def file_sig(path: str) -> str:
    """'<sha256|UNREADABLE> <owner>:<group> <mode> <type>' (content hash follows symlinks; meta is the path's own)."""
    try:
        st = os.lstat(path)
    except OSError:
        return "MISSING"
    kind = (
        "symlink"
        if statmod.S_ISLNK(st.st_mode)
        else "file"
        if statmod.S_ISREG(st.st_mode)
        else "other"
    )
    try:
        h = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except OSError:
        h = "UNREADABLE"
    if kind == "symlink":
        with contextlib.suppress(OSError):
            kind = f"symlink->{os.readlink(path)}"
    return f"{h} {st.st_uid}:{st.st_gid} {statmod.S_IMODE(st.st_mode):o} {kind}"


def scan_local(patterns: list[str] | tuple[str, ...]) -> dict[str, str]:
    out: dict[str, str] = {}
    for pat in patterns:
        for p in sorted(glob.glob(pat)) if any(c in pat for c in "*?[") else [pat]:
            if os.path.lexists(p) and not os.path.isdir(p):
                out[p] = file_sig(p)
    return out


def tripwire_paths(
    auth: dict[str, Any], owner_home: str, extra: list[str] | tuple[str, ...] = ()
) -> tuple[str, ...]:
    """The [site.auth] `paths` (a floor: `more_paths` only adds, so nothing can drop one), then `extra` (the sudoers
    files sudo reads)."""
    base = [p.format(owner_home=owner_home) for p in auth["paths"]]
    more = [p for p in auth.get("more_paths", []) if isinstance(p, str) and p.startswith("/")]
    return tuple(dict.fromkeys([*base, *more, *extra]))


def remote_snippet(auth: dict[str, Any], owner_home: str) -> str:
    """Read-only shell for the PVE ssh hop: one 'F<TAB>path<TAB>sig' line per existing file (same sig format), the
    files the sudoers patterns include as well, and an 'I<TAB>path' line for each file an @include line names
    (tracked whatever its name), the listeners and the boot time."""
    pats = " ".join(tripwire_paths(auth, owner_home) + tuple(auth["pve_extra_paths"]))
    sudoers = " ".join(
        p for p in pats.split() if p.startswith("/etc/sudoers") or os.path.basename(p) == "sudoers"
    )
    inc = (
        ' while IFS=$\'\\t\' read -r k f; do ns_tw "$f"; [ "$k" = i ] && printf "I\\t%s\\n" "$f"; done'
        f" < <(ns_sudoers_k {sudoers});"
        if sudoers
        else ""
    )
    return (
        SUDOERS_WALK_SH
        + 'ns_tw() { local f=$1 h t; { [ -e "$f" ] || [ -L "$f" ]; } && [ ! -d "$f" ] || return 0; '
        'h=$(sha256sum < "$f" 2>/dev/null | cut -c1-64); [ -n "$h" ] || h=UNREADABLE; '
        't=file; [ -L "$f" ] && t="symlink->$(readlink "$f")"; [ -L "$f" ] || [ -f "$f" ] || t=other; '
        'printf "F\\t%s\\t%s %s %s %s\\n" "$f" "$h" "$(stat -c %u:%g "$f")" "$(stat -c %a "$f")" "$t"; }; '
        'echo "===NS tripwire"; for f in ' + pats + '; do ns_tw "$f"; done;' + inc + " "
        'if l=$(ss -tulpnH 2>/dev/null); then printf "%s\\n" "$l" | sed "s/^/L /"; echo LOK; fi; '
        "awk '/^btime /{print \"B \" $2}' /proc/stat 2>/dev/null; true\n" + ROOT_LOGINS + "\n"
    )


def boot_time_local(proc_stat: str = "/proc/stat") -> float | None:
    """This host's boot time (epoch seconds, /proc/stat btime), None when unreadable."""
    try:
        with open(proc_stat, encoding="ascii", errors="replace") as handle:
            return next((float(ln.split()[1]) for ln in handle if ln.startswith("btime ")), None)
    except (OSError, ValueError, IndexError):
        return None


def parse_remote_boot(text: str) -> float | None:
    """The 'B <btime>' line of the remote snippet: when the host booted, None when absent."""
    for ln in text.splitlines():
        if ln.startswith("B ") and ln[2:].strip().isdigit():
            return float(ln[2:].strip())
    return None


def parse_remote_included(text: str) -> frozenset[str]:
    """The 'I<TAB>path' lines of the remote snippet: files a PVE sudoers @include line names."""
    return frozenset(ln[2:] for ln in text.splitlines() if ln.startswith("I\t") and ln[2:3] == "/")


def parse_remote(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text.splitlines():
        parts = line.split("\t")
        if len(parts) == 3 and parts[0] == "F" and parts[1].startswith("/"):
            out[parts[1]] = parts[2].strip()
    return out


def parse_root_logins(text: str) -> list[dict[str, Any]] | None:
    """The ROOT_LOGINS lines -> [{at, from, workstation, key}] oldest first, without this check hop's own logins (its
    key's fingerprint); key is the authorized_keys comment, or the short fingerprint for a key not listed there.
    None when the journal read did not finish."""
    import ipaddress

    lines = text.splitlines()
    if "AOK" not in lines:
        return None
    me = next(
        (ln.split("\t")[1:3] for ln in lines if ln.startswith("S\t") and ln.count("\t") == 2),
        ["", ""],
    )
    names: dict[str, str] = {}
    for ln in lines:
        parts = ln[2:].split() if ln.startswith("K\t") else []
        if len(parts) >= 3 and parts[1].startswith("SHA256:"):
            names[parts[1]] = re.sub(r"[^\w@.:+-]", "", " ".join(parts[2:-1]).replace(" ", "_"))[
                :48
            ]
    seen: list[tuple[float, str, str, str]] = []
    for ln in lines:
        m = _ACCEPTED.search(ln) if ln.startswith("A\t") else None
        try:
            if m:
                seen.append(
                    (
                        float(ln[2:].split()[0]),
                        str(ipaddress.ip_address(m.group(1))),
                        m.group(2),
                        m.group(3),
                    )
                )
        except (IndexError, ValueError):
            continue
    hop = {fp for _, ip, port, fp in seen if [ip, port] == me}
    return [
        {"at": at, "from": ip, "workstation": ip == me[0], "key": names.get(fp) or fp[:15]}
        for at, ip, _, fp in seen
        if fp not in hop
    ]


# ---------------------------------------------------------------- state files


@contextlib.contextmanager
def locked(path: Path) -> Generator[None]:
    """Serializes read-modify-write of one state file between the check and security-ack."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(
        path.with_name(f".{path.name}.lock"),
        os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o600,
    )
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


class Unreadable(OSError):
    """A state file exists but could not be read; nothing is saved over it."""


def load_json(path: Path) -> dict[str, Any]:
    """The state file, {} when missing; an invalid one is moved aside to <name>.corrupt-<time> and starts empty;
    Unreadable for any other read error (never saved over)."""
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return {}
    except OSError as error:
        raise Unreadable(error.errno, f"{path} unreadable: {error.strerror}") from None
    try:
        data = json.loads(raw)
    except (ValueError, RecursionError):
        data = None
    if isinstance(data, dict):
        return data
    with contextlib.suppress(OSError):
        os.rename(
            path,
            path.with_name(f"{path.name}.corrupt-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}"),
        )
    return {}


def save_json(path: Path, data: dict[str, Any], mode: int = 0o644) -> None:
    core.write_json(path, data, mode=mode)


# ---------------------------------------------------------------- the event engine


@dataclass
class Opts:
    """What the engine needs besides the signatures: settings, and the things only the live host can answer."""

    hold_hours: float
    boot_window_s: float
    manifest: list[dict[str, Any]] = field(default_factory=list)
    explain: Callable[[list[str], list[str], float, float], str] | None = None
    units: Callable[[], dict[str, set[str]]] | None = None
    actors: Callable[[], dict[str, dict[str, Any]]] | None = None
    agent_sudo: Callable[[list[str], float, float], tuple[str, list[dict]]] | None = None
    live: frozenset[str] = frozenset()
    tunnel: Callable[[], frozenset[int] | None] | None = None
    logins: list[dict[str, Any]] | None = None
    sudo_traced: bool = True
    booted_at: float | None = None
    pkg_listeners: Callable[[list[str], dict[str, str], float, float], str] | None = None
    devices: Callable[[], dict[str, str]] | None = None


def step(
    current: dict[str, str],
    state: dict[str, Any],
    now: float,
    listen: dict[str, str] | None,
    opts: Opts,
) -> tuple[dict[str, Any], dict[str, str] | None, bool]:
    """Compare `current` (file signatures) and `listen` (None: the socket scan failed; the baseline's listeners carry
    over) against the baseline in `state`. Returns (new state, the current map used, baselined): the baseline is set
    silently on the first run; each change is one held event. The caller saves the state."""
    live = opts.live
    current = {p: v for p, v in current.items() if not listeners.untracked(p, live)}
    if opts.actors is not None:  # one /proc walk per pass
        actors: Callable[[], dict[str, dict[str, Any]]] | None = functools.cache(opts.actors)
    else:
        actors = None

    @functools.cache
    def tunnel_live() -> frozenset[int] | None:
        try:
            return opts.tunnel() if opts.tunnel else None
        except Exception:  # noqa: BLE001 - an unreadable ingress list is "unknown", never a crash
            return None

    def tunnel_now() -> frozenset[int] | None:
        """The ingress ports read now, else the last ones read (a config an agent left unparsable never hides a new
        listener on a public port)."""
        seen = tunnel_live()
        kept = state.get("tunnel_ports")
        if seen is not None or opts.tunnel is None or not isinstance(kept, list):
            return seen
        return frozenset(p for p in kept if isinstance(p, int))

    if not current:
        return state, None, False
    base = state.get("baseline")
    if isinstance(base, dict):
        base = {p: v for p, v in base.items() if not listeners.untracked(p, live)}
    events = [e for e in state.get("events", []) if isinstance(e, dict)][-STATE_TAIL:]
    if (live_ports := tunnel_live()) is not None and sorted(live_ports) != state.get(
        "tunnel_ports"
    ):
        state = {**state, "tunnel_ports": sorted(live_ports)}
    if isinstance(base, dict):
        old_listen = {k: v for k, v in base.items() if k.startswith("listen ")}
        if listen is None:
            current = {**current, **old_listen}
        elif not old_listen and listen and not state.get("listen_tracked"):
            # listeners added to an existing baseline: learn them silently, once
            base = {**base, **listen}
            current = {**current, **listen}
            state = {**state, "baseline": base, "listen_tracked": True}
        else:
            current = {**current, **listen}
            if old_listen:
                state = {**state, "listen_tracked": True}
    else:
        current = {**current, **(listen or {})}
    if not isinstance(base, dict):
        state = {
            "baseline": current,
            "baselined_at": now,
            "events": events,
            "checked_at": now,
            "listen_tracked": any(k.startswith("listen ") for k in current),
        }
        return state, current, True
    d = listeners.diff(base, current)
    moved = listeners.rebinds(
        base, current, d
    )  # the same daemon on a new address of the same class: not a change
    d = {k: [p for p in v if p not in moved] for k, v in d.items()}
    prev_check = state.get("checked_at", state.get("baselined_at"))
    # booted since the last check, or recently: a pass early in the boot sees daemons still starting, and their return
    # on a later pass is boot noise too
    booted_at = opts.booted_at
    booted = (
        booted_at is not None
        and booted_at <= now + 60
        and (
            (isinstance(prev_check, int | float) and booted_at > float(prev_check))
            or now - booted_at < opts.boot_window_s
        )
    )
    # The listeners from before the boot, kept through the boot window: an early pass that saw daemons still down
    # moved the baseline without them, and their return is still checked against what listened before the boot.
    pre: dict[str, Any] = state["boot_base"] if isinstance(state.get("boot_base"), dict) else {}
    if (
        booted_at is not None
        and isinstance(prev_check, int | float)
        and booted_at > float(prev_check)
    ):
        pre = {
            "at": booted_at,
            "listen": {k: v for k, v in base.items() if k.startswith("listen ")},
        }
        state = {**state, "boot_base": pre}
    pre_listen = pre.get("listen") if booted and pre.get("at") == booted_at else None
    boot_known = (
        {
            **{k: v for k, v in pre_listen.items() if isinstance(k, str) and isinstance(v, str)},
            **base,
        }
        if isinstance(pre_listen, dict)
        else base
    )
    if any(d.values()):
        detail = {
            p: current[p] if p.startswith("listen ") else listeners.what_changed(base, current, p)
            for p in d["changed"]
        }
        detail.update({p: current[p] for p in d["added"] if p.startswith("listen ")})
        eid = hashlib.sha256(json.dumps([state.get("host"), d, detail, now]).encode()).hexdigest()[
            :10
        ]
        event: dict[str, Any] = {"id": eid, "at": now, **d, "detail": detail}
        if opts.logins is not None:
            since_l = float(prev_check) if isinstance(prev_check, int | float) else now - 3600
            event["logins"] = [
                x for x in opts.logins if since_l < float(x.get("at", 0)) <= now + 300
            ][-20:]
        files = [p for p in d["changed"] + d["added"] if not p.startswith("listen ")]
        gone = [p for p in d["removed"] if not p.startswith("listen ")]
        listen_paths = [
            p for p in d["changed"] + d["added"] + d["removed"] if p.startswith("listen ")
        ]
        # Every path must be explained: files by a package update, an agent's sudo command or a declaration (later),
        # listeners by the expected list, the package that owns the daemon, a boot, or a trace to our own side.
        since = float(prev_check) if isinstance(prev_check, int | float) else now - 1800
        notes = (
            [opts.explain(files, gone, now, since) if opts.explain and files else ""]
            if files or gone
            else []
        )
        if notes and not notes[0] and opts.agent_sudo and (files or gone):
            try:  # attribution only ever removes an alert
                prev = state.get("checked_at")
                note, by = opts.agent_sudo(
                    files + gone, now, float(prev) if isinstance(prev, int | float) else now - 1800
                )
            except Exception:  # noqa: BLE001
                note, by = "", []
            if note:
                notes[0] = note
                event.update(file_actors=by)
        if listen_paths:
            note = listeners.declared_listeners(
                opts.manifest, listen_paths, current, units=opts.units, devices=opts.devices
            )
            if not note and opts.pkg_listeners:
                note = opts.pkg_listeners(listen_paths, current, now, since)
            if not note and booted and listeners.boot_returns(boot_known, current, listen_paths):
                note = "came back after boot"  # the host rebooted since the last check; every daemon was there before
                event["boot"] = booted_at
            if (
                not note
            ):  # per listener: declared, traced to our agents/services, or closed (less exposure)
                note, who = listeners.traced_listeners(
                    opts.manifest,
                    listen_paths,
                    current,
                    state,
                    actors,
                    opts.units,
                    tunnel_now(),
                    opts.devices,
                )
                event.update(
                    who=who,
                    traced=actors is not None,
                    declared=[
                        p
                        for p in listen_paths
                        if p not in who
                        and p in current
                        and listeners.declared_listeners(
                            opts.manifest, [p], current, units=opts.units, devices=opts.devices
                        )
                    ],
                )
                # Network novelty is a record, never an alert (owner 2026-10-31). Still alerts: a listener the internet
                # reaches through a cloudflared ingress rule, or a change with a root login from outside the workstation.
                exposed = listeners.exposed_listeners(
                    listen_paths, current, {*who, *event["declared"]}, tunnel_now()
                )
                if exposed:
                    event["exposed"] = exposed
                elif not note and not listeners.outside_login(event.get("logins")):
                    note = listeners.novelty_note(
                        listen_paths,
                        current,
                        d["removed"],
                        who,
                        event["declared"],
                        opts.tunnel is None or tunnel_now() is not None,
                    )
            notes.append(note)
        if notes and all(notes):
            event.update(ack=True, ack_note="; ".join(notes)[:200], ack_at=now, explained=True)
            if (
                listen_paths
                and notes[-1].startswith(
                    ("traced listener", "came back after boot", "recorded listener")
                )
                and not files
                and not gone
            ):
                event["recorded"] = (
                    True  # a note naming who did it (or that it closed), never an alert
                )
            if event.get("file_actors") and (
                not listen_paths or notes[-1].startswith("traced listener")
            ):
                event["recorded"] = True
            if listen_paths and notes[-1].startswith("recorded listener"):
                event["recorded"] = True  # network novelty stays on the board for forensics
        w = event.get("who")
        who_now: dict[str, dict[str, Any]] = w if isinstance(w, dict) else {}
        if listen is not None and actors is not None:
            state = {**state, "listen_actors": listeners.remember_actors(state, current, who_now)}
        events.append(event)
        state = {**state, "baseline": current, "events": events[-STATE_TAIL:], "checked_at": now}
    else:  # agent sudo credits only commands since this pass; a re-bound daemon moves the baseline to its new address
        state = {**state, "checked_at": now, **({"baseline": current} if moved else {})}
    if listeners.record_novelty(
        events,
        current,
        now,
        opts.hold_hours,
        tunnel_now(),
        opts.tunnel is None or tunnel_now() is not None,
    ):
        state = {**state, "events": events[-STATE_TAIL:]}
    if listen is not None and listeners.close_gone(events, current, now):
        state = {**state, "events": events[-STATE_TAIL:]}
    return state, current, False


# ---------------------------------------------------------------- the events as signals


def _logins_line(logins: list[dict[str, Any]]) -> str:
    """'Root logins since the last check: 11:31 from the workstation with key admin@ws' (context for the ask)."""
    if not logins:
        return "No root logins since the last check"
    parts = [
        datetime.fromtimestamp(float(x.get("at", 0)), UTC).astimezone().strftime("%H:%M")
        + (" from the workstation" if x.get("workstation") else f" from {x.get('from', '?')}")
        + f" with key {x.get('key') or '?'}"
        for x in logins[-3:]
    ]
    more = f" (+{len(logins) - 3} earlier)" if len(logins) > 3 else ""
    return "Root logins since the last check: " + ", ".join(parts) + more


def _kind(paths: list[str]) -> str:
    n = sum(p.startswith("listen ") for p in paths)
    return (
        "Listening ports"
        if n == len(paths)
        else "Auth config and listening ports"
        if n
        else "Auth config"
    )


def _items(e: dict[str, Any]) -> list[str]:
    det = e.get("detail", {})
    items = [listeners.item(p, "changed", det.get(p, "changed")) for p in e.get("changed", [])]
    items += [listeners.item(p, "added", det.get(p, "?")) for p in e.get("added", [])]
    items += [listeners.item(p, "removed", "") for p in e.get("removed", [])]
    return items


def _short(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def recorded_text(e: dict[str, Any]) -> str:
    """A change traced to our own agents/services (a listener they opened, a closing, an auth file they wrote with
    sudo): the note that says who."""
    who: dict[str, dict[str, Any]] = e.get("who") or {}
    fa = e.get("file_actors")
    file_actors = [a for a in fa if isinstance(a, dict)] if isinstance(fa, list) else []
    actors = list(
        {
            a["label"]: a
            for a in [*who.values(), *file_actors]
            if isinstance(a, dict) and a.get("label")
        }.values()
    )
    by = ", ".join(a["label"] for a in actors)
    paths = [*e.get("changed", []), *e.get("added", []), *e.get("removed", [])]
    when = datetime.fromtimestamp(float(e["at"]), UTC).astimezone().strftime("%a %H:%M")
    msg = listeners.change_line(e, _items(e), _kind(paths), when)
    if e.get("closed_at"):
        msg += f". Closed again at {listeners.hhmm(float(e['closed_at']), float(e['at']))}; nothing to do"
    elif e.get("boot") and not by:
        msg += ". Came back after boot"
    elif by:
        msg += f". {by} did this"
    loose = sorted(
        p.removeprefix("listen ").split(" ", 1)[-1] for p, a in who.items() if a.get("loose")
    )
    if loose:
        msg += f". It listened on every address ({', '.join(loose[:3])})"
    return msg


def open_text(
    e: dict[str, Any], current: dict[str, str], tunnel: frozenset[int] | None, opts: Opts
) -> str:
    """Why an unexplained change is a problem, in the words the owner needs."""
    paths = [*e.get("changed", []), *e.get("added", []), *e.get("removed", [])]
    n_listen = sum(p.startswith("listen ") for p in paths)
    when = datetime.fromtimestamp(float(e["at"]), UTC).astimezone().strftime("%a %H:%M")
    msg = listeners.change_line(e, _items(e), _kind(paths), when)
    who = e.get("who") or {}
    exposed = (
        e.get("exposed") if isinstance(e.get("exposed"), list) else []
    ) or listeners.exposed_listeners(
        [*e.get("changed", []), *e.get("added", [])],
        current,
        {*who, *(e.get("declared") or [])},
        tunnel,
    )
    if (
        exposed
    ):  # the one listener change that still alerts: the internet reaches it through the tunnel
        ports = sorted({str(listeners.port(p)) for p in exposed if isinstance(p, str)})
        msg += f". A cloudflared ingress rule sends internet traffic to port {', '.join(ports[:4])}"
    elif n_listen == len(paths) and listeners.outside_login(e.get("logins")):
        msg += ". A root login from outside the workstation falls in its window"
    if isinstance(e.get("logins"), list):
        msg += ". " + _logins_line(e["logins"])
    return msg


def events_to_signals(
    label: str,
    state: dict[str, Any],
    current: dict[str, str],
    now: float,
    opts: Opts,
    host: str,
    decl: dict[str, Any],
    notes_max: int,
) -> list[Signal]:
    """The held events of one host as signals: unexplained = failed, covered by a declaration = a note naming the
    session, recorded = a note. Nothing open = one ok line."""
    events = [e for e in state.get("events", []) if isinstance(e, dict)]
    hold = opts.hold_hours * 3600
    live = opts.live
    tunnel = frozenset(p for p in state.get("tunnel_ports", []) if isinstance(p, int)) or None
    told = {
        p
        for e in events
        if e.get("closed_at") and now - float(e.get("at", 0)) <= hold
        for p in [*e.get("added", []), *e.get("changed", [])]
    }
    out: list[Signal] = []
    notes = 0
    for e in events:
        if (
            e.get("recorded")
            and e.get("removed")
            and not e.get("added")
            and not e.get("changed")
            and set(e["removed"]) <= told
        ):
            continue
        if now - float(e.get("at", 0)) > hold:
            continue
        paths = [*e.get("changed", []), *e.get("added", []), *e.get("removed", [])]
        if all(listeners.untracked(p, live) for p in paths):
            continue  # events recorded before these paths were filtered
        if e.get("recorded"):
            if notes < notes_max:
                out.append(
                    Signal(
                        "tripwire.recorded",
                        "ok",
                        {"host": label, "msg": _short(recorded_text(e), 190)},
                        note=True,
                    )
                )
                notes += 1
            continue
        if e.get("ack"):
            continue
        msg = open_text(e, current, tunnel, opts)
        covered = declare.covering(
            decl, host, declare.kind_of_paths(paths), float(e["at"]), now=now
        )
        if covered is not None:
            if notes < notes_max:
                out.append(
                    Signal(
                        "tripwire.declared",
                        "ok",
                        {"host": label, "msg": _short(msg, 150), "said": declare.said(covered)},
                        note=True,
                    )
                )
                notes += 1
            continue
        out.append(
            Signal(
                "tripwire.changed",
                "failed",
                {"host": label, "msg": _short(msg, 170), "id": e.get("id", "")},
            )
        )
    if not any(s.state == "failed" for s in out):
        n_listen = sum(p.startswith("listen ") for p in current)
        out.append(
            Signal(
                "tripwire.state",
                "ok",
                {"host": label, "files": len(current) - n_listen, "listeners": n_listen},
            )
        )
    return out


# ---------------------------------------------------------------- the check


def state_root() -> Path:
    """Where the state files live: next to the check runner's own state file."""
    return core.STATE_PATH.parent


def sudo_state_path(auth: dict[str, Any]) -> Path:
    return state_root() / auth["sudo_file"]


def _state_path(auth: dict[str, Any], host: str) -> Path:
    return state_root() / auth["tripwire_dir"] / f"{host}.json"


def _opts(ctx: Ctx, role: str, **extra: Any) -> Opts:
    auth = ctx.site["auth"]
    return Opts(
        hold_hours=float(auth["hold_hours"]),
        boot_window_s=float(ctx.cfg["boot_window_min"]) * 60,
        manifest=[e for e in auth.get("expected_listeners", []) if e.get("role") == role],
        **extra,
    )


def _query(ctx: Ctx, argv: list[str]) -> tuple[int, str]:
    result = ctx.run(argv, timeout=20)
    return result.rc, result.out


def _run_host(
    ctx: Ctx,
    host: str,
    label: str,
    current: dict[str, str],
    listen: dict[str, str] | None,
    opts: Opts,
) -> list[Signal]:
    path = _state_path(ctx.site["auth"], host)
    if not current:
        return [
            Signal(
                "tripwire.unavailable",
                "warn",
                {"host": label, "why": "no auth files were readable"},
            )
        ]
    try:
        with locked(path):
            state = load_json(path)
            state["host"] = host
            state, used, baselined = step(current, state, ctx.now, listen, opts)
            state.pop("host", None)
            save_json(path, state)
    except Unreadable as error:
        return [
            Signal(
                "tripwire.unavailable",
                "warn",
                {"host": label, "why": (error.strerror or "unreadable")[:60]},
            )
        ]
    except OSError as error:
        return [
            Signal(
                "tripwire.unavailable",
                "warn",
                {"host": label, "why": f"state not saved: {error.strerror}"},
            )
        ]
    if baselined:
        return [
            Signal("tripwire.baselined", "ok", {"host": label, "files": len(state["baseline"])})
        ]
    return events_to_signals(
        label,
        state,
        used or {},
        ctx.now,
        opts,
        host,
        ctx.site["declarations"],
        int(ctx.cfg["notes_max"]),
    )


def agent_sudo_explainer(
    sudo_state: Path, window_s: float = 1800
) -> Callable[[list[str], float, float], tuple[str, list[dict]]]:
    """Tripwire file changes and removals an agent session or service of ours made with sudo: every file must be
    written or removed by a sensitive sudo command traced to that caller (the sudo check's `actor`) since the previous
    tripwire pass (`since`; a minute's slack for a command that started just before it), so one command explains only
    the change it made. Returns (note, actors) or ('', [])."""

    def explain(paths: list[str], now: float, since: float) -> tuple[str, list[dict]]:
        try:
            events = json.loads(sudo_state.read_text()).get("events") or []
        except (OSError, ValueError, AttributeError):
            return "", []
        start = max(since - 60, now - window_s)
        recent = [
            e
            for e in events
            if isinstance(e, dict)
            and e.get("kind") == "sensitive"
            and not e.get("read_only")
            and isinstance(e.get("actor"), dict)
            and e["actor"].get("label")
            and isinstance(e.get("at"), int | float)
            and start <= float(e["at"]) <= now
        ]
        actors: dict[str, dict] = {}
        for p in paths:
            hit = next((e for e in reversed(recent) if p in (e.get("paths") or [])), None)
            if hit is None:
                return "", []
            via = f"sudo {hit.get('family', '')}".strip()
            actors.setdefault(str(hit["actor"]["label"]), {**hit["actor"], "via": via})
        return f"made with sudo by {', '.join(actors)}"[:200], list(actors.values())

    return explain


def workstation(ctx: Ctx) -> list[Signal]:
    cfg, auth = ctx.cfg, ctx.site["auth"]
    host = cfg["hosts"]["workstation"]
    owner = attribution.owner(ctx.site)
    home = owner.home if owner else f"/home/{ctx.site['owner']['user']}"
    ss = ctx.run(["ss", "-tulpnH"], timeout=20)
    walk = sudoers_walk(list(auth["sudoers_globs"]))
    paths = tripwire_paths(auth, home, [p for p, _ in walk])
    dpkg_log = Path(cfg["dpkg_log"])

    def query(argv: list[str]) -> tuple[int, str]:
        return _query(ctx, argv)

    ip = ctx.run(["ip", "-o", "addr", "show"], timeout=20)
    opts = _opts(
        ctx,
        "workstation",
        explain=lambda files, gone, ts, since: listeners.dpkg_explains(
            files, gone, ts, since, dpkg_log, query
        ),
        pkg_listeners=lambda lst, cur, ts, since: listeners.package_listeners(
            lst, cur, ts, since, ss.out, dpkg_log, query
        ),
        units=lambda: listeners.listener_units(ss.out),
        devices=lambda: listeners.interface_devices(ip.out if ip.rc == 0 else ""),
        actors=lambda: attribution.listeners(ss.out, listeners.parse_listeners, owner),
        agent_sudo=agent_sudo_explainer(sudo_state_path(auth)),
        live=frozenset(p for p, how in walk if how == "i"),
        tunnel=lambda: listeners.tunnel_ports(Path(cfg["cloudflared_config"])),
        booted_at=boot_time_local(),
    )
    listen = listeners.parse_listeners(ss.out) if ss.rc == 0 else None
    return _run_host(ctx, host, cfg["labels"]["workstation"], scan_local(paths), listen, opts)


def pve_host(ctx: Ctx) -> list[Signal]:
    cfg, auth = ctx.cfg, ctx.site["auth"]
    host, label = cfg["hosts"]["pve"], cfg["labels"]["pve"]
    result = ctx.run(
        pve.ssh_command(ctx.site["pve"]),
        timeout=float(ctx.site["pve"]["ssh_timeout"]),
        input_text=remote_snippet(auth, f"/home/{ctx.site['owner']['user']}"),
    )
    text = pve.split_sections(result.out).get("tripwire")
    if text is None:
        why = (result.err.strip() or f"exit {result.rc}")[-80:]
        return [Signal("tripwire.unreachable", "warn", {"host": label, "why": why})]
    opts = _opts(
        ctx,
        "pve",
        live=parse_remote_included(text),
        logins=parse_root_logins(text),
        sudo_traced=False,
        booted_at=parse_remote_boot(text),
    )
    return _run_host(
        ctx, host, label, parse_remote(text), listeners.parse_remote_listeners(text), opts
    )


def run(ctx: Ctx) -> list[Signal]:
    return [*workstation(ctx), *pve_host(ctx)]
