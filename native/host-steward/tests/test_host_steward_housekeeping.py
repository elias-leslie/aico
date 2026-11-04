"""Housekeeping, space guard, scrub and NVMe self-test jobs, and the disk-tests check: fixture inputs, no root.

The point of the dry-run tests: with the switch off a job lists what it would do and runs no command that
changes anything (only the read-only looks), and with it on the same code issues the changes.
"""

from __future__ import annotations

import argparse
import json
import os

import pytest

from host_steward import acts, core, versioned
from host_steward.checks import disk_tests
from host_steward.jobs import housekeeping, nvme_test, scrub, space_guard

DATA = core.load_data()
NOW = 1_800_000_000.0
GIB = 1024**3
Result = core.Result

# Commands that look but change nothing. Anything else a dry run issues is a bug.
READ_ONLY = (
    ["findmnt"],
    ["btrfs", "filesystem", "usage"],
    ["btrfs", "filesystem", "show"],
    ["btrfs", "balance", "status"],
    ["btrfs", "scrub", "status"],
    ["smartctl", "-l"],
    ["smartctl", "-A"],
    ["pgrep"],
    ["snap", "list"],
    ["du"],
    ["ionice"],
)


class Fake:
    """Command runner: the first rule whose words are all in argv answers; anything else is 'not found'."""

    def __init__(self, *rules):
        self.rules = rules
        self.calls = []

    def __call__(self, argv, timeout=60, input_text=None):
        self.calls.append(list(argv))
        for words, result in self.rules:
            if all(word in argv for word in words):
                return result
        return Result(127, "", "not found")

    def changes(self):
        return [
            c for c in self.calls if not any(c[: len(prefix)] == prefix for prefix in READ_ONLY)
        ]


def usage(unallocated_gib=50, free_gib=100, missing=0):
    return (
        f"    Device size: {500 * GIB}\n    Device unallocated: {int(unallocated_gib * GIB)}\n"
        f"    Device missing: {missing}\n    Free (estimated): {int(free_gib * GIB)}\n"
    )


BTRFS_OK = [
    (["findmnt", "-n"], Result(0, "/dev/nvme0n1p2[/@]\n")),
    (
        ["findmnt", "--json"],
        Result(0, json.dumps({"filesystems": [{"fstype": "btrfs", "options": "rw,noatime"}]})),
    ),
    (["btrfs", "filesystem", "show"], Result(0, "Label: root  Total devices 1 FS bytes used 1GiB")),
    (["btrfs", "balance", "status"], Result(0, "No balance found on '/'")),
]


@pytest.fixture(autouse=True)
def state_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(core, "STATE_PATH", tmp_path / "state" / "state.json")


def guard_cfg(tmp_path, **over):
    cfg = {
        **DATA["jobs"]["space-guard"],
        "top_mounts": str(tmp_path / "tops"),
        "grow_roots": [],
        **over,
    }
    return cfg


def env_for(tmp_path, run, live=False, free_gib=100.0, **over):
    free = {"/": free_gib}
    return space_guard.Env(
        guard_cfg(tmp_path, **over),
        DATA["checks"]["storage"],
        acts.Actor(live, run=run),
        "kasadis",
        NOW,
        free=lambda path: int(free[path] * GIB),
    )


# the actor


def test_actor_dry_run_runs_nothing_and_says_what():
    fake = Fake()
    actor = acts.Actor(False, run=fake)
    assert actor.do(["rm", "-rf", "/x"], "remove x") is None
    assert actor.apply("delete y", lambda: pytest.fail("ran")) == (False, None)
    assert actor.do(["btrfs", "filesystem", "sync", "/"], quiet=True) is None
    assert fake.calls == [] and actor.would == ["remove x", "delete y"]


def test_actor_live_runs_the_command():
    fake = Fake((["echo"], Result(0, "hi")))
    actor = acts.Actor(True, run=fake)
    done = actor.do(["echo", "a"])
    assert done is not None and done.out == "hi"
    assert actor.apply("make", lambda: 5) == (True, 5)
    assert fake.calls == [["echo", "a"]] and actor.would == []


