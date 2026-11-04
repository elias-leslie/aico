"""M5a review fixes: the guard's time format and cutover switch, one controller acting at a time, unreadable inputs
that must warn, the ECC history, and the run actions a user can really start."""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import stat
import time
from pathlib import Path

import pytest

from host_steward import acts, core, history
from host_steward.checks import ecc, memory, probes, storage, workstation
from host_steward.jobs import housekeeping, memctl, nvme_test, scrub, space_guard

DATA = core.load_data()
NOW = 1_800_000_000.0
DAY = 86400
GIB = 1024**3
Result = core.Result
HERE = Path(__file__).resolve().parents[1]


class Fake:
    """Command runner: the first rule whose words are all in argv answers; anything else is 'not found'."""

    def __init__(self, *rules):
        self.rules, self.calls = rules, []

    def __call__(self, argv, timeout=60, input_text=None):
        self.calls.append(list(argv))
        for words, result in self.rules:
            if all(word in argv for word in words):
                return result
        return Result(127, "", "not found")


class nightshift_on:
    """systemctl says every listed unit is enabled and active; anything else is off."""

    def __init__(self, *units):
        self.units, self.calls = units, []

    def __call__(self, argv, timeout=60, input_text=None):
        self.calls.append(list(argv))
        if argv[0] == "systemctl" and argv[-1] in self.units:
            return Result(0, "enabled\n")
        return Result(4 if argv[0] == "systemctl" else 127, "", "not found")


@pytest.fixture(autouse=True)
def state_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(core, "STATE_PATH", tmp_path / "state" / "state.json")
    monkeypatch.setattr(history, "DEFAULT_PATH", tmp_path / "history.sqlite3")


# the shared writer and time reader


def test_write_json_keeps_each_callers_file_mode_and_leaves_no_temp(tmp_path):
    plain = tmp_path / "a" / "plain.json"
    core.write_json(plain, {"b": 1, "a": 2})
    assert json.loads(plain.read_text()) == {"a": 2, "b": 1}
    private = tmp_path / "private.json"
    core.write_json(private, {"k": 1}, mode=0o600)
    assert stat.S_IMODE(private.stat().st_mode) == 0o600
    packed = tmp_path / "new" / "packed.json"
    core.write_json(packed, {"k": [1, 2]}, dir_mode=0o750, compact=True)
    assert packed.read_text() == '{"k":[1,2]}'
    assert stat.S_IMODE(packed.parent.stat().st_mode) == 0o750
    assert not [p for p in tmp_path.rglob("*.tmp")]
    assert acts.write_json is core.write_json


def test_write_json_failure_removes_its_temp_file(tmp_path):
    with pytest.raises(TypeError):
        core.write_json(tmp_path / "x.json", {"bad": object()})
    assert list(tmp_path.iterdir()) == []


def test_timestamp_reads_epoch_seconds_and_iso_times():
    assert core.timestamp(1_800_000_000.5) == 1_800_000_000.5
    assert core.timestamp(core.iso_time(NOW)) == NOW
    assert core.timestamp("2026-11-04T02:12:41.718831+00:00") == pytest.approx(
        1_793_758_361.7, abs=1
    )
    assert core.timestamp("2026-11-04T02:12:41") == core.timestamp("2026-11-04T02:12:41+00:00")
    assert core.timestamp(None) == core.timestamp("nope") == core.timestamp(True) == 0.0


def test_command_absent_has_one_definition():
    assert core.command_absent(Result(127))
    assert core.command_absent(Result(2, "", "st: No such command: cleanup"))
    assert not core.command_absent(Result(2, "", "other"))
    assert not hasattr(housekeeping, "command_absent") and not hasattr(
        space_guard, "command_absent"
    )


# item 1: the space guard's time and which file is the truth


def guard_report(live=None, exhausted=True, at=None):
    doc = {
        "filesystems": [
            {
                "path": "/",
                "ladder": {"tiers": ["ballast"], "exhausted": exhausted, "free_after_gib": 12},
            }
        ],
        "at": NOW - 60 if at is None else at,
    }
    if live is not None:
        doc["live"] = live
    return doc


ENTRY = {"name": "System disk", "path": "/"}


