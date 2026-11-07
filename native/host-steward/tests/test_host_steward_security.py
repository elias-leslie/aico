"""Tripwire, sudo, docker access, attribution and declarations on fixture inputs: no root, no network, no real /etc."""

from __future__ import annotations

import json
import os
import stat
import time
from pathlib import Path

import pytest

from host_steward import attribution, core, declare, listeners
from host_steward.checks import security, sudo, tripwire
from host_steward.core import Result, Signal
from host_steward.jobs import JOBS, security_ack
from host_steward.runner import main as host_steward_main

DATA = core.load_data()
NOW = 1_800_000_000.0
SCOPE = "/user.slice/user-1000.slice/user@1000.service/app.slice/tmux-spawn-1.scope"
TICK = os.sysconf("SC_CLK_TCK")
RULES = sudo.Rules(
    sensitive=__import__("re").compile(DATA["checks"]["sudo"]["sensitive"]),
    subcommand_tools=frozenset(DATA["checks"]["sudo"]["subcommand_tools"]),
    own_tools=DATA["checks"]["sudo"]["own_tools"],
    tracked=(
        "/etc/sudoers",
        "/etc/sudoers.d/*",
        "/etc/ssh/sshd_config",
        "/home/u/.ssh/authorized_keys",
    ),
)


class Fake:
    """Command runner: the first rule whose words are all in argv answers; anything else is 'not found'."""

    def __init__(self, *rules):
        self.rules = rules
        self.calls = []

    def __call__(self, argv, timeout=60, input_text=None):
        self.calls.append((list(argv), input_text))
        for words, result in self.rules:
            if all(word in argv for word in words):
                return result
        return Result(127, "", "not found")


@pytest.fixture(autouse=True)
def no_real_session(monkeypatch):
    """A declaration never reads the test runner's own /proc ancestry."""
    monkeypatch.setattr(declare, "_actor_now", lambda _site: None)


def codes(signals):
    return {s.code: s.state for s in signals}


def mkctx(check, run=None, site=None, **over):
    cfg = {**DATA["checks"][check], **over}
    return core.Ctx(cfg=cfg, site=site or DATA["site"], now=NOW, run=run or Fake(), state={})


def site_for(tmp_path, **auth):
    """The data's site table with the declarations and auth files pointed into tmp_path."""
    decl = {
        **DATA["site"]["declarations"],
        "file": str(tmp_path / "decl.json"),
        "lab_use_file": str(tmp_path / "lab.json"),
        "first_seen_file": str(tmp_path / "first.json"),
        "owner_user": "nobody-such-user",
    }
    return {**DATA["site"], "declarations": decl, "auth": {**DATA["site"]["auth"], **auth}}


# ---------------------------------------------------------------- tripwire: files


def test_file_sig_follows_content_and_meta(tmp_path):
    f = tmp_path / "a"
    f.write_text("x")
    f.chmod(0o640)
    sig = tripwire.file_sig(str(f))
    assert sig.split()[0] == "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"
    assert sig.endswith("640 file")
    assert tripwire.file_sig(str(tmp_path / "nope")) == "MISSING"
    link = tmp_path / "l"
    link.symlink_to(f)
    assert tripwire.file_sig(str(link)).endswith(f"symlink->{f}")


def test_include_path_quotes_escapes_and_host():
    assert tripwire.include_path('"/etc/a b/x"') == "/etc/a b/x"
    assert tripwire.include_path(r"/etc/a\ b/x trailing") == "/etc/a b/x"
    assert tripwire.include_path("/etc/sudoers.d/%h", host="gem") == "/etc/sudoers.d/gem"


def test_sudoers_walk_follows_includes_and_marks_how(tmp_path):
    main = tmp_path / "sudoers"
    inc = tmp_path / "extra.conf"
    d = tmp_path / "sudoers.d"
    d.mkdir()
    (d / "ok").write_text("")
    (d / "skip.conf").write_text("")  # a dot in the name: sudo skips it
    (d / "backup~").write_text("")
    inc.write_text("")
    main.write_text(f"@include {inc}\n#includedir {d}\nroot ALL=(ALL) ALL\n")
    walk = dict(tripwire.sudoers_walk([str(main)]))
    assert walk == {str(main): "r", str(inc): "i", str(d / "ok"): "d"}


def test_paths_floor_and_extras():
    auth = {
        "paths": ["/etc/sudoers", "{owner_home}/.ssh/authorized_keys"],
        "more_paths": ["/etc/x", "rel"],
    }
    assert tripwire.tripwire_paths(auth, "/home/u", ["/etc/sudoers", "/etc/inc"]) == (
        "/etc/sudoers",
        "/home/u/.ssh/authorized_keys",
        "/etc/x",
        "/etc/inc",
    )


def test_remote_parsers():
    text = (
        "F\t/etc/sudoers\tabc 0:0 440 file\nI\t/etc/inc\nL tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* "
        'users:(("sshd",pid=1,fd=3))\nLOK\nB 1790000000\nS\t192.168.86.128\t5000\n'
        "K\t256 SHA256:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq admin@ws (ED25519)\n"
        "A\t1799990000.1 gem sshd[1]: Accepted publickey for root from 192.168.86.128 port 5000 ssh2: ED25519 "
        "SHA256:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq\n"
        "A\t1799990100.1 gem sshd[1]: Accepted publickey for root from 10.0.0.9 port 6000 ssh2: ED25519 "
        "SHA256:ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ\nAOK\n"
    )
    assert tripwire.parse_remote(text) == {"/etc/sudoers": "abc 0:0 440 file"}
    assert tripwire.parse_remote_included(text) == {"/etc/inc"}
    assert tripwire.parse_remote_boot(text) == 1790000000.0
    assert listeners.parse_remote_listeners(text) == {"listen tcp *:22": "sshd"}
    logins = tripwire.parse_root_logins(text)
    # this hop's own login (the S line's address and port) is dropped; the outside one stays
    assert logins is not None
    assert [(x["from"], x["workstation"]) for x in logins] == [("10.0.0.9", False)]
    assert tripwire.parse_root_logins(text.replace("AOK", "")) is None


# ---------------------------------------------------------------- tripwire: events