def test_switches_start_off():
    assert not any(DATA["acting"].values())
    assert set(DATA["acting"]) >= {"housekeeping", "space_guard", "scrub", "nvme_tests"}


# housekeeping


def hk_cfg(tmp_path, **over):
    return {
        **DATA["jobs"]["housekeeping"],
        "spotify_cache": str(tmp_path / "spotify"),
        "guestfs_dir": str(tmp_path / "gfs"),
        "versioned": [
            {
                "name": "Playwright browsers",
                "root": str(tmp_path / "pw"),
                "group": "stem",
                "order": "version",
                "prune": True,
            }
        ],
        **over,
    }


def make_housekeeping_tree(tmp_path):
    spotify = tmp_path / "spotify" / "Data"
    spotify.mkdir(parents=True)
    (spotify / "blob").write_bytes(b"x" * 4096)
    gfs = tmp_path / "gfs"
    gfs.mkdir()
    os.utime(gfs, (NOW - 9 * 86400, NOW - 9 * 86400))
    for n in (1, 2, 3, 4):
        (tmp_path / "pw" / f"chromium-{n}").mkdir(parents=True)
        os.utime(tmp_path / "pw" / f"chromium-{n}", (NOW - 100 + n, NOW - 100 + n))


HK_RULES = [
    (
        ["snap", "list"],
        Result(0, "Name Version Rev Tracking Publisher Notes\nfoo 1 5 latest x disabled\n"),
    ),
    (["pgrep"], Result(1)),
    (["snap", "remove"], Result(0)),
    (["runuser"], Result(0, json.dumps({"items_deleted": 3, "bytes_reclaimed": 2 * GIB}))),
]


def test_housekeeping_dry_run_lists_the_work_and_changes_nothing(tmp_path, monkeypatch):
    make_housekeeping_tree(tmp_path)
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/" + name)
    monkeypatch.setattr(versioned, "in_use_paths", list)
    fake = Fake(*HK_RULES)
    cfg = hk_cfg(tmp_path, spotify_min_gib=0.000001)
    result = housekeeping.maintain(cfg, "kasadis", acts.Actor(False, run=fake), NOW, str(tmp_path))
    assert fake.changes() == [c for c in fake.calls if c[0] == "pgrep"] or all(
        c[0] in ("pgrep", "snap") and c[:2] != ["snap", "remove"] for c in fake.calls
    )
    assert not any(
        c[0] in ("journalctl", "apt-get", "runuser") or c[:2] == ["snap", "remove"]
        for c in fake.calls
    )
    would = " | ".join(result["would"])
    for expected in (
        "vacuum the journal to 2G",
        "clear the apt cache",
        "foo r5",
        "Spotify cache",
        "libguestfs",
        "chromium-1",
        "chromium-2",
        "st cleanup host",
    ):
        assert expected in would
    assert "chromium-3" not in would and "chromium-4" not in would  # the newest two stay
    assert (tmp_path / "spotify" / "Data" / "blob").exists() and (tmp_path / "gfs").exists()
    assert all((tmp_path / "pw" / f"chromium-{n}").exists() for n in (1, 2, 3, 4))
    assert result["actions"] == []


def test_housekeeping_live_does_the_same_work(tmp_path, monkeypatch):
    make_housekeeping_tree(tmp_path)
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/" + name)
    monkeypatch.setattr(versioned, "in_use_paths", list)
    fake = Fake(*HK_RULES)
    result = housekeeping.maintain(
        hk_cfg(tmp_path, spotify_min_gib=0.000001),
        "kasadis",
        acts.Actor(True, run=fake),
        NOW,
        str(tmp_path),
    )
    assert ["journalctl", "--vacuum-size=2G"] in fake.calls and ["apt-get", "clean"] in fake.calls
    assert ["snap", "remove", "foo", "--revision=5"] in fake.calls
    assert any(c[0] == "runuser" and "cleanup" in c for c in fake.calls)
    assert not (tmp_path / "gfs").exists() and not (tmp_path / "spotify" / "Data").exists()
    assert [p.name for p in sorted((tmp_path / "pw").iterdir())] == ["chromium-3", "chromium-4"]
    text = " ".join(result["actions"])
    assert "Snap revision foo r5" in text and "removed 3 item(s)" in text
    assert "failed" not in result