def test_reclaim_reads_both_time_formats():
    for at in (NOW - 60, core.iso_time(NOW - 60)):
        sig = storage.reclaim_signal(ENTRY, guard_report(at=at), 25.0, "", NOW, 7200)
        assert sig.code == "storage.reclaim.exhausted", at
    old = storage.reclaim_signal(ENTRY, guard_report(at=NOW - 3 * 3600), 25.0, "", NOW, 7200)
    assert old.code == "storage.reclaim.idle"


def test_a_dry_run_ladder_never_reads_as_exhausted():
    sig = storage.reclaim_signal(ENTRY, guard_report(live=False), 25.0, "", NOW, 7200)
    assert (sig.code, sig.state) == ("storage.reclaim.idle", "ok")
    assert (
        storage.reclaim_signal(ENTRY, guard_report(live=True), 25.0, "", NOW, 7200).state
        == "failed"
    )


def test_newest_state_orders_epoch_and_iso_files(tmp_path):
    older, newer = tmp_path / "older.json", tmp_path / "newer.json"
    older.write_text(json.dumps({"at": NOW - 100, "k": "older"}))
    newer.write_text(json.dumps({"at": core.iso_time(NOW), "k": "newer"}))
    assert storage.newest_state([str(newer), str(older)])["k"] == "newer"
    assert storage.newest_state([str(older), str(newer)])["k"] == "newer"


def test_the_space_guard_writes_iso_time(tmp_path, monkeypatch):
    fake = Fake(
        (["findmnt", "-n"], Result(0, "/dev/nvme0n1p2[/@]\n")),
        (
            ["findmnt", "--json"],
            Result(0, json.dumps({"filesystems": [{"fstype": "btrfs", "options": "rw"}]})),
        ),
        (["btrfs", "filesystem", "show"], Result(0, "Total devices 1")),
        (["btrfs", "balance", "status"], Result(0, "No balance found")),
        (
            ["btrfs", "filesystem", "usage"],
            Result(
                0,
                f"Device size: {500 * GIB}\nDevice unallocated: {50 * GIB}\nDevice missing: 0\nFree (estimated): {100 * GIB}\n",
            ),
        ),
    )
    monkeypatch.setattr(core, "run_command", fake)
    cfg = {**DATA["jobs"]["space-guard"], "top_mounts": str(tmp_path / "tops"), "grow_roots": []}
    data = {**DATA, "jobs": {**DATA["jobs"], "space-guard": cfg}}
    space_guard.main(argparse.Namespace(no_post=True), data, lambda row: True)
    saved = json.loads((acts.job_dir() / "space-guard.json").read_text())
    assert isinstance(saved["at"], str) and abs(core.timestamp(saved["at"]) - time.time()) < 60
    assert saved["live"] is False


def test_the_storage_check_reads_nightshifts_file_until_space_guard_acts(tmp_path, monkeypatch):
    theirs, own = tmp_path / "nightshift.json", acts.job_dir() / "space-guard.json"
    theirs.write_text(
        json.dumps({"at": core.iso_time(NOW), "ballast": {"/": 6 * GIB}, "who": "nightshift"})
    )
    own.parent.mkdir(parents=True)
    own.write_text(json.dumps({"at": core.iso_time(NOW + 5), "live": True, "who": "own"}))
    cfg = {**DATA["checks"]["storage"], "guard_inherit": [str(theirs)]}
    assert storage.guard_state(cfg, False)["who"] == "nightshift"
    assert storage.guard_state(cfg, True)["who"] == "own"
    # the newer file of a dry run is not preferred over Nightshift's real one
    own.write_text(json.dumps({"at": core.iso_time(NOW + 500), "live": False, "who": "own-dry"}))
    assert storage.guard_state(cfg, False)["who"] == "nightshift"


def test_memctl_reads_the_ballast_record_the_cutover_flag_picks():
    data = copy.deepcopy(DATA)
    paths = data["memctl"]["paths"]
    assert memctl.ballast_file(data) == Path(paths["ballast_state"])
    data["acting"]["space_guard"] = True
    assert memctl.ballast_file(data) == Path(paths["ballast_state_own"])
    assert paths["ballast_state_own"] != paths["ballast_state"]


