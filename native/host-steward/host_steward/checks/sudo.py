"""Unusual sudo use (detection only; the workstation).

Port of ns/checks/sudo.py. The journal's sudo COMMAND= lines are bucketed per hour and command family (never full
command lines, which can carry secrets). The check flags new families and spikes against a learned baseline (warn) and
commands that touch sudoers/ssh/pam/authorized_keys (failed, unless the command only reads: read_only looks at the
arguments too). Commands traced to one of our agent sessions or services (attribution.py) are recorded as theirs, a
note; a `host-steward declare` covering the window turns the rest into a note. Auth failures warn.

State (root-owned, 0600): the [site.auth] sudo_file beside the state file, the same layout Nightshift kept, so its
learned baseline carries over. The tripwire reads its events to credit an auth-file change to the agent that made it
with sudo, so this check runs before the tripwire.
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import re
import shlex
import statistics
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from host_steward import attribution, declare
from host_steward.checks import tripwire
from host_steward.core import Ctx, Signal

ID = "sudo"

COPY_VERBS = {"cp", "mv", "install", "rsync", "ln"}  # write their last argument
ARG_VERBS = {
    "tee",
    "vi",
    "vim",
    "nvim",
    "nano",
    "emacs",
    "sudoedit",
    "touch",
    "truncate",
    "rm",
    "unlink",
    "shred",
}
MODE_VERBS = {"chmod", "chown", "chgrp"}  # first argument is the mode or owner
SHELLS = {"sh", "bash", "dash", "zsh"}
READ_VERBS = {
    "cat",
    "ls",
    "stat",
    "grep",
    "egrep",
    "head",
    "tail",
    "sha256sum",
    "md5sum",
    "test",
    "[",
    "diff",
    "file",
    "wc",
}
# Verbs that read only with these arguments: find without an action that runs or writes, sshd only in test mode
# (-t/-T; plain `sshd -f cfg` starts a second server), ssh-keygen only listing or looking up keys. less is never a read
# (it runs shell commands).
FIND_WRITES = {
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-delete",
    "-fprint",
    "-fprint0",
    "-fprintf",
    "-fls",
}
WRAPPERS = {"env", "nice", "ionice", "timeout", "nohup", "stdbuf", "setpriv"}
SYSTEM_BIN = ("/usr/bin", "/bin", "/usr/sbin", "/sbin")
# getopt option strings (OpenSSH 9.6): a letter before ':' takes a value, attached ('-f/x', '-oPort=1') or the next word
SSHD_OPTS = "C:E:b:c:f:g:h:k:o:p:u:46DGQRTdeiqrtV"
KEYGEN_OPTS = "ABHKLQUXceghiklopquvyC:D:E:F:I:M:N:O:P:R:V:Y:Z:a:b:f:g:j:m:n:r:s:t:w:z:"
_SEGMENT = re.compile(r"\s*(?:\|\||&&|[;|&])\s*")
_REDIRECT = re.compile(r"(?:^|[^<0-9])\d?>>?\s*(/\S+)")


@dataclass
class Rules:
    """What the settings decide about commands: what is sensitive, which tools have subcommands, which of the host's
    own tools only read, and which paths the tripwire tracks (a write to one is credited to the caller)."""

    sensitive: re.Pattern[str]
    subcommand_tools: frozenset[str]
    own_tools: dict[str, dict[str, list[str]]]
    tracked: tuple[str, ...] = ()
    automation: tuple[str, ...] = ()
    trusted: dict[str, dict[str, str]] = field(default_factory=dict)


def rules(ctx: Ctx) -> Rules:
    cfg, auth = ctx.cfg, ctx.site["auth"]
    owner = attribution.owner(ctx.site)
    home = owner.home if owner else f"/home/{ctx.site['owner']['user']}"
    return Rules(
        sensitive=re.compile(cfg["sensitive"]),
        subcommand_tools=frozenset(cfg["subcommand_tools"]),
        own_tools=cfg["own_tools"],
        tracked=(*tripwire.tripwire_paths(auth, home), *auth["pve_extra_paths"]),
        automation=tuple(cfg.get("automation_units", ())),
        trusted=ctx.site.get("trusted_units") or {},
    )


# ---------------------------------------------------------------- parsing


def _argv(command: str) -> list[str]:
    try:
        argv = shlex.split(command)
    except ValueError:
        argv = command.split()
    while argv and (
        os.path.basename(argv[0]) in WRAPPERS or ("=" in argv[0] and not argv[0].startswith("/"))
    ):
        argv = argv[1:]
        while argv and (argv[0].startswith("-") or "=" in argv[0]):
            argv = argv[1:]
    return argv


def command_family(command: str, subcommand_tools: frozenset[str] | set[str]) -> str:
    argv = _argv(command)
    if not argv:
        return "?"
    head = argv[0]
    name = (
        "/".join(head.split("/")[-2:])
        if "/" in head and not head.startswith(("/usr/", "/bin/", "/sbin/"))
        else os.path.basename(head)
    )
    if os.path.basename(head) in subcommand_tools:
        sub = next((a for a in argv[1:] if not a.startswith("-")), "")
        if sub and re.fullmatch(r"[a-z][a-z0-9_-]{0,30}", sub):
            name = f"{name} {sub}"
    return name[:60]


def parse_sudo_message(msg: str) -> dict[str, str] | None:
    """' alice : PWD=/x ; USER=root ; COMMAND=/usr/bin/stat -c ...' -> {user, run_as, command}; auth failures too."""
    m = re.match(r"\s*(\S+)\s*:\s*(.*)$", msg)
    if not m:
        return None
    user, rest = m.group(1), m.group(2)
    if "COMMAND=" in rest:
        fields = dict(
            kv.split("=", 1) for kv in (p.strip() for p in rest.split(" ; ")) if "=" in kv
        )
        cmd = rest.split("COMMAND=", 1)[1]
        failure = re.search(
            r"incorrect password|NOT in sudoers|command not allowed|a password is required", rest
        )
        return {
            "user": user,
            "run_as": fields.get("USER", ""),
            "command": cmd,
            "failure": failure.group(0) if failure else "",
        }
    if re.search(r"incorrect password attempt|NOT in sudoers|authentication failure", rest):
        return {"user": user, "run_as": "", "command": "", "failure": rest[:80]}
    return None


def _words(command: str) -> list[str]:
    """The command's words as sudo logged them: argv joined by single spaces, so quote characters are just characters
    (shlex would let a quote inside one argument swallow the arguments after it). Leading wrappers and VAR=value are
    dropped like _argv does."""
    words = command.split()
    while words and (
        os.path.basename(words[0]) in WRAPPERS or ("=" in words[0] and not words[0].startswith("/"))
    ):
        words = words[1:]
    return words


def _scanned(command: str, own_tools: dict[str, dict[str, list[str]]]) -> str:
    """The text the sensitive pattern matches: the command, except that for the host's own tools the free text of their
    note/reason options is left out (a note naming /etc/sudoers.d touches nothing). sudo logs argv joined by spaces,
    so that text runs to the next word starting with --; path options stay in, and so does anything in a note that
    reads like one (the safe side)."""
    argv = _words(command)
    tool = own_tools.get(argv[0]) if argv else None
    if tool is None:
        return command
    free_opts = set(tool.get("free_text", []))
    kept, free = [], False
    for a in argv:
        if a.startswith("--"):
            free = a.split("=", 1)[0] in free_opts
        if not free:
            kept.append(a)
    return " ".join(kept)


def _written(command: str, depth: int = 0) -> set[str]:
    argv = _argv(command)
    if not argv or depth > 2:
        return set()
    verb, args = os.path.basename(argv[0]), argv[1:]
    plain = [a for a in args if not a.startswith("-")]
    if verb in SHELLS:
        i = next((i for i, a in enumerate(args) if re.fullmatch(r"-[A-Za-z]*c[A-Za-z]*", a)), None)
        if i is None:
            return set()
        script = " ".join(
            args[i + 1 :]
        )  # sudo logs the argv joined by spaces, so the script is everything after -c
        out = set(_REDIRECT.findall(script))
        for seg in _SEGMENT.split(script):
            out |= _written(_REDIRECT.sub(" ", seg), depth + 1)
        return out
    if verb == "visudo":
        if any(re.fullmatch(r"-[A-Za-z]*c[A-Za-z]*|--check", a) for a in args):
            return set()
        f = next((args[i + 1] for i, a in enumerate(args[:-1]) if a in ("-f", "--file")), None)
        return {f or "/etc/sudoers"}
    if verb in COPY_VERBS:
        if any(
            a in ("-t", "--target-directory") or a.startswith("--target-directory=") for a in args
        ):
            return set()
        return {plain[-1]} if len(plain) >= 2 else set()
    if verb in ARG_VERBS:
        return set(plain)
    if verb in MODE_VERBS:
        return set(plain[1:])
    if verb == "sed" and any(a.startswith(("-i", "--in-place")) for a in args):
        script_given = any(a in ("-e", "-f") or a.startswith("--expression") for a in args)
        return set(plain if script_given else plain[1:])
    return set()  # read verbs and anything not known to write a file


def written_paths(command: str, tracked: tuple[str, ...]) -> list[str]:
    """The tracked auth files a sudo command writes, by full path (paths are not secrets; the command is never kept).
    Only commands known to write count: a path a command only reads or mentions credits nothing."""
    return sorted(
        t
        for t in _written(command)
        if t.startswith("/") and any(fnmatch.fnmatchcase(t, g) for g in tracked)
    )[:8]


def _flags(args: list[str], spec: str) -> set[str]:
    """The short options a getopt(spec) parse sees; letters inside an option's value never count. Long options skip."""
    takes = {spec[i] for i in range(len(spec) - 1) if spec[i + 1] == ":"}
    out: set[str] = set()
    it = iter(args)
    for a in it:
        if a == "--":
            break
        if not a.startswith("-") or a == "-" or a.startswith("--"):
            continue
        for j, c in enumerate(a[1:], 1):
            out.add(c)
            if c in takes:
                if j == len(a) - 1:
                    next(it, None)
                break
    return out