def test_housekeeping_missing_summitflow_command_fails_the_run(tmp_path):
    fake = Fake((["runuser"], Result(2, "", "No such command 'cleanup'")))
    cfg = hk_cfg(tmp_path)
    result = housekeeping.maintain(cfg, "kasadis", acts.Actor(True, run=fake), NOW, str(tmp_path))
    assert result["failed"] and "missing from this SummitFlow" in " ".join(result["actions"])
    assert housekeeping.row_text(result, True)[0] == "warn"


def test_housekeeping_rows():
    assert housekeeping.row_text({"actions": [], "would": ["a", "b"]}, False) == (
        "ok",
        "Dry run: would a; b. Nightshift still does this until cutover.",
    )
    assert housekeeping.row_text({"actions": [], "would": []}, True) == (
        "ok",
        "Nothing needed cleaning.",
    )


def test_versioned_plan_keeps_newest_and_protected():
    kept, excess = versioned.plan_family(
        [("c-9", 1), ("c-10", 2), ("c-8", 3)], 2, "version", {"c-8"}
    )
    assert kept == ["c-10", "c-9", "c-8"] or set(kept) == {"c-10", "c-9", "c-8"}
    assert excess == []
    kept, excess = versioned.plan_family([("c-9", 1), ("c-10", 2), ("c-8", 3)], 2, "version", set())
    assert kept == ["c-10", "c-9"] and excess == ["c-8"]


# space guard


def test_lines_from_the_storage_table():
    lines = space_guard.lines_from(DATA["checks"]["storage"])
    assert (lines.reserve, lines.warn, lines.crit, lines.floor) == (25.0, 40.0, 30.0, 10.0)
    assert lines.pressured(29.9) and lines.pressured(10.0) and not lines.pressured(30.0)


def test_reclaim_commands_filter_by_disk():
    cfg = DATA["jobs"]["space-guard"]
    root = space_guard.reclaim_commands(cfg, "/", 30)
    assert root == [["st", "cleanup", "reclaim", "--filesystem", "/", "--target-free-gib", "30"]]
    work = space_guard.reclaim_commands(cfg, "/srv/workspaces", 30)
    assert work[-1] == ["st", "autosnap", "prune", "--pressure"]


def run_guard(tmp_path, fake, live=False, prev=None, **kw):
    env = env_for(tmp_path, fake, live=live, **kw)
    return env, space_guard.space_guard(
        env,
        prev
        if prev is not None
        else {"ballast": {"/": 6 * GIB}, "ballast_checked": {"/": NOW - 60}},
    )


def test_space_guard_quiet_disk_does_nothing(tmp_path):
    fake = Fake(*BTRFS_OK, (["btrfs", "filesystem", "usage"], Result(0, usage())))
    _env, result = run_guard(tmp_path, fake)
    assert result["would"] == [] and result["actions"] == [] and not result["failed"]
    assert fake.changes() == []
    assert space_guard.row_text(result, False) == ("ok", "Dry run: nothing to do (/ 100 GiB free).")


def test_space_guard_dry_run_under_pressure_lists_the_ladder_and_changes_nothing(tmp_path):
    fake = Fake(
        *BTRFS_OK,
        (["btrfs", "filesystem", "usage"], Result(0, usage(unallocated_gib=3, free_gib=20))),
    )
    _env, result = run_guard(tmp_path, fake, free_gib=20)
    assert fake.changes() == []  # no mount, no sync, no balance, no runuser, no vacuum
    would = result["would"]
    assert would[0].startswith("release the 6.0 GiB ballast")
    assert any("st cleanup reclaim --filesystem / --target-free-gib 30" in w for w in would)
    assert "vacuum the journal to 1G" in would
    assert any(w.startswith("balance data chunks on / (usage 0%") for w in would)
    assert result["filesystems"][0]["pressured"] and result["filesystems"][0]["ladder"][
        "tiers"
    ] == ["ballast", "summitflow", "journal"]
    state, text = space_guard.row_text(result, False)
    assert state == "ok"
    assert (
        text.startswith(
            "Dry run: / is under the free-space line; would release the 6.0 GiB ballast"
        )
        and "would release the 6.0 GiB ballast" in text
    )