def opts(**over):
    base = {"hold_hours": 24.0, "boot_window_s": 2700.0}
    return tripwire.Opts(**{**base, **over})


FILES = {"/etc/sudoers": "a 0:0 440 file", "/etc/ssh/sshd_config": "b 0:0 644 file"}


def baseline(state=None, listen=None, now=NOW):
    state, _, first = tripwire.step(
        FILES, state or {}, now, listen or {"listen tcp *:22": "sshd"}, opts()
    )
    assert first
    return state


def signals_of(state, current, now, o=None, decl=None):
    return tripwire.events_to_signals(
        "the workstation", state, current, now, o or opts(), "davion-sidarli", decl or {}, 3
    )


def declarations_cfg(tmp_path):
    return site_for(tmp_path)["declarations"]


def test_first_run_baselines_silently_and_unchanged_stays_quiet():
    state = baseline()
    assert state["baseline"]["listen tcp *:22"] == "sshd"
    state, used, first = tripwire.step(FILES, state, NOW + 900, {"listen tcp *:22": "sshd"}, opts())
    assert not first and not state["events"]
    assert codes(signals_of(state, used, NOW + 900)) == {"tripwire.state": "ok"}


def test_unexplained_file_change_is_failed_then_held_then_dropped(tmp_path):
    state = baseline()
    changed = {**FILES, "/etc/sudoers": "c 0:0 440 file"}
    state, used, _ = tripwire.step(changed, state, NOW + 900, {"listen tcp *:22": "sshd"}, opts())
    (event,) = state["events"]
    assert event["changed"] == ["/etc/sudoers"] and not event.get("ack")
    out = signals_of(state, used, NOW + 900, decl=declarations_cfg(tmp_path))
    assert codes(out) == {"tripwire.changed": "failed"}
    assert out[0].fields["id"] == event["id"]
    # the baseline moved to the new state: the next pass is quiet, and the event drops out after the hold
    state, used, _ = tripwire.step(changed, state, NOW + 1800, {"listen tcp *:22": "sshd"}, opts())
    assert len(state["events"]) == 1
    assert codes(signals_of(state, used, NOW + 25 * 3600, decl=declarations_cfg(tmp_path))) == {
        "tripwire.state": "ok"
    }


def test_package_explanation_makes_it_a_quiet_event():
    state = baseline()
    changed = {**FILES, "/etc/ssh/sshd_config": "d 0:0 644 file"}
    o = opts(explain=lambda files, gone, now, since: "dpkg ran for openssh-server")
    state, used, _ = tripwire.step(changed, state, NOW + 900, {"listen tcp *:22": "sshd"}, o)
    assert state["events"][0]["ack"] and "openssh" in state["events"][0]["ack_note"]
    assert codes(signals_of(state, used, NOW + 900, o)) == {"tripwire.state": "ok"}


def test_declaration_covering_the_change_turns_it_into_a_note(tmp_path):
    site = site_for(tmp_path)
    decl = site["declarations"]
    state = baseline()
    changed = {**FILES, "/etc/sudoers": "c 0:0 440 file"}
    state, used, _ = tripwire.step(changed, state, NOW + 900, {"listen tcp *:22": "sshd"}, opts())
    entry = declare.declare(
        decl, site, "workstation", "config", 2, "add a sudoers line", now=NOW + 800
    )
    assert entry["host"] == "workstation"
    out = tripwire.events_to_signals(
        "the workstation", state, used, NOW + 900, opts(), "davion-sidarli", decl, 3
    )
    assert codes(out) == {"tripwire.declared": "ok", "tripwire.state": "ok"}
    said = next(s.fields["said"] for s in out if s.code == "tripwire.declared")
    assert "add a sudoers line" in said and "by its own account" in said
    # a declaration of another kind does not cover it
    decl2 = {
        **decl,
        "file": str(tmp_path / "other.json"),
        "first_seen_file": str(tmp_path / "f2.json"),
    }
    declare.declare(decl2, site, "workstation", "listeners", 2, "ports", now=NOW + 800)
    out2 = tripwire.events_to_signals(
        "w", state, used, NOW + 900, opts(), "davion-sidarli", decl2, 3
    )
    assert codes(out2) == {"tripwire.changed": "failed"}


def test_new_listener_is_a_note_unless_the_internet_reaches_it():
    state = baseline()
    listen = {"listen tcp *:22": "sshd", "listen tcp *:8123": "node"}
    state, used, _ = tripwire.step(
        FILES, state, NOW + 900, listen, opts(tunnel=lambda: frozenset())
    )
    out = signals_of(state, used, NOW + 900)
    assert codes(out)["tripwire.recorded"] == "ok" and "tripwire.changed" not in codes(out)
    # a cloudflared ingress rule that sends traffic to the new port makes it a problem
    state2 = baseline()
    state2, used2, _ = tripwire.step(
        FILES, state2, NOW + 900, listen, opts(tunnel=lambda: frozenset({8123}))
    )
    assert (
        codes(signals_of(state2, used2, NOW + 900, opts(tunnel=lambda: frozenset({8123}))))[
            "tripwire.changed"
        ]
        == "failed"
    )


def test_declared_listener_from_the_manifest_is_explained():
    manifest = [
        {
            "role": "workstation",
            "listen": "tcp *:8123",
            "processes": ["node"],
            "ref": "reviewed commit abc",
        }
    ]
    state = baseline()
    listen = {"listen tcp *:22": "sshd", "listen tcp *:8123": "node"}
    o = opts(manifest=manifest, tunnel=lambda: frozenset({8123}))
    state, used, _ = tripwire.step(FILES, state, NOW + 900, listen, o)
    assert state["events"][0]["ack"] and "reviewed commit" in state["events"][0]["ack_note"]
    assert "tripwire.changed" not in codes(signals_of(state, used, NOW + 900, o))


def test_unreadable_socket_scan_carries_the_baseline_listeners_over():
    state = baseline()
    state, used, _ = tripwire.step(FILES, state, NOW + 900, None, opts())
    assert used is not None
    assert not state["events"] and used["listen tcp *:22"] == "sshd"