def test_a_dry_run_starts_from_nightshifts_ballast_record(tmp_path):
    cfg = {**DATA["jobs"]["space-guard"], "inherit_state": str(tmp_path / "theirs.json")}
    (tmp_path / "theirs.json").write_text(json.dumps({"ballast": {"/": 1}}))
    acts.write_json(acts.job_dir() / "space-guard.json", {"ballast": {"/": 2}})
    assert space_guard.load_previous(cfg, False)["ballast"] == {"/": 1}
    assert space_guard.load_previous(cfg, True)["ballast"] == {"/": 2}


# item 3: a failed dry run warns


def test_a_dry_run_that_failed_warns():
    result = {
        "filesystems": [{"path": "/", "free_gib": 80.0, "error": "Btrfs usage unreadable"}],
        "would": ["vacuum the journal to 1G"],
        "failed": True,
    }
    state, meaning = space_guard.row_text(result, False)
    assert (
        state == "warn" and "Btrfs usage unreadable" in meaning and "vacuum the journal" in meaning
    )
    assert space_guard.row_text({**result, "would": [], "failed": False}, False)[0] == "ok"
    tier = {"filesystems": [{"path": "/", "free_gib": 9.0}], "would": [], "failed": True}
    assert space_guard.row_text(tier, False)[0] == "warn"


# item 2: one controller acting at a time


def acting_data(name, tmp_path):
    data = copy.deepcopy(DATA)
    data["acting"][name] = True
    data["jobs"]["space-guard"]["top_mounts"] = str(tmp_path / "tops")
    return data


def test_counterparts_are_data_and_cover_every_acting_job():
    table = DATA["counterparts"]
    assert set(table) == set(DATA["acting"])
    assert table["scrub"]["system"] == [
        "nightshift-btrfs-scrub-native.timer",
        "nightshift-btrfs-scrub-root.timer",
    ]
    assert table["memctl"]["user"] == ["nightshift-memctl.service"]
    assert "nightshift-space-guard.timer" in table["space_guard"]["system"]


def test_counterparts_running_asks_systemctl_for_enabled_and_active():
    run = nightshift_on("nightshift-btrfs-scrub-root.timer")
    found = core.counterparts_running(DATA, "scrub", run)
    assert found == ["nightshift-btrfs-scrub-root.timer (enabled, active)"]
    first = run.calls[0]
    assert first[:2] == ["systemctl", "--no-ask-password"] and "--user" not in first
    assert core.counterparts_running(DATA, "scrub", nightshift_on()) == []
    assert core.refusal(DATA, "scrub", nightshift_on()) is None


def test_the_user_service_is_asked_through_the_owners_manager_when_root(monkeypatch):
    monkeypatch.setattr(os, "geteuid", lambda: 0)
    run = nightshift_on("nightshift-memctl.service")
    assert core.counterparts_running(DATA, "memctl", run)
    assert run.calls[0] == [
        "systemctl",
        "--no-ask-password",
        "--user",
        "-M",
        "kasadis@",
        "is-enabled",
        "nightshift-memctl.service",
    ]
    monkeypatch.setattr(os, "geteuid", lambda: 1000)
    plain = nightshift_on("nightshift-memctl.service")
    core.counterparts_running(DATA, "memctl", plain)
    assert "-M" not in plain.calls[0] and "--user" in plain.calls[0]


def test_housekeeping_refuses_while_nightshifts_timer_runs(tmp_path, monkeypatch):
    fake = nightshift_on("nightshift-housekeeping.timer")
    monkeypatch.setattr(core, "run_command", fake)
    rows = []
    code = housekeeping.main(
        argparse.Namespace(no_post=False), acting_data("housekeeping", tmp_path), rows.append
    )
    assert code == 0 and rows[0]["state"] == "warn" and rows[0]["id"].endswith("/job-housekeeping")
    assert (
        "nightshift-housekeeping.timer" in rows[0]["meaning"]
        and "did nothing" in rows[0]["meaning"]
    )
    assert all(call[0] == "systemctl" for call in fake.calls)  # nothing else ran