def test_space_guard_live_runs_reclaim_balance_and_journal(tmp_path):
    fake = Fake(
        *BTRFS_OK,
        (["btrfs", "filesystem", "usage"], Result(0, usage(unallocated_gib=3, free_gib=20))),
        (["runuser"], Result(0, "")),
        (["journalctl"], Result(0, "", "Vacuuming done, freed 100.0M of archived journals")),
        (["btrfs", "balance", "start"], Result(0)),
    )
    env = env_for(tmp_path, fake, live=True, free_gib=20.0)
    # no device for the ballast tier (the mount of the top level needs root): journal needs the log disk, so pretend it is the same
    env.cfg["ballast_gib"] = 0
    result = space_guard.space_guard(env, {})
    calls = fake.calls
    assert any(c[0] == "runuser" and "reclaim" in c for c in calls)
    assert any(c[:3] == ["btrfs", "balance", "start"] and "-dusage=0,limit=16" in c for c in calls)
    assert any(c[0] == "journalctl" for c in calls)
    assert result["would"] == []


def test_guard_balance_deferred_when_one_is_active(tmp_path):
    fake = Fake(
        (["btrfs", "balance", "status"], Result(0, "Balance on '/' is running")),
        *BTRFS_OK[:3],
        (["btrfs", "filesystem", "usage"], Result(0, usage(unallocated_gib=3))),
    )
    env = env_for(tmp_path, fake)
    report = space_guard.guard(env, "/", 8 * GIB, 12 * GIB)
    assert report["deferred"] and report["passes"] == []


def test_guard_refuses_a_missing_device_and_a_read_only_mount(tmp_path):
    fake = Fake((["btrfs", "filesystem", "usage"], Result(0, usage(missing=1))))
    with pytest.raises(RuntimeError, match="missing"):
        space_guard.guard(env_for(tmp_path, fake), "/", 8 * GIB, 12 * GIB)
    fake = Fake(
        (
            ["findmnt", "--json"],
            Result(0, json.dumps({"filesystems": [{"fstype": "btrfs", "options": "ro"}]})),
        ),
        (["btrfs", "filesystem", "usage"], Result(0, usage(unallocated_gib=3))),
    )
    with pytest.raises(RuntimeError, match="read-only"):
        space_guard.guard(env_for(tmp_path, fake), "/", 8 * GIB, 12 * GIB)


def test_live_guard_stops_on_a_failed_pass_and_cancels_a_timeout(tmp_path):
    fake = Fake(
        *BTRFS_OK,
        (["btrfs", "filesystem", "usage"], Result(0, usage(unallocated_gib=3, free_gib=100))),
        (["btrfs", "balance", "start"], Result(124)),
        (["btrfs", "balance", "cancel"], Result(0)),
    )
    report = space_guard.guard(env_for(tmp_path, fake, live=True), "/", 8 * GIB, 12 * GIB)
    assert report["warning"].startswith("bounded balance timed out")
    assert ["btrfs", "balance", "cancel", "/"] in fake.calls


def test_dry_ballast_check_and_create(tmp_path):
    fake = Fake(
        (["btrfs", "filesystem", "usage"], Result(0, usage(unallocated_gib=50, free_gib=200)))
    )
    env = env_for(tmp_path, fake, free_gib=200.0)
    lines = space_guard.lines_from(DATA["checks"]["storage"])
    disk = {
        "path": "/",
        "name": "System disk",
        "label": "root",
        "device": "/dev/x",
        "ballast": 0,
        "checked": 0.0,
        "released": False,
    }
    assert space_guard.keep_ballast(env, disk, 6 * GIB, lines, 8 * GIB) is None
    assert env.actor.would == ["create the 6.0 GiB ballast on System disk"]
    assert fake.changes() == []
    stale = {**disk, "ballast": 6 * GIB, "checked": NOW - 2 * 86400}
    env.actor.would.clear()
    space_guard.keep_ballast(env, stale, 6 * GIB, lines, 8 * GIB)
    assert env.actor.would == [
        "re-check the ballast on System disk (mounts the top level for a moment)"
    ]
    fresh = {**disk, "ballast": 6 * GIB, "checked": NOW - 60}
    env.actor.would.clear()
    assert (
        space_guard.keep_ballast(env, fresh, 6 * GIB, lines, 8 * GIB) is None
        and env.actor.would == []
    )