def test_empty_scan_changes_nothing():
    state = baseline()
    again, used, first = tripwire.step({}, state, NOW + 900, None, opts())
    assert again == state and used is None and not first


def test_agent_sudo_explainer_credits_a_traced_write(tmp_path):
    path = tmp_path / "sudo.json"
    event = {
        "at": NOW - 60,
        "kind": "sensitive",
        "read_only": False,
        "paths": ["/etc/sudoers"],
        "family": "tee",
        "actor": {"label": "Agent in session abcd1234", "kind": "agent"},
    }
    path.write_text(json.dumps({"events": [event]}))
    explain = tripwire.agent_sudo_explainer(path)
    note, actors = explain(["/etc/sudoers"], NOW, NOW - 300)
    assert note == "made with sudo by Agent in session abcd1234" and actors[0]["via"] == "sudo tee"
    assert explain(["/etc/sudoers", "/etc/ssh/sshd_config"], NOW, NOW - 300) == (
        "",
        [],
    )  # every file must be credited
    assert explain(["/etc/sudoers"], NOW + 3600, NOW + 3000) == ("", [])  # outside the window


def local_site(tmp_path):
    sudoers = tmp_path / "sudoers"
    sudoers.write_text("root ALL=(ALL) ALL\n")
    return site_for(
        tmp_path,
        paths=[str(sudoers), str(tmp_path / "missing")],
        sudoers_globs=[str(sudoers)],
        more_paths=[],
        pve_extra_paths=[],
    ), sudoers


SS = 'tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))\n'


def test_workstation_pass_baselines_then_flags_a_change(tmp_path):
    site, sudoers = local_site(tmp_path)
    run = Fake((["ss"], Result(0, SS)), (["ip"], Result(0, "")))
    cfg = {"dpkg_log": str(tmp_path / "dpkg.log"), "cloudflared_config": str(tmp_path / "none.yml")}
    first = tripwire.workstation(mkctx("tripwire", run, site, **cfg))
    assert codes(first) == {"tripwire.baselined": "ok"}
    assert codes(tripwire.workstation(mkctx("tripwire", run, site, **cfg))) == {
        "tripwire.state": "ok"
    }
    sudoers.write_text("root ALL=(ALL) ALL\nkasadis ALL=(ALL) NOPASSWD: ALL\n")
    out = tripwire.workstation(mkctx("tripwire", run, site, **cfg))
    assert codes(out) == {"tripwire.changed": "failed"}
    assert str(sudoers) in out[0].fields["msg"]
    state_file = core.STATE_PATH.parent / "tripwire" / "davion-sidarli.json"
    assert json.loads(state_file.read_text())["events"][0]["changed"] == [str(sudoers)]


def test_pve_pass_reads_the_snippet_and_reports_unreachable(tmp_path):
    site, _ = local_site(tmp_path)
    text = "===NS tripwire\nF\t/etc/sudoers\tabc 0:0 440 file\nLOK\nB 1\nAOK\n"
    ok = Fake((["ssh"], Result(0, text)))
    assert codes(tripwire.pve_host(mkctx("tripwire", ok, site))) == {"tripwire.baselined": "ok"}
    assert (
        "ns_tw" in ok.calls[0][1] and "/etc/pve/priv/authorized_keys" not in ok.calls[0][1]
    )  # extras come from data
    down = Fake((["ssh"], Result(255, "", "Connection timed out")))
    out = tripwire.pve_host(mkctx("tripwire", down, site))
    assert codes(out) == {"tripwire.unreachable": "warn"} and "timed out" in out[0].fields["why"]


def test_corrupt_state_is_set_aside_and_unreadable_is_not_saved_over(tmp_path):
    path = tmp_path / "t.json"
    path.write_text("{not json")
    assert tripwire.load_json(path) == {}
    assert list(tmp_path.glob("t.json.corrupt-*"))
    path.write_text("{}")
    path.chmod(0)
    if os.geteuid() != 0:
        with pytest.raises(tripwire.Unreadable):
            tripwire.load_json(path)


# ---------------------------------------------------------------- sudo


def test_command_family_and_message_parsing():
    tools = RULES.subcommand_tools
    assert sudo.command_family("/usr/bin/systemctl restart foo", tools) == "systemctl restart"
    assert sudo.command_family("env A=1 /usr/bin/stat -c %s /x", tools) == "stat"
    assert sudo.command_family("/home/u/.local/bin/nightshift check", tools) == "bin/nightshift"
    p = sudo.parse_sudo_message(" kasadis : PWD=/x ; USER=root ; COMMAND=/usr/bin/cat /etc/sudoers")
    assert p == {
        "user": "kasadis",
        "run_as": "root",
        "command": "/usr/bin/cat /etc/sudoers",
        "failure": "",
    }
    bad = sudo.parse_sudo_message(
        " kasadis : 3 incorrect password attempts ; PWD=/x ; COMMAND=/usr/bin/ls"
    )
    assert bad and bad["failure"] == "incorrect password"
    assert sudo.parse_sudo_message("pam_unix(sudo:session): session closed") is None


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        ("/usr/bin/cat /etc/sudoers", True),
        ("/usr/bin/grep -r x /etc/ssh/", True),
        ("/usr/sbin/visudo -c", True),
        ("/usr/sbin/visudo -f /etc/sudoers.d/x", False),
        ("/usr/bin/find /etc -name x", True),
        ("/usr/bin/find /etc -name x -exec rm {} ;", False),
        ("/usr/sbin/sshd -t", True),
        ("/usr/sbin/sshd -f /etc/ssh/sshd_config", False),
        ("/usr/bin/ssh-keygen -lf /root/.ssh/authorized_keys", True),
        ("/usr/bin/ssh-keygen -R host", False),
        ("/tmp/cat /etc/sudoers", False),  # not the system's cat
        ("/usr/bin/tee /etc/sudoers.d/x", False),
        ("/usr/local/bin/host-steward check", True),
        ("/usr/local/bin/host-steward security-ack", False),
    ],
)
def test_read_only(command, expected):
    assert sudo.read_only(command, RULES.own_tools) is expected