def test_housekeeping_acts_once_nightshifts_timer_is_off(tmp_path, monkeypatch):
    fake = Fake(
        (["snap", "list"], Result(0, "Name Version Rev Tracking Publisher Notes\n")),
        (["pgrep"], Result(1)),
    )
    monkeypatch.setattr(core, "run_command", fake)
    data = acting_data("housekeeping", tmp_path)
    data["jobs"]["housekeeping"].update(
        spotify_cache=str(tmp_path / "s"), guestfs_dir=str(tmp_path / "g"), versioned=[]
    )
    rows = []
    housekeeping.main(argparse.Namespace(no_post=False), data, rows.append)
    assert ["apt-get", "clean"] in fake.calls and "Nightshift" not in rows[0]["meaning"]


def test_space_guard_refuses_while_nightshifts_timer_runs(tmp_path, monkeypatch):
    fake = nightshift_on("nightshift-space-guard.timer")
    monkeypatch.setattr(core, "run_command", fake)
    rows = []
    code = space_guard.main(
        argparse.Namespace(no_post=False), acting_data("space_guard", tmp_path), rows.append
    )
    assert (
        code == 0
        and rows[0]["state"] == "warn"
        and "nightshift-space-guard.timer" in rows[0]["meaning"]
    )
    assert all(call[0] == "systemctl" for call in fake.calls)
    assert not (acts.job_dir() / "space-guard.json").exists()


def test_scrub_refuses_while_either_nightshift_timer_runs(tmp_path, monkeypatch):
    fake = nightshift_on("nightshift-btrfs-scrub-native.timer")
    monkeypatch.setattr(core, "run_command", fake)
    data = acting_data("scrub", tmp_path)
    data["jobs"]["scrub"]["lock"] = str(tmp_path / "lock")
    rows = []
    code = scrub.main(argparse.Namespace(target="root", no_post=False), data, rows.append)
    assert code == 1 and rows[0]["state"] == "warn" and "scrub-native.timer" in rows[0]["meaning"]
    assert all(call[0] == "systemctl" for call in fake.calls)  # no scrub started


def test_nvme_tests_refuse_while_nightshifts_timers_run(tmp_path, monkeypatch):
    fake = nightshift_on("nightshift-nvme-long-test.timer")
    monkeypatch.setattr(core, "run_command", fake)
    rows = []
    code = nvme_test.main(
        argparse.Namespace(kind="short", no_post=False),
        acting_data("nvme_tests", tmp_path),
        rows.append,
    )
    assert code == 1 and rows[0]["state"] == "warn" and "nvme-long-test.timer" in rows[0]["meaning"]
    assert not any("-t" in call for call in fake.calls)


def test_a_dry_job_never_asks_systemctl(tmp_path, monkeypatch):
    fake = Fake((["smartctl", "-l"], Result(0, "")), (["smartctl", "-A"], Result(0, "")))
    monkeypatch.setattr(core, "run_command", fake)
    rows = []
    nvme_test.main(
        argparse.Namespace(kind="short", no_post=False), copy.deepcopy(DATA), rows.append
    )
    assert rows[0]["state"] == "ok" and not any(call[0] == "systemctl" for call in fake.calls)


def test_memctl_stands_down_to_a_dry_run_with_a_warn_row(tmp_path, monkeypatch):
    built = []
    monkeypatch.setattr(core, "run_command", nightshift_on("nightshift-memctl.service"))
    monkeypatch.setattr(os, "geteuid", lambda: 1000)
    ctl = _controller(tmp_path)

    def fake_build(data, acting, uid, home, runtime):
        built.append(acting)
        return ctl

    data = copy.deepcopy(DATA)
    data["acting"]["memctl"] = True
    monkeypatch.setattr(memctl, "build", fake_build)
    rows = []
    code = memctl.main(argparse.Namespace(once=True, preview=False), data, rows.append)
    assert code == 0 and built == [False]
    assert rows[0]["state"] == "warn" and "nightshift-memctl.service" in rows[0]["meaning"]
    assert "Meanwhile a dry run" in rows[0]["meaning"]


def _controller(tmp_path):
    from test_host_steward_memory import Host

    return Host(tmp_path).controller(now=0)


def test_memctl_restarts_to_follow_nightshifts_memctl_going_away(tmp_path, monkeypatch):
    """Refused at start; Nightshift's memctl is gone by the first row: the loop ends so the unit restarts it live."""
    on = {"yes": True}
    monkeypatch.setattr(
        core,
        "refusal",
        lambda data, name, run=None: "Nightshift's memctl is on." if on["yes"] else None,
    )
    ctl = _controller(tmp_path)
    monkeypatch.setattr(memctl, "build", lambda *a: ctl)
    data = copy.deepcopy(DATA)
    data["acting"]["memctl"] = True
    posted = []

    def post(row):
        posted.append(row)
        on["yes"] = False

    code = memctl.main(argparse.Namespace(once=False, preview=False), data, post)
    assert code == 0 and len(posted) == 1 and posted[0]["state"] == "warn"