def test_measure_children_and_growers(tmp_path):
    root = tmp_path / "root"
    (root / "a").mkdir(parents=True)
    (root / "b").mkdir()
    out = f"{3 * GIB}\t{root}/a\n{10}\t{root}/b\n"
    fake = Fake((["du"], Result(0, out)))
    env = env_for(tmp_path, fake, grow_roots=[str(root)])
    sizes = space_guard.measure_children(env, root)
    assert sizes == {f"{root}/a": 3 * GIB, f"{root}/b": 10}
    fake.rules = (*BTRFS_OK, (["du"], Result(0, out)))
    path = tmp_path / "growers.json"
    space_guard.refresh_growers(env, set(), path)
    saved = json.loads(path.read_text())
    assert saved["filesystems"]["/"]["top"][0]["path"] == f"{root}/a"
    assert [c for c in fake.calls if "du" in c]


def test_space_guard_job_posts_a_dry_run_row_and_keeps_the_ballast_record(tmp_path, monkeypatch):
    monkeypatch.setattr(
        space_guard,
        "load_previous",
        lambda cfg, live: {"ballast": {"/": 6 * GIB}, "ballast_checked": {"/": NOW}},
    )
    fake = Fake(*BTRFS_OK, (["btrfs", "filesystem", "usage"], Result(0, usage())))
    monkeypatch.setattr(core, "run_command", fake)
    data = {**DATA, "jobs": {**DATA["jobs"], "space-guard": guard_cfg(tmp_path)}}
    rows = []
    code = space_guard.main(argparse.Namespace(no_post=False), data, rows.append)
    assert (
        code == 0
        and rows[0]["id"].endswith("/job-space-guard")
        and rows[0]["meaning"].startswith("Dry run:")
    )
    saved = json.loads((acts.job_dir() / "space-guard.json").read_text())
    assert saved["ballast"] == {"/": 6 * GIB} and saved["live"] is False


# scrub and NVMe self-test


SCRUB_OUT = (
    "UUID: 1\nScrub started:    Sun Nov  1 08:04:44 2026\nStatus:           finished\nDuration:         0:01:27\n"
    "Error summary:    no errors found\n"
)
NVME_LOG = (
    "Self-test Log (NVMe Log 0x06, NSID 0xffffffff)\nSelf-test status: No self-test in progress\n"
    "Num  Test_Description  Status                       Power_on_Hours  Failing_LBA  NSID Seg SCT Code\n"
    " 0   Short             Completed without error                9187            -     -   -   -    -\n"
    " 1   Extended          Completed without error                8520            -     -   -   -    -\n"
)


def test_parse_scrub_and_state():
    info = disk_tests.parse_scrub(SCRUB_OUT)
    assert info["status"] == "finished" and disk_tests.short_date(info["started"]) == "Nov 1"
    assert disk_tests.scrub_state(info) == "ok"
    assert disk_tests.scrub_state({**info, "errors": "read=0 csum=3"}) == "failed"
    assert disk_tests.scrub_state({**info, "status": "aborted"}) == "warn"


def test_latest_selftest_nvme_and_ata():
    latest = disk_tests.latest_selftest(NVME_LOG)
    assert latest == {
        "kind": "Short",
        "status": "Completed without error",
        "hours": "9187",
        "failed": "",
    }
    ata = "# 1  Short offline       Completed: read failure       10%     12345         123\n"
    parsed = disk_tests.latest_selftest(ata)
    assert parsed is not None
    assert (
        parsed["kind"] == "Short offline"
        and parsed["failed"] == "yes"
        and parsed["hours"] == "12345"
    )
    assert (
        disk_tests.ago_text("9187", "9,190") == "3 h ago"
        and disk_tests.ago_text("1", None) == "at an unknown time"
    )