def test_written_paths_only_count_known_writers_and_tracked_files():
    tracked = RULES.tracked
    assert sudo.written_paths("/usr/bin/tee /etc/sudoers", tracked) == ["/etc/sudoers"]
    assert sudo.written_paths("/usr/bin/cp /tmp/x /etc/sudoers.d/60-x", tracked) == [
        "/etc/sudoers.d/60-x"
    ]
    assert sudo.written_paths(
        "/usr/bin/bash -c echo x >> /home/u/.ssh/authorized_keys", tracked
    ) == ["/home/u/.ssh/authorized_keys"]
    assert sudo.written_paths("/usr/bin/cat /etc/sudoers", tracked) == []
    assert sudo.written_paths("/usr/bin/tee /etc/hosts", tracked) == []


def test_own_tool_note_text_is_not_scanned():
    cmd = "/usr/local/bin/host-steward declare --reason fix /etc/sudoers.d --hours 2"
    assert RULES.sensitive.search(sudo._scanned(cmd, RULES.own_tools)) is None
    assert RULES.sensitive.search(sudo._scanned("/usr/bin/tee /etc/sudoers", RULES.own_tools))


def entry(at, msg, unit="", cgroup=""):
    return (at, msg, unit, cgroup)


def test_ingest_buckets_families_and_returns_events():
    state: dict = {}
    entries = [
        entry(NOW, " u : PWD=/ ; USER=root ; COMMAND=/usr/bin/cat /etc/sudoers", "x.service"),
        entry(NOW, " u : PWD=/ ; USER=root ; COMMAND=/usr/bin/tee /etc/sudoers.d/x"),
        entry(NOW, " u : PWD=/ ; USER=root ; COMMAND=/usr/bin/ls /tmp"),
        entry(NOW, " u : 3 incorrect password attempts ; PWD=/ ; USER=root ; COMMAND=/usr/bin/ls"),
    ]
    events = sudo.ingest_sudo(state, entries, RULES)
    kinds = [(e["kind"], e.get("read_only")) for e in events]
    assert kinds == [("sensitive", True), ("sensitive", False), ("failure", None)]
    assert events[1]["paths"] == ["/etc/sudoers.d/x"]
    hour = sudo._hour(NOW)
    assert state["hours"][hour]["cat"] == 1 and state["hours"][hour]["ls"] == 2
    assert state["callers"][hour]["cat"] == {"x.service": 1}


def test_traced_events_are_recorded_and_acknowledged():
    actor = {"kind": "agent", "label": "Agent in session abcd1234"}
    events = sudo.ingest_sudo(
        {},
        [entry(NOW, " u : PWD=/ ; USER=root ; COMMAND=/usr/bin/tee /etc/sudoers", "", SCOPE)],
        RULES,
        who=lambda cg, at: actor,
    )
    assert events[0]["recorded"] and events[0]["ack"] and events[0]["actor"] == actor


def test_a_new_family_names_who_ran_it_and_never_the_command_line(tmp_path):
    """The sudo row says which agent ran what: the family (userdel), not its arguments, and the traced caller."""
    state = hours_state(5)
    secret = "TOKEN=hunter2"
    entries = [
        entry(NOW, f" u : PWD=/ ; USER=root ; COMMAND=/usr/sbin/userdel {secret} olduser", "", SCOPE),
        entry(NOW, " u : PWD=/ ; USER=root ; COMMAND=/usr/bin/lsof -i", "", SCOPE),
        entry(NOW, " u : PWD=/ ; USER=root ; COMMAND=/usr/bin/whoami", "", ""),
        # also run by a caller nobody traced, so the family is not agent-only and still warns
        entry(NOW, " u : PWD=/ ; USER=root ; COMMAND=/usr/sbin/userdel other", "", ""),
    ]
    calls = []

    def who(cgroup, at):
        calls.append(cgroup)
        return {"kind": "agent", "label": "Agent in session abcd1234"}

    sudo.ingest_sudo(state, entries, RULES, who=who)
    assert len(calls) == 2  # once per family and cgroup, none for a caller with no cgroup
    sig = next(s for s in evaluate(state, tmp_path) if s.code == "sudo.new_family")
    assert "userdel (Agent in session abcd1234)" in sig.fields["families"]
    assert "whoami" in sig.fields["families"]  # not traced: the bare name
    text = core.explain(sig.code, sig.fields, DATA["meanings"], True, sig.state)
    assert "userdel (Agent in session abcd1234)" in text and "hunter2" not in text


def test_traced_names_per_family_stay_few_and_leave_with_the_family():
    state: dict = {}
    for n in range(5):
        entries = [entry(NOW + n, " u : PWD=/ ; USER=root ; COMMAND=/usr/bin/lsof -i", "", SCOPE)]
        sudo.ingest_sudo(state, entries, RULES, who=lambda cg, at, n=n: {"label": f"Agent in session aaaa000{n}"})
    assert sorted(state["actors"]["lsof"]) == [f"Agent in session aaaa000{n}" for n in (2, 3, 4)]
    # when the family's hours age out of the kept window, its names go with it
    old = {"hours": {"2026-01-01T00": {"gone": 1}}, "actors": {"gone": {"Agent in session aaaa0000": 1.0}}}
    sudo.ingest_sudo(old, [entry(NOW, " u : PWD=/ ; USER=root ; COMMAND=/usr/bin/stat /x")], RULES, keep_hours=1)
    assert old["actors"] == {}


def test_sudo_open_groups_per_user_hour_and_skips_acked_and_bootstrap():
    def ev(**k):
        return {
            "at": NOW - 100,
            "kind": "sensitive",
            "user": "u",
            "family": "tee",
            "target": "/etc/sudoers",
            **k,
        }

    state = {
        "events": [
            ev(),
            ev(),
            ev(ack=True),
            ev(bootstrap=True),
            {"at": NOW - 99, "kind": "failure", "user": "u"},
        ]
    }
    open_ = sudo.sudo_open(state, "h", NOW, 24)
    kinds = sorted(code.split(".")[0] for code in open_)
    assert kinds == ["failure", "sensitive"]
    assert len(next(v for k, v in open_.items() if k.startswith("sensitive"))) == 2