def read_only(command: str, own_tools: dict[str, dict[str, list[str]]]) -> bool:
    """A sudo command that only reads (a read verb, or a verb whose arguments make it a read). The verb counts only as
    the system's own binary (sudo logs the resolved path): /tmp/cat or ./find is not cat or find. Arguments are the
    logged words (_words), never shell-unquoted."""
    argv = _words(command)
    if not argv:
        return False
    verb, args = os.path.basename(argv[0]), argv[1:]
    if argv[0] in own_tools:
        return next((a for a in args if not a.startswith("-")), "") in own_tools[argv[0]].get(
            "reads", []
        )
    if "/" in argv[0] and os.path.dirname(os.path.normpath(argv[0])) not in SYSTEM_BIN:
        return False
    if verb in READ_VERBS:
        return True
    if verb == "visudo":
        return any(re.fullmatch(r"-[A-Za-z]*c[A-Za-z]*|--check", a) for a in args)
    if verb == "find":
        return not FIND_WRITES & set(args)
    if verb == "sshd":
        return bool(_flags(args, SSHD_OPTS) & {"t", "T"})
    if verb == "ssh-keygen":
        f = _flags(args, KEYGEN_OPTS)
        return bool(f & {"l", "F", "L", "y"}) and not f & set("RANpcstbiemGTuHkMY")
    return False