def disk_tests_ctx(run, acting=None):
    return core.Ctx(
        cfg=DATA["checks"]["disk-tests"],
        site=DATA["site"],
        now=NOW,
        run=run,
        acting=acting or {"scrub": False, "nvme_tests": False},
    )


def test_disk_tests_check_reports_last_results_and_dry_run():
    fake = Fake(
        (["btrfs", "scrub", "status"], Result(0, SCRUB_OUT)),
        (["smartctl", "-l"], Result(0, NVME_LOG)),
        (["smartctl", "-A"], Result(0, "Power On Hours:                     9,190\n")),
    )
    signals = disk_tests.run(disk_tests_ctx(fake))
    states = {s.code: s.state for s in signals}
    assert set(states.values()) == {"ok"} and "disk_tests.dry_run" in states
    row = core.make_row(
        "disk-tests",
        signals,
        DATA["checks"]["disk-tests"],
        DATA["meanings"],
        "m",
        NOW,
        DATA["caps"],
    )
    assert (
        row["state"] == "ok"
        and "Nov 1" in row["meaning"]
        and "Short, completed without error, 3 h ago" in row["meaning"]
    )


def test_disk_tests_schedule_follows_the_acting_flags():
    """Off: Nightshift's schedule (a note per kind still Nightshift's). On: host-steward's timers, and one that is not
    enabled warns."""
    timers = DATA["checks"]["disk-tests"]["timers"]
    enabled = Fake((["is-enabled"], Result(0, "enabled\n")))

    def schedule(run, **acting):
        return {s.code: s.state for s in disk_tests.schedule_signals(disk_tests_ctx(run, acting))}

    assert schedule(enabled) == {"disk_tests.dry_run": "ok"}
    assert schedule(enabled, scrub=True) == {"disk_tests.dry_run.nvme_tests": "ok"}
    assert schedule(enabled, nvme_tests=True) == {"disk_tests.dry_run.scrub": "ok"}
    assert schedule(enabled, scrub=True, nvme_tests=True) == {}
    checked = {c[-1] for c in enabled.calls}
    assert checked == {*timers["scrub"], *timers["nvme_tests"]}
    root_off = Fake(
        (["is-enabled", "host-steward-scrub-root.timer"], Result(1, "disabled\n")),
        (["is-enabled"], Result(0, "enabled\n")),
    )
    signals = disk_tests.schedule_signals(disk_tests_ctx(root_off, {"scrub": True, "nvme_tests": True}))
    assert [(s.code, s.state, s.fields["timers"]) for s in signals] == [
        ("disk_tests.timer_off", "warn", "host-steward-scrub-root.timer")
    ]
    text = core.explain(signals[0].code, signals[0].fields, DATA["meanings"], True, "warn")
    assert "sudo systemctl enable --now host-steward-scrub-root.timer" in text
    assert all(
        core.explain(code, {}, DATA["meanings"], False, "ok").startswith("Nightshift still runs")
        for code in ("disk_tests.dry_run", "disk_tests.dry_run.scrub", "disk_tests.dry_run.nvme_tests")
    )


def test_disk_tests_check_flags_scrub_errors_and_failed_selftest():
    bad_log = NVME_LOG.replace(
        "Completed without error                9187",
        "Completed: failed segment                9187",
    )
    fake = Fake(
        (
            ["btrfs", "scrub", "status"],
            Result(0, SCRUB_OUT.replace("no errors found", "read=1 csum=2")),
        ),
        (["smartctl", "-l"], Result(0, bad_log)),
    )
    states = {s.code: s.state for s in disk_tests.run(disk_tests_ctx(fake))}
    assert states["disk_tests.scrub"] == "failed" and states["disk_tests.selftest"] == "failed"
    unreadable = {s.code: s.state for s in disk_tests.run(disk_tests_ctx(Fake()))}
    assert (
        unreadable["disk_tests.scrub.unreadable"] == "warn"
        and unreadable["disk_tests.selftest.unreadable"] == "warn"
    )