def hours_state(days, per_hour=2, family="stat", now=NOW):
    hours = {}
    for h in range(days * 24 + 1):
        hours[sudo._hour(now - h * 3600)] = {family: per_hour}
    return {"hours": hours, "events": []}


def evaluate(state, tmp_path, **over):
    ctx = mkctx("sudo", site=site_for(tmp_path), **over)
    return sudo.evaluate(state, NOW, ctx, RULES, "davion-sidarli", 3)


def test_evaluate_learning_spike_and_new_family(tmp_path):
    quiet = evaluate(hours_state(5), tmp_path)
    assert codes(quiet) == {"sudo.summary": "ok"}
    # a bigger day than twice the median (and the extra floor)
    spike = hours_state(5, per_hour=2)
    spike["hours"][sudo._hour(NOW)] = {"stat": 4000}
    assert codes(evaluate(spike, tmp_path))["sudo.spike"] == "warn"
    # a family nobody used in the earlier windows
    new = hours_state(5)
    new["hours"][sudo._hour(NOW)]["brandnew"] = 1
    out = evaluate(new, tmp_path)
    assert codes(out)["sudo.new_family"] == "warn" and "brandnew" in next(
        s.fields["families"] for s in out if s.code == "sudo.new_family"
    )
    # a known family never counts as new
    new["hours"][sudo._hour(NOW)] = {"stat": 2, "host-steward check": 1}
    assert "sudo.new_family" not in codes(evaluate(new, tmp_path))
    # still learning (under learn_days of history): no spike or new-family judgement
    assert set(codes(evaluate(hours_state(1), tmp_path))) == {"sudo.summary"}


def test_new_family_row_lists_three_and_says_what_to_do(tmp_path):
    """The owner sees what was new (three commands, then a count), when that is expected, and what to do."""
    new = hours_state(5)
    for fam in ("alpha", "bravo", "charlie", "delta", "echo"):
        new["hours"][sudo._hour(NOW)][fam] = 1
    sig = next(s for s in evaluate(new, tmp_path) if s.code == "sudo.new_family")
    text = core.explain(sig.code, sig.fields, DATA["meanings"], True, sig.state)
    assert text.startswith("5 new sudo commands: alpha, bravo, charlie and 2 more.")
    assert "delta" not in text and "host-steward declare" in text
    assert "normal after a day" in text and "journalctl -t sudo" in text
    one = core.explain(sig.code, {**sig.fields, "n": 1, "plural": "", "families": ["alpha"]}, DATA["meanings"], False)
    assert one == "1 new sudo command: alpha."


def test_new_family_from_a_known_automation_service_is_only_a_note(tmp_path):
    state = hours_state(5)
    hour = sudo._hour(NOW)
    state["hours"][hour]["backup"] = 3
    state["callers"] = {hour: {"backup": {"aico-backup-guard.service": 3}}}
    site = site_for(tmp_path)
    ctx = mkctx("sudo", site=site)
    rule = sudo.Rules(**{**RULES.__dict__, "trusted": site["trusted_units"]})
    out = sudo.evaluate(state, NOW, ctx, rule, "h", 3)
    assert (
        codes(out)["sudo.new_family.auto"] == "ok"
        and next(s for s in out if s.code == "sudo.new_family.auto").note
    )


def test_new_family_run_only_by_agent_sessions_is_a_note_but_mixed_callers_still_warn(tmp_path):
    """Agents have routine root: a command family only traced agent sessions ran is a note. One call from anyone else
    (or an untraced caller) keeps the warning, so a stranger using sudo is still seen."""
    agent = {"kind": "agent", "label": "Agent in session abcd1234"}
    state = hours_state(5)
    sudo.ingest_sudo(
        state,
        [entry(NOW, " u : PWD=/ ; USER=root ; COMMAND=/usr/sbin/dmidecode -t memory", "", SCOPE)] * 2,
        RULES,
        who=lambda cg, at: agent,
    )
    out = evaluate(state, tmp_path)
    assert "sudo.new_family" not in codes(out)
    note = next(s for s in out if s.code == "sudo.new_family.auto")
    assert note.state == "ok" and note.note and "Agent in session abcd1234" in note.fields["by"]
    mixed = hours_state(5)
    sudo.ingest_sudo(
        mixed,
        [entry(NOW, " u : PWD=/ ; USER=root ; COMMAND=/usr/sbin/dmidecode -t memory", "", SCOPE)],
        RULES,
        who=lambda cg, at: agent,
    )
    sudo.ingest_sudo(
        mixed, [entry(NOW, " u : PWD=/ ; USER=root ; COMMAND=/usr/sbin/dmidecode -t bios", "", "")], RULES
    )
    assert codes(evaluate(mixed, tmp_path))["sudo.new_family"] == "warn"


def test_backup_guard_volume_from_aicos_backup_units_is_only_a_note(tmp_path):
    """The backup guard runs the window helper every 5 minutes from Aico's user unit: its volume follows that
    schedule (288 a day against an older baseline of 13) and never warns."""
    family = "summitflow-backup-window"
    state = hours_state(5, per_hour=0, family=family)
    for h in range(5 * 24 + 1):  # the older schedule: about 13 a day
        state["hours"][sudo._hour(NOW - h * 3600)][family] = 1 if h % 2 else 0
    callers = {}
    for h in range(24):
        hour = sudo._hour(NOW - h * 3600)
        state["hours"][hour][family] = 12
        callers[hour] = {family: {"aico-backup-guard.service": 12}}
    state["callers"] = callers
    site = site_for(tmp_path)
    ctx = mkctx("sudo", site=site)
    rule = sudo.Rules(**{**RULES.__dict__, "trusted": site["trusted_units"]})
    out = codes(sudo.evaluate(state, NOW, ctx, rule, "h", 3))
    assert "sudo.family_spike" not in out and out["sudo.family_spike.auto"] == "ok"


def sensitive(at, **k):
    return {
        "at": at,
        "kind": "sensitive",
        "user": "kasadis",
        "family": "tee",
        "target": "/etc/sudoers",
        "read_only": False,
        **k,
    }