# ---------------------------------------------------------------- the journal and the hourly counts


def _hour(ts: float) -> str:
    return datetime.fromtimestamp(ts, UTC).strftime("%Y-%m-%dT%H")


def ingest_sudo(
    state: dict[str, Any],
    entries: list[tuple],
    rule: Rules,
    keep_hours: int = 15 * 24,
    who: Callable[[str, float], dict[str, Any] | None] | None = None,
) -> list[dict]:
    """Fold (epoch, MESSAGE[, caller unit[, caller cgroup]]) entries into hourly family counts, plus per-family counts
    by the calling systemd service ("callers"; scopes such as terminals and agent panes are not recorded). Returns
    sensitive/failure events (no full commands). who(cgroup, at) names our own agent session or service behind a caller
    (attribution.py); such events are recorded as theirs (acknowledged, "recorded") and never ask."""
    hours: dict[str, dict[str, int]] = state.setdefault("hours", {})
    callers: dict[str, dict[str, dict[str, int]]] = state.setdefault("callers", {})
    events: list[dict] = []
    traced: dict[tuple[str, float], dict[str, Any] | None] = {}

    def mark(e: dict[str, Any], cgroup: str) -> dict[str, Any]:
        if who is None or not cgroup:
            return e
        key = (cgroup, float(e["at"]))
        if key not in traced:
            try:
                traced[key] = who(cgroup, float(e["at"]))
            except Exception:  # noqa: BLE001 - attribution only ever removes an ask
                traced[key] = None
        actor = traced[key]
        if actor:
            note = f"traced to {actor.get('label')}"[:200]
            e.update(actor=actor, recorded=True, ack=True, ack_note=note, ack_at=e["at"])
        return e

    for ts, msg, *rest in entries:
        unit = str(rest[0]) if rest and rest[0] else ""
        cgroup = str(rest[1]) if len(rest) > 1 and rest[1] else ""
        p = parse_sudo_message(msg)
        if not p:
            continue
        if p["failure"]:
            events.append(
                mark(
                    {"at": ts, "kind": "failure", "user": p["user"], "detail": p["failure"][:80]},
                    cgroup,
                )
            )
            if not p["command"]:
                continue
        fam = command_family(p["command"], rule.subcommand_tools)
        bucket = hours.setdefault(_hour(ts), {})
        bucket[fam] = bucket.get(fam, 0) + 1
        if re.fullmatch(r"[\w@.:-]{1,120}\.service", unit):
            byfam = callers.setdefault(_hour(ts), {}).setdefault(fam, {})
            if unit in byfam or len(byfam) < 8:
                byfam[unit] = byfam.get(unit, 0) + 1
        hit = rule.sensitive.search(_scanned(p["command"], rule.own_tools))
        if hit:
            e = {
                "at": ts,
                "kind": "sensitive",
                "user": p["user"],
                "family": fam,
                "target": hit.group(0),
                "read_only": read_only(p["command"], rule.own_tools),
                "paths": written_paths(p["command"], rule.tracked),
            }
            events.append(mark(e, cgroup))
    cutoff = sorted(hours)[-keep_hours:] if len(hours) > keep_hours else None
    if cutoff:
        state["hours"] = {h: hours[h] for h in cutoff}
        state["callers"] = {h: callers[h] for h in cutoff if h in callers}
    return events