# item 4 and 5: ECC


def test_an_unreadable_pve_journal_warns_instead_of_posting_ok():
    cfg = DATA["checks"]["ecc"]
    empty = ecc.evaluate({"ecc": "", "rasmce": ""}, cfg, NOW, {})
    got = {s.code: s.state for s in empty}
    assert got["ecc.unreadable"] == "warn" and "ecc.uncorrected" not in got
    err = ecc.evaluate(
        {"ecc": "ERR Failed to open journal: Permission denied", "rasmce": ""}, cfg, NOW, {}
    )
    assert (
        next(s for s in err if s.code == "ecc.unreadable").fields["why"]
        == "Failed to open journal: Permission denied"
    )
    fine = ecc.evaluate({"ecc": f"FIRST {NOW - 8 * DAY}\n", "rasmce": ""}, cfg, NOW, {})
    assert {s.code: s.state for s in fine}["ecc.uncorrected"] == "ok"


def test_an_uncorrected_error_still_fails_when_only_rasdaemon_could_be_read():
    ras = f"1 {core.iso_time(NOW - 3600)[:19].replace('T', ' ')} +0000 error: Uncorrected error, addr=0x1000 Unified Memory Controller"
    out = ecc.evaluate({"ecc": "", "rasmce": ras}, DATA["checks"]["ecc"], NOW, {})
    assert {s.code: s.state for s in out}["ecc.uncorrected"] == "failed"


def test_the_snippet_passes_journalctls_errors_on():
    from host_steward.checks import pve

    ecc_part = pve.SCRIPT.split('echo "===NS ecc"')[1].split('echo "===NS rasdaemon"')[0]
    assert "2>/dev/null" not in ecc_part.split("awk")[0] and 'print "ERR"' in ecc_part


def journal_event(kind, ts):
    return {"src": "j", "ts": ts, "kind": kind, "over": False, "region": None}


def test_the_days_count_is_the_larger_of_journal_and_rasdaemon():
    ts = NOW - 3600
    events = [journal_event("CE", ts)] + [
        {"src": "r", "ts": ts - 1000 * i, "kind": "CE", "over": False, "region": None}
        for i in range(3)
    ]
    assert ecc.daily_counts(events, NOW)[history.day_of(ts)]["ce"] == 3
    assert ecc.daily_counts(events[:1], NOW)[history.day_of(ts)]["ce"] == 1


def test_a_day_never_goes_down_in_the_memory_history(tmp_path):
    store = history.Store(tmp_path / "h.sqlite3")
    cache = {"history": store}
    first = NOW - 8 * DAY
    many = [journal_event("CE", NOW - 3600 - i * 600) for i in range(5)]
    ecc.record_history(cache, many, first, NOW)
    day = history.day_of(NOW)
    assert store.day_value("mem.ce", "pve", day) == 5
    ecc.record_history(cache, many[:2], first, NOW)  # the journal window moved on: fewer events
    assert store.day_value("mem.ce", "pve", day) == 5
    store.close()


# item 6: unreadable inputs warn


def test_unreadable_pressure_inputs_warn(tmp_path):
    cfg = {**DATA["checks"]["workstation"], "psi_memory": str(tmp_path / "missing")}
    sig = workstation.pressure(core.Ctx(cfg=cfg, site=DATA["site"], now=NOW))
    assert (sig.code, sig.state) == ("ws.memory.pressure.unreadable", "warn")
    text = core.explain(sig.code, sig.fields, DATA["meanings"], True, sig.state)
    assert "Could not read memory pressure" in text
    mem = {**DATA["checks"]["memory"], "psi_memory": str(tmp_path / "missing")}
    assert memory.stall(core.Ctx(cfg=mem, site=DATA["site"], now=NOW)).state == "warn"
    assert "Could not read memory stalls" in core.explain(
        "memory.stall.unreadable", {}, DATA["meanings"], True, "warn"
    )