def test_open_sensitive_write_is_failed_read_is_ok_and_declaration_closes_it(tmp_path):
    site = site_for(tmp_path)
    ctx = mkctx("sudo", site=site)
    state = {"events": [sensitive(NOW - 600), sensitive(NOW - 300, read_only=True, user="other")]}
    out = sudo._open_signals(state, NOW, ctx, "davion-sidarli", 24.0, 3)
    assert codes(out) == {"sudo.sensitive": "failed", "sudo.read": "ok"}
    declare.declare(
        site["declarations"],
        site,
        "workstation",
        "config",
        2,
        "tidy sudoers",
        since_h=1,
        now=NOW - 100,
    )
    out = sudo._open_signals(state, NOW, mkctx("sudo", site=site), "davion-sidarli", 24.0, 3)
    assert codes(out) == {"sudo.declared": "ok", "sudo.read": "ok"}
    keys = {"events": [sensitive(NOW - 600, target="authorized_keys")]}
    assert codes(
        sudo._open_signals(keys, NOW, mkctx("sudo", site=site), "davion-sidarli", 24.0, 3)
    ) == {
        "sudo.sensitive": "failed"  # the declaration was for config, not keys
    }


def test_failure_event_warns(tmp_path):
    state = {
        "events": [
            {"at": NOW - 60, "kind": "failure", "user": "kasadis", "detail": "incorrect password"}
        ]
    }
    out = sudo._open_signals(state, NOW, mkctx("sudo", site=site_for(tmp_path)), "h", 24.0, 3)
    assert codes(out) == {"sudo.failure": "warn"} and out[0].fields["id"].startswith("failure.")


def test_recorded_events_become_a_note_naming_the_actor():
    actor = {"kind": "agent", "label": "Agent in session abcd1234"}
    state = {"events": [sensitive(NOW - 60, recorded=True, ack=True, actor=actor)]}
    (note,) = sudo._recorded(state, "h", NOW, 24.0, 3)
    assert (
        note.note
        and "Agent in session abcd1234 did this" in note.fields["msg"]
        and "changed /etc/sudoers" in note.fields["msg"]
    )


def journal_line(at, message, cursor):
    return json.dumps(
        {"MESSAGE": message, "__REALTIME_TIMESTAMP": str(int(at * 1e6)), "__CURSOR": cursor}
    )


def test_sudo_check_reads_the_journal_with_a_cursor_and_keeps_state(tmp_path):
    site = site_for(tmp_path)
    lines = [
        journal_line(
            NOW - 30, " kasadis : PWD=/ ; USER=root ; COMMAND=/usr/bin/cat /etc/sudoers", "c1"
        ),
        journal_line(
            NOW - 20, " kasadis : PWD=/ ; USER=root ; COMMAND=/usr/bin/tee /etc/sudoers", "c2"
        ),
        "-- cursor: c2",
    ]
    run = Fake((["journalctl"], Result(0, "\n".join(lines))))
    out = sudo.run(mkctx("sudo", run, site))
    # the first read is the bootstrap: events are recorded, never raised
    assert codes(out) == {"sudo.summary": "ok"}
    argv = run.calls[0][0]
    assert (
        "--since" in argv
        and "_EXE=/usr/lib/cargo/bin/sudo" in argv
        and "_EXE=/usr/bin/sudo" in argv
    )
    state = json.loads((core.STATE_PATH.parent / "sudo-baseline.json").read_text())
    assert state["cursor"] == "c2" and all(e["bootstrap"] for e in state["events"])
    assert stat.S_IMODE((core.STATE_PATH.parent / "sudo-baseline.json").stat().st_mode) == 0o600
    # the next pass continues from the cursor and now a write is a problem
    more = [
        journal_line(
            NOW - 5, " kasadis : PWD=/ ; USER=root ; COMMAND=/usr/bin/tee /etc/sudoers.d/x", "c3"
        ),
        "-- cursor: c3",
    ]
    run2 = Fake((["journalctl"], Result(0, "\n".join(more))))
    out2 = sudo.run(mkctx("sudo", run2, site))
    assert "--after-cursor" in run2.calls[0][0] and run2.calls[0][0][-1] == "c2"
    assert codes(out2)["sudo.sensitive"] == "failed"


def test_sudo_check_reports_an_unreadable_journal(tmp_path):
    out = sudo.run(
        mkctx("sudo", Fake((["journalctl"], Result(1, "", "denied"))), site_for(tmp_path))
    )
    assert codes(out) == {"sudo.unreadable": "warn"}


# ---------------------------------------------------------------- security ack job


def test_security_ack_confirms_open_events_one_or_all(tmp_path):
    site = site_for(tmp_path)
    data = {**DATA, "site": site}
    root = core.STATE_PATH.parent
    (root / "tripwire").mkdir(parents=True)
    (root / "tripwire" / "h.json").write_text(
        json.dumps({"events": [{"id": "e1", "at": NOW}, {"id": "e2", "at": NOW}]})
    )
    (root / "sudo-baseline.json").write_text(json.dumps({"events": [sensitive(NOW - 60)]}))
    assert security_ack.acknowledge(data, "checked", NOW, "e1") == 1
    code = next(
        iter(
            sudo.sudo_open(
                json.loads((root / "sudo-baseline.json").read_text()), "davion-sidarli", NOW, 24
            )
        )
    )
    assert security_ack.acknowledge(data, "checked", NOW, code) == 1
    assert security_ack.acknowledge(data, "checked", NOW, "nope") == 0
    assert security_ack.acknowledge(data, "all", NOW) == 1  # e2 is the only one left
    events = json.loads((root / "tripwire" / "h.json").read_text())["events"]
    assert [e.get("ack_note") for e in events] == ["checked", "all"]


# ---------------------------------------------------------------- docker access


def test_docker_access(tmp_path):
    group = tmp_path / "group"
    group.write_text("root:x:0:\ndocker:x:998:\n")
    sock = str(tmp_path / "docker.sock")

    def fake(mode, uid=0, gid=998, kind=stat.S_IFSOCK):
        return lambda _p: os.stat_result((kind | mode, 0, 0, 1, uid, gid, 0, 0, 0, 0))

    assert security.check(str(group), sock, fake(0o660)).state == "ok"
    assert (
        security.check(
            str(group), sock, lambda _p: (_ for _ in ()).throw(FileNotFoundError())
        ).state
        == "ok"
    )
    bad = security.check(str(group), sock, fake(0o666))
    assert bad.state == "warn" and "0666" in bad.fields["problems"]
    group.write_text("docker:x:998:kasadis\n")
    members = security.check(str(group), sock, fake(0o660))
    assert members.state == "warn" and "kasadis" in members.fields["problems"]
    out = security.run(mkctx("security", group_file=str(tmp_path / "missing")))
    assert codes(out) == {"security.docker.unreadable": "warn"}