def read_journal(
    ctx: Ctx, cursor: str | None, initial_since: str
) -> tuple[list[tuple[float, str, str, str]], str | None] | None:
    """(epoch, MESSAGE, calling systemd unit, calling cgroup) per sudo log line, and the new cursor; user-manager units
    win over user@<uid>.service. None when journalctl failed."""
    cmd = [
        "journalctl",
        "-t",
        "sudo",
        *[f"_EXE={exe}" for exe in ctx.cfg["sudo_exes"]],
        "-o",
        "json",
        "--output-fields=MESSAGE,_SYSTEMD_UNIT,_SYSTEMD_USER_UNIT,_SYSTEMD_CGROUP",
        "--no-pager",
        "--show-cursor",
        "-q",
    ]
    cmd += ["--after-cursor", cursor] if cursor else ["--since", initial_since]
    res = ctx.run(cmd, timeout=120)
    if res.rc != 0:
        return None
    entries: list[tuple[float, str, str, str]] = []
    new_cursor = cursor
    for line in res.out.splitlines():
        if line.startswith("-- cursor: "):
            new_cursor = line[len("-- cursor: ") :].strip()
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        msg = rec.get("MESSAGE")
        if isinstance(msg, list):  # binary-safe journal export
            msg = bytes(msg).decode(errors="replace")
        if isinstance(msg, str):
            unit = rec.get("_SYSTEMD_USER_UNIT") or rec.get("_SYSTEMD_UNIT") or ""
            cg = rec.get("_SYSTEMD_CGROUP") or ""
            entries.append(
                (
                    int(rec.get("__REALTIME_TIMESTAMP", 0)) / 1e6,
                    msg,
                    unit if isinstance(unit, str) else "",
                    cg if isinstance(cg, str) else "",
                )
            )
        new_cursor = rec.get("__CURSOR", new_cursor)
    return entries, new_cursor