def nvidia_signal(tmp_path, dpkg):
    run = Fake(
        (["dpkg-query"], dpkg),
        (["uname"], Result(0, "6.17.0-30-generic\n")),
        (["ps"], Result(0, "")),
    )
    cfg = {**DATA["checks"]["probes"], "modules_root": str(tmp_path / "m"), "fallbacks_file": ""}
    return probes.nvidia(core.Ctx(cfg=cfg, site=DATA["site"], now=NOW, run=run))


def test_a_failed_dpkg_query_is_not_read_as_no_nvidia_driver(tmp_path):
    for broken in (
        Result(127, "", "not found"),
        Result(2, "", "dpkg-query: error: cannot open status"),
        Result(124, "", "timed out"),
    ):
        sig = nvidia_signal(tmp_path, broken)
        assert (sig.code, sig.state) == ("probes.nvidia.unreadable", "warn"), broken
    assert "Could not list" in core.explain(
        "probes.nvidia.unreadable", {"why": "x"}, DATA["meanings"], True, "warn"
    )


def test_dpkg_query_finding_no_nvidia_packages_is_an_answer(tmp_path):
    none = Result(
        1,
        "linux-image-6.17.0-30-generic ii \n",
        "dpkg-query: no packages found matching nvidia-driver-*\n",
    )
    sig = nvidia_signal(tmp_path, none)
    assert (sig.code, sig.state) == ("probes.nvidia", "ok") and sig.fields["detail"].startswith(
        "No NVIDIA"
    )


# item 7 and 8: the sudo filter and the run actions


def test_the_sudo_check_counts_classic_sudo_too():
    assert "/usr/bin/sudo.ws" in DATA["checks"]["sudo"]["sudo_exes"]
    assert "/usr/lib/cargo/bin/sudo" in DATA["checks"]["sudo"]["sudo_exes"]


def allowed_units():
    text = (HERE / "sudoers" / "60-host-steward").read_text().replace("\\\n", " ")
    return set(re.findall(r"/usr/bin/systemctl start (host-steward-[\w-]+\.service)", text))


def run_refs(rows):
    return [a["ref"] for row in rows for a in row["actions"] if a["kind"] == "run"]


def test_every_run_action_is_a_sudo_start_the_sudoers_file_allows(tmp_path, monkeypatch):
    check = core.make_row(
        "ecc",
        [core.Signal("ecc.uncorrected", "ok")],
        DATA["checks"]["ecc"],
        DATA["meanings"],
        "box",
        NOW,
        DATA["caps"],
    )
    from host_steward.jobs import collect_usage

    rows = [check, collect_usage.build_row(DATA, NOW, {"counts": {"a": 1}, "acct_ok": True})]
    monkeypatch.setattr(
        core, "run_command", Fake((["smartctl"], Result(0, "")), (["pgrep"], Result(1)))
    )
    data = copy.deepcopy(DATA)
    data["jobs"]["housekeeping"].update(
        spotify_cache=str(tmp_path / "s"), guestfs_dir=str(tmp_path / "g"), versioned=[]
    )
    data["jobs"]["space-guard"].update(top_mounts=str(tmp_path / "tops"), grow_roots=[], disks=[])
    for job, args in (
        (housekeeping, argparse.Namespace(no_post=False)),
        (space_guard, argparse.Namespace(no_post=False)),
        (scrub, argparse.Namespace(target="root", no_post=False)),
        (nvme_test, argparse.Namespace(kind="short", no_post=False)),
    ):
        job.main(args, data, rows.append)
    refs = run_refs(rows)
    assert refs, "the check and the guard each offer a run action"
    for ref in refs:
        unit = re.fullmatch(r"sudo -n systemctl start (host-steward-[\w-]+\.service)", ref)
        assert unit and unit.group(1) in allowed_units(), ref
    assert "sudo -n systemctl start host-steward-check.service" in refs
    assert "sudo -n systemctl start host-steward-space-guard.service" in refs
    assert "sudo -n systemctl start host-steward-collect-usage.service" in refs
    assert not any("--only" in ref for ref in refs)


def test_the_units_the_sudoers_file_names_exist():
    for unit in allowed_units():
        assert (HERE / "systemd" / unit).exists(), unit