def scrub_data(tmp_path, live=False):
    jobs = {
        **DATA["jobs"],
        "scrub": {**DATA["jobs"]["scrub"], "lock": str(tmp_path / "scrub.lock")},
    }
    return {**DATA, "jobs": jobs, "acting": {**DATA["acting"], "scrub": live}}


def test_scrub_dry_run_posts_a_row_and_starts_nothing(tmp_path, monkeypatch):
    fake = Fake((["btrfs", "scrub", "status"], Result(0, SCRUB_OUT)))
    monkeypatch.setattr(core, "run_command", fake)
    rows = []
    args = argparse.Namespace(target="native", no_post=False)
    actor_calls = fake.calls
    code = scrub.main(args, scrub_data(tmp_path), rows.append)
    assert code == 0 and rows[0]["id"].endswith("/job-scrub-native")
    assert rows[0]["meaning"].startswith(
        "Dry run: would scrub /mnt/summitflow-native; last scrub finished"
    )
    assert not any("start" in call for call in actor_calls)


def test_scrub_live_uses_the_wrapper_and_the_lock(tmp_path):
    cfg = scrub_data(tmp_path)["jobs"]["scrub"]
    fake = Fake(
        (["scrub", "start"], Result(0)), (["btrfs", "scrub", "status"], Result(0, SCRUB_OUT))
    )
    state, text, _detail = scrub.run_scrub(
        cfg, cfg["targets"]["native"], acts.Actor(True, run=fake)
    )
    assert state == "ok" and text.startswith("Scrubbed /mnt/summitflow-native")
    assert fake.calls[0] == [
        "/usr/local/sbin/summitflow-backup-window",
        "run",
        "native",
        "--",
        "/usr/bin/btrfs",
        "scrub",
        "start",
        "-Bd",
        "-c",
        "3",
        "/mnt/summitflow-native",
    ]
    state, text, _ = scrub.run_scrub(
        cfg,
        cfg["targets"]["root"],
        acts.Actor(
            True,
            run=Fake(
                (["scrub", "start"], Result(1)),
                (["btrfs", "scrub", "status"], Result(0, SCRUB_OUT)),
            ),
        ),
    )
    assert state == "warn" and "exit 1" in text


def test_scrub_unknown_target(tmp_path):
    assert (
        scrub.main(
            argparse.Namespace(target="nope", no_post=True), scrub_data(tmp_path), lambda r: True
        )
        == 2
    )


def test_nvme_test_dry_and_live(tmp_path, monkeypatch):
    fake = Fake(
        (["smartctl", "-l"], Result(0, NVME_LOG)),
        (["smartctl", "-A"], Result(0, "Power On Hours: 9,190\n")),
        (["-t"], Result(0)),
    )
    monkeypatch.setattr(core, "run_command", fake)
    rows = []
    data = {**DATA, "acting": {**DATA["acting"], "nvme_tests": False}}
    assert nvme_test.main(argparse.Namespace(kind="short", no_post=False), data, rows.append) == 0
    assert rows[0]["id"].endswith("/job-nvme-short-test") and rows[0]["meaning"].startswith(
        "Dry run: would start a short self-test on /dev/nvme0"
    )
    assert not any("-t" in c for c in fake.calls)
    fake.calls.clear()
    live = {**DATA, "acting": {**DATA["acting"], "nvme_tests": True}}
    rows.clear()
    assert nvme_test.main(argparse.Namespace(kind="long", no_post=False), live, rows.append) == 0
    assert ["/usr/sbin/smartctl", "-t", "long", "/dev/nvme0"] in fake.calls
    assert rows[0]["meaning"].startswith("Started a long self-test") and rows[0]["id"].endswith(
        "/job-nvme-long-test"
    )
    assert nvme_test.main(argparse.Namespace(kind="bogus", no_post=True), data, lambda r: True) == 2