# ---------------------------------------------------------------- open events and signals


def sudo_open(
    state: dict[str, Any], host: str, now: float, hold_hours: float
) -> dict[str, list[dict]]:
    """Open (unacked, held, non-bootstrap) sudo events by id: one per sensitive user-hour group, one per auth failure.
    The single source of these ids for the check and for security-ack."""
    hold = hold_hours * 3600
    groups: dict[tuple[str, str], list[dict]] = {}
    out: dict[str, list[dict]] = {}
    for e in state.get("events", []):
        if (
            not isinstance(e, dict)
            or now - float(e.get("at", 0)) > hold
            or e.get("bootstrap")
            or e.get("ack")
        ):
            continue  # bootstrap events predate the baseline: recorded, never raised; acked ones are confirmed
        if e.get("kind") == "sensitive":  # one signal per user and hour, not per command
            hour = datetime.fromtimestamp(float(e["at"]), UTC).astimezone().strftime("%a %H:00")
            groups.setdefault((str(e.get("user")), hour), []).append(e)
        elif e.get("kind") == "failure":
            out[
                f"failure.{hashlib.sha256(json.dumps(e, sort_keys=True).encode()).hexdigest()[:10]}"
            ] = [e]
    for (user, hour), evs in groups.items():
        sev = "info" if all(e.get("read_only") for e in evs) else "critical"
        out[
            f"sensitive.{hashlib.sha256(f'{host}|{user}|{hour}|{sev}'.encode()).hexdigest()[:10]}"
        ] = evs
    return out


def automation_unit(unit: str, rule: Rules) -> bool:
    """A caller unit that is scheduled automation: a trusted unit of the site (either scope) or an exact extra name."""
    return unit in rule.automation or any(
        attribution.trusted_project(rule.trusted, unit, scope) for scope in ("system", "user")
    )


def automation_callers(
    state: dict[str, Any], hour_keys: set[str], last24: dict[str, int], rule: Rules
) -> dict[str, list[str]]:
    """{family: caller units} for families whose every call in the window came from a known automation service."""
    seen: dict[str, dict[str, int]] = {}
    for h in hour_keys:
        for fam, units in (state.get("callers") or {}).get(h, {}).items():
            for u, n in units.items():
                seen.setdefault(fam, {})[u] = seen.setdefault(fam, {}).get(u, 0) + int(n)
    return {
        fam: sorted(units)
        for fam, units in seen.items()
        if sum(units.values()) >= last24.get(fam, 0) > 0
        and all(automation_unit(u, rule) for u in units)
    }


def _stats(state: dict[str, Any], now: float, cfg: dict[str, Any]) -> dict[str, Any]:
    hours: dict[str, dict[str, int]] = state.get("hours", {})
    cur_keys = {_hour(now - i * 3600) for i in range(24)}
    last24: dict[str, int] = {}
    for h in cur_keys:
        for fam, n in hours.get(h, {}).items():
            last24[fam] = last24.get(fam, 0) + n
    # baseline: full 24h windows before the current one that the stored hours cover
    first = min(
        (datetime.strptime(h, "%Y-%m-%dT%H").replace(tzinfo=UTC).timestamp() for h in hours),
        default=now,
    )
    windows: list[dict[str, int]] = []
    for d in range(1, 15):
        start = now - (d + 1) * 86400
        if start + 3600 < first:
            break
        w: dict[str, int] = {}
        for i in range(24):
            for fam, n in hours.get(_hour(start + 3600 + i * 3600), {}).items():
                w[fam] = w.get(fam, 0) + n
        windows.append(w)
    learned = len(windows) >= int(cfg["learn_days"])
    median = (
        statistics.median([sum(w.values()) for w in windows])
        if learned
        else float(cfg["seed_daily_total"])
    )
    return {
        "keys": cur_keys,
        "last24": last24,
        "windows": windows,
        "learned": learned,
        "median": median,
    }