# ---------------------------------------------------------------- attribution


def _proc(root, pid, comm, ppid, argv=(), env=None, cgroup=SCOPE, uid=1000, start=NOW - 3600):
    d = root / str(pid)
    d.mkdir(parents=True)
    if not (root / "stat").exists():
        (root / "stat").write_text("cpu 1 2 3\nbtime 1791000000\n")
    ticks = int((start - 1791000000) * TICK)
    (d / "stat").write_text(f"{pid} ({comm}) S {ppid} " + " ".join(["0"] * 17) + f" {ticks} 0 0")
    (d / "status").write_text(f"Name:\t{comm}\nUid:\t{uid}\t{uid}\t{uid}\t{uid}\n")
    (d / "cmdline").write_bytes(b"\0".join(a.encode() for a in argv or [comm]) + b"\0")
    (d / "environ").write_bytes(
        b"\0".join(f"{k}={v}".encode() for k, v in (env or {}).items()) + b"\0"
    )
    (d / "cgroup").write_text(f"0::{cgroup}\n")


def owner(root=None, units=None):
    settings = DATA["site"]["attribution"]
    return attribution.Owner(1000, "/home/u", units, root=str(root or "/"), settings=settings)


def test_agent_ancestry_names_the_session_and_tool(tmp_path):
    _proc(tmp_path, 100, "bash", 1)
    _proc(
        tmp_path, 200, "claude", 100, env={"AICO_WIDGET_ID": "6d5fa44e", "AICO_PROJECT_ID": "aico"}
    )
    _proc(tmp_path, 300, "pytest", 200, argv=["pytest", "-q"])
    _proc(tmp_path, 400, "python3", 300)
    who = attribution.of_pid(400, owner(), tmp_path)
    assert (
        who and who["kind"] == "agent" and who["tool"] == "Claude Code" and who["via"] == "pytest"
    )
    assert who["label"] == "Agent in session 6d5fa44e"
    _proc(
        tmp_path, 500, "nc", 100
    )  # the owner's shell with no agent above it, and no agent in its scope before it
    _proc(tmp_path, 700, "claude", 100, uid=1001)
    _proc(tmp_path, 701, "nc", 700, uid=1001)
    assert attribution.of_pid(701, owner(), tmp_path) is None  # another user's "claude" is not ours
    _proc(tmp_path, 600, "codex", 100, env={"AICO_WIDGET_ID": "not hex!"})
    _proc(tmp_path, 601, "nc", 600)
    outside = attribution.of_pid(601, owner(), tmp_path)
    assert (
        outside and outside["tool"] == "Codex" and outside["label"] == "Codex session outside Aico"
    )


def test_trusted_unit_is_ours_only_when_persistent(tmp_path):
    units = {"system": {}, "user": {"aico-web.service": "aico"}}
    who = owner(tmp_path, units)
    cg = "/user.slice/user-1000.slice/user@1000.service/app.slice/aico-web.service"
    assert attribution.of_cgroup(cg, NOW, who, tmp_path, tmp_path) is None  # no unit file in place
    unit_dir = tmp_path / "home/u/.config/systemd/user"
    unit_dir.mkdir(parents=True)
    (unit_dir / "aico-web.service").write_text("[Service]\n")
    svc = attribution.of_cgroup(cg, NOW, who, tmp_path, tmp_path)
    assert svc and svc["kind"] == "summitflow" and svc["unit"] == "aico-web.service"
    (tmp_path / "run/user/1000/systemd/transient").mkdir(parents=True)
    (tmp_path / "run/user/1000/systemd/transient/aico-web.service").write_text("")
    assert (
        attribution.of_cgroup(cg, NOW, who, tmp_path, tmp_path) is None
    )  # a transient unit of that name is not it
    assert attribution.of_cgroup("/system.slice/../x.service", NOW, who, tmp_path, tmp_path) is None
    assert attribution.of_pid(1, None) is None


# ---------------------------------------------------------------- declarations and lab use


def test_declare_round_trip_window_and_validation(tmp_path):
    site = site_for(tmp_path)
    cfg = site["declarations"]
    with pytest.raises(ValueError, match="--what"):
        declare.declare(cfg, site, "workstation", "bogus", 1, "x")
    with pytest.raises(ValueError, match="--reason"):
        declare.declare(cfg, site, "workstation", "units", 1, " ")
    with pytest.raises(ValueError, match="--host"):
        declare.declare(cfg, site, "bad host!", "units", 1, "x")
    e = declare.declare(cfg, site, "pve", "packages", 99, "upgrade", since_h=50, by="me", now=NOW)
    assert e["until"] - e["made"] == 24 * 3600 and e["made"] - e["at"] == 4 * 3600  # both capped
    got = declare.covering(cfg, "davion-gem", "packages", NOW - 3600, now=NOW + 60)
    assert got and declare.name(got) == "me" and "upgrade" in declare.said(got)
    assert declare.covering(cfg, "davion-gem", "packages", NOW - 3600, now=NOW + 60, owner_uid=None)
    assert (
        declare.covering(cfg, "davion-sidarli", "packages", NOW - 3600, now=NOW + 60) is None
    )  # other host
    assert (
        declare.covering(cfg, "davion-gem", "keys", NOW - 3600, now=NOW + 60) is None
    )  # other kind
    assert (
        declare.covering(cfg, "davion-gem", "packages", NOW - 8 * 3600, now=NOW + 60) is None
    )  # before the window
    assert (
        declare.covering(cfg, "davion-gem", "packages", NOW + 25 * 3600, now=NOW + 26 * 3600)
        is None
    )  # after
    assert declare.match(declare.declarations(cfg, NOW + 60), "davion-gem", "other", NOW) is None