def _hour_name(at: float) -> str:
    return datetime.fromtimestamp(at, UTC).astimezone().strftime("%a %H:00")


def evaluate(
    state: dict[str, Any], now: float, ctx: Ctx, rule: Rules, host: str, cap: int
) -> list[Signal]:
    cfg, auth = ctx.cfg, ctx.site["auth"]
    st = _stats(state, now, cfg)
    last24, windows, learned, median = st["last24"], st["windows"], st["learned"], st["median"]
    total24 = sum(last24.values())
    top = sorted(last24.items(), key=lambda kv: -kv[1])[:5]
    base = f"{median:.0f}/day" + (
        "" if learned else f" seed, learning {len(windows)}/{cfg['learn_days']}d"
    )
    out = [
        Signal(
            "sudo.summary",
            "ok",
            {"total": total24, "base": base, "top": ", ".join(f"{f} {n}" for f, n in top)},
        )
    ]
    if learned and total24 > max(
        float(cfg["spike_factor"]) * median, median + float(cfg["spike_min_extra"])
    ):
        out.append(Signal("sudo.spike", "warn", {"total": total24, "median": f"{median:.0f}"}))
    if learned:
        seen = set().union(*windows) if windows else set()
        known = tuple(cfg["known_families"])
        # Families whose every call came from a known automation service (by the journal's caller unit) stay visible
        # but never warn: their volume follows that job's schedule and backlog.
        auto = automation_callers(state, st["keys"], last24, rule)
        new = sorted(
            f for f in last24 if f not in seen and not any(fnmatch.fnmatchcase(f, k) for k in known)
        )
        spikes = []
        for fam, n in last24.items():
            med = statistics.median([w.get(fam, 0) for w in windows])
            if (
                fam in seen
                and not any(fnmatch.fnmatchcase(fam, k) for k in known)
                and n > max(float(cfg["family_spike_factor"]) * med, float(cfg["family_spike_min"]))
            ):
                spikes.append((fam, f"{fam} {n} vs {med:.0f}/day"))
        if new:
            manual = [f for f in new if f not in auto]
            if manual:
                out.append(
                    Signal(
                        "sudo.new_family",
                        "warn",
                        {"n": len(manual), "families": ", ".join(manual[:8])},
                    )
                )
            else:
                by = "; ".join(f"{f} from {', '.join(auto[f][:2])}" for f in new[:6])
                out.append(
                    Signal("sudo.new_family.auto", "ok", {"n": len(new), "by": by}, note=True)
                )
        if spikes:
            manual_s = [t for f, t in spikes if f not in auto]
            if manual_s:
                out.append(Signal("sudo.family_spike", "warn", {"spikes": "; ".join(manual_s[:6])}))
            else:
                by = "; ".join(f"{t} ({', '.join(auto[f][:2])})" for f, t in spikes[:6])
                out.append(Signal("sudo.family_spike.auto", "ok", {"by": by}, note=True))
    out += _open_signals(state, now, ctx, host, float(auth["hold_hours"]), cap)
    out += _recorded(state, host, now, float(auth["hold_hours"]), cap)
    return out