def test_a_declaration_is_never_taken_to_predate_the_reader_seeing_it(tmp_path):
    site = site_for(tmp_path)
    cfg = site["declarations"]
    # written "now" with --since 4h, but the reader first sees it an hour later: it starts no earlier than 4h before then
    declare.declare(cfg, site, "workstation", "config", 6, "x", since_h=4, now=NOW)
    seen = NOW + 3 * 3600
    rows = declare.declarations(cfg, seen)
    assert rows[0]["at"] == seen - 4 * 3600
    Path(cfg["first_seen_file"]).unlink()
    later = declare.declarations(cfg, NOW + 5 * 3600)
    assert later[0]["at"] == NOW + 5 * 3600 - 4 * 3600


def test_untrusted_files_are_ignored(tmp_path):
    site = site_for(tmp_path)
    cfg = site["declarations"]
    declare.declare(cfg, site, "workstation", "config", 2, "x", now=NOW)
    path = Path(cfg["file"])
    path.chmod(0o666)  # world-writable: never trusted
    assert declare.declarations(cfg, NOW + 10) == []
    path.chmod(0o644)
    assert len(declare.declarations(cfg, NOW + 10)) == 1
    path.write_text("[" * 50)
    assert declare.declarations(cfg, NOW + 10) == []


def test_lab_use_start_end_and_vm_declaration(tmp_path):
    site = site_for(tmp_path)
    cfg = site["declarations"]
    with pytest.raises(ValueError, match="asset"):
        declare.start_lab_use(cfg, "Bad Name!", 1, "x")
    declare.start_lab_use(cfg, "Lab-Linux-1", 2, "kernel test", "me", now=NOW)
    assert declare.lab_use(cfg, NOW + 60)["lab-linux-1"]["by"] == "me"
    assert declare.lab_use(cfg, NOW + 3 * 3600) == {}  # ended by itself
    assert declare.end_lab_use(cfg, "lab-linux-1", NOW + 60) is True
    declare.declare(cfg, site, "lab-linux-2", "vm", 1, "boot it", now=NOW)
    assert "lab-linux-2" in declare.lab_use(cfg, NOW + 60)


# ---------------------------------------------------------------- the commands


def run_cli(monkeypatch, tmp_path, capsys, *argv):
    monkeypatch.setenv("HOST_STEWARD_DECLARATIONS", str(tmp_path / "d.json"))
    monkeypatch.setenv("HOST_STEWARD_LAB_USE", str(tmp_path / "l.json"))
    monkeypatch.setattr(declare, "_owner_uid", lambda _cfg: os.geteuid())
    rc = host_steward_main(list(argv))
    return rc, capsys.readouterr().out


def test_declare_and_lab_use_commands(monkeypatch, tmp_path, capsys):
    assert {"declare", "lab-use", "security-ack"} <= set(JOBS)
    rc, out = run_cli(
        monkeypatch,
        tmp_path,
        capsys,
        "declare",
        "--host",
        "pve",
        "--what",
        "units",
        "--reason",
        "restart a unit",
    )
    assert rc == 0 and out.startswith("declared units on pve by ")
    rc, out = run_cli(monkeypatch, tmp_path, capsys, "declare", "list")
    assert rc == 0 and "open until" in out and "units on pve" in out and "1 open" in out
    rc, out = run_cli(monkeypatch, tmp_path, capsys, "declare", "list", "--json")
    assert json.loads(out)[0]["host"] == "pve"
    rc, out = run_cli(
        monkeypatch, tmp_path, capsys, "declare", "--host", "pve", "--what", "nope", "--reason", "x"
    )
    assert rc == 2 and "--what" in out
    rc, out = run_cli(
        monkeypatch,
        tmp_path,
        capsys,
        "lab-use",
        "start",
        "lab-linux-1",
        "--reason",
        "test",
        "--hours",
        "1",
    )
    assert rc == 0 and out.startswith("declared lab-linux-1 until")
    rc, out = run_cli(monkeypatch, tmp_path, capsys, "lab-use", "list")
    assert "lab-linux-1" in json.loads(out)
    assert (
        run_cli(monkeypatch, tmp_path, capsys, "lab-use", "end", "lab-linux-1")[1].strip()
        == "ended"
    )
    assert (
        run_cli(monkeypatch, tmp_path, capsys, "lab-use", "end", "lab-linux-1")[1].strip()
        == "no declaration"
    )
    assert run_cli(monkeypatch, tmp_path, capsys, "lab-use", "start")[0] == 2


# ---------------------------------------------------------------- the data


def test_every_signal_the_checks_emit_has_a_meaning():
    table = DATA["meanings"]["signal"]
    problems = [
        "tripwire.changed", "tripwire.unavailable", "tripwire.unreachable", "sudo.unreadable", "sudo.spike",
        "sudo.new_family", "sudo.family_spike", "sudo.failure", "sudo.sensitive", "security.docker",
        "security.docker.unreadable",
    ]  # fmt: skip
    notes = [
        "tripwire.recorded", "tripwire.declared", "sudo.new_family.auto", "sudo.family_spike.auto", "sudo.declared",
        "sudo.recorded",
    ]  # fmt: skip
    assert all(code in table for code in problems)
    assert all(f"{code}:ok" in table for code in notes)
    assert {"tripwire", "sudo", "security"} <= set(DATA["meanings"]["ok"])
    row = core.make_row(
        "tripwire",
        [
            Signal(
                "tripwire.changed",
                "failed",
                {"host": "the workstation", "msg": "Auth config changed", "id": "e1"},
            )
        ],
        DATA["checks"]["tripwire"],
        DATA["meanings"],
        "m",
        time.time(),
        DATA["caps"],
    )
    assert row["state"] == "failed" and "security-ack --event e1" in row["meaning"]


def test_the_checks_are_registered_with_sudo_before_the_tripwire():
    from host_steward.checks import CHECKS

    order = list(CHECKS)
    assert order.index("sudo") < order.index("tripwire") and "security" in order
    for name in ("tripwire", "sudo", "security"):
        assert {"what", "every_min", "slack_min"} <= set(DATA["checks"][name])