def _open_signals(
    state: dict[str, Any], now: float, ctx: Ctx, host: str, hold: float, cap: int
) -> list[Signal]:
    out: list[Signal] = []
    notes = 0
    decl = ctx.site["declarations"]
    for code, evs in sudo_open(state, host, now, hold).items():
        e = evs[0]
        if code.startswith("failure."):
            when = datetime.fromtimestamp(float(e["at"]), UTC).astimezone().strftime("%a %H:%M")
            out.append(
                Signal(
                    "sudo.failure",
                    "warn",
                    {"user": e.get("user"), "detail": e.get("detail"), "when": when, "id": code},
                )
            )
            continue
        ro = all(x.get("read_only") for x in evs)
        fams = sorted({str(x.get("family")) for x in evs})
        targets = sorted({str(x.get("target")) for x in evs})
        fields = {
            "targets": ", ".join(targets),
            "families": ", ".join(fams[:6]),
            "user": str(e.get("user")),
            "hour": _hour_name(float(e["at"])),
            "n": len(evs),
            "id": code,
        }
        if ro:  # reads change nothing: a note for the record, never a problem
            out.append(Signal("sudo.read", "ok", fields))
            continue
        kinds = {"keys" if "authorized_keys" in t else "config" for t in targets}
        kind = (
            kinds.pop() if len(kinds) == 1 else "other"
        )  # a declaration never closes the part it did not name
        first, last = min(float(x["at"]) for x in evs), max(float(x["at"]) for x in evs)
        covered = declare.covering(decl, ctx.cfg["host"], kind, first, last, now=now)
        if covered is not None:
            if notes < cap:
                out.append(
                    Signal(
                        "sudo.declared", "ok", {**fields, "said": declare.said(covered)}, note=True
                    )
                )
                notes += 1
            continue
        out.append(Signal("sudo.sensitive", "failed", fields))
    return out


def _recorded(
    state: dict[str, Any], host: str, now: float, hold_hours: float, cap: int
) -> list[Signal]:
    """Sensitive sudo commands and sudo failures traced to our own agents or services: one note per actor and hour
    naming them, never an ask."""
    groups: dict[tuple[str, str], list[dict]] = {}
    for e in state.get("events", []):
        if (
            isinstance(e, dict)
            and e.get("recorded")
            and isinstance(e.get("actor"), dict)
            and not e.get("bootstrap")
            and now - float(e.get("at", 0)) <= hold_hours * 3600
        ):
            groups.setdefault(
                (str(e["actor"].get("label")), _hour_name(float(e["at"]))), []
            ).append(e)
    out = []
    for (label, hour), evs in list(groups.items())[:cap]:
        sens = [e for e in evs if e.get("kind") == "sensitive"]
        fails = [e for e in evs if e.get("kind") == "failure"]
        parts = []
        if sens:
            verb = "read" if all(e.get("read_only") for e in sens) else "changed"
            targets = ", ".join(sorted({str(e.get("target")) for e in sens}))
            parts.append(
                f"sudo {verb} {targets} ({', '.join(sorted({str(e.get('family')) for e in sens})[:4])})"
            )
        if fails:
            parts.append(f"{len(fails)} sudo auth failure{'s' if len(fails) > 1 else ''}")
        out.append(
            Signal(
                "sudo.recorded",
                "ok",
                {"msg": f"{'; '.join(parts)} ({hour}). {label} did this"},
                note=True,
            )
        )
    return out


# ---------------------------------------------------------------- the check


def run(ctx: Ctx) -> list[Signal]:
    cfg, auth = ctx.cfg, ctx.site["auth"]
    host, path = cfg["host"], tripwire.sudo_state_path(auth)
    rule = rules(ctx)
    owner = attribution.owner(ctx.site)
    cap = int(cfg["notes_max"])
    try:
        with tripwire.locked(path):
            state = tripwire.load_json(path)
            read = read_journal(ctx, state.get("cursor"), cfg["initial_since"])
            if read is None:
                return [Signal("sudo.unreadable", "warn", {"why": "the journal gave no answer"})]
            entries, cursor = read
            events = ingest_sudo(
                state, entries, rule, who=lambda cg, at: attribution.of_cgroup(cg, at, owner)
            )
            if not state.get("cursor"):
                for e in events:
                    e["bootstrap"] = True
            hold = float(auth["hold_hours"]) * 3600
            state["events"] = [
                e
                for e in [*state.get("events", []), *events]
                if ctx.now - float(e.get("at", 0)) <= hold
            ][-200:]
            state["cursor"] = cursor
            tripwire.save_json(path, state, mode=0o600)
    except tripwire.Unreadable as error:
        return [
            Signal("sudo.unreadable", "warn", {"why": (error.strerror or "state unreadable")[:60]})
        ]
    except OSError as error:
        return [Signal("sudo.unreadable", "warn", {"why": f"state not saved: {error.strerror}"})]
    return evaluate(state, ctx.now, ctx, rule, host, cap)
