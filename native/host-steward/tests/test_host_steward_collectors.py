"""Usage evidence, run telemetry and the push-path check, on fixture inputs (no root, no network)."""

from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import UTC, datetime

from host_steward import core, telemetry, usage
from host_steward.checks import floor
from host_steward.checks import usage as usage_check
from host_steward.jobs import collect_usage

DATA = core.load_data()
NOW = 1_800_000_000.0
Result = core.Result


class Fake:
    def __init__(self, *rules):
        self.rules = rules

    def __call__(self, argv, timeout=60, input_text=None):
        for words, result in self.rules:
            if all(word in argv for word in words):
                return result
        return Result(127, "", "not found")


# usage


def test_lastcomm_keeps_the_latest_time_per_command_and_user(monkeypatch):
    import time

    monkeypatch.setenv("TZ", "UTC")  # lastcomm prints local times
    time.tzset()
    lines = [
        f"{'bash':<16}{'kasadis':<8} __ 0.00 secs Mon Nov  2 10:00",
        f"{'bash':<16}{'kasadis':<8} __ 0.00 secs Tue Nov  3 09:30",
        "garbage",
    ]
    got = usage.parse_lastcomm_lines(lines, datetime(2026, 11, 3, 12, 0, tzinfo=UTC))
    assert list(got) == [("bash", "kasadis")]
    assert got[("bash", "kasadis")] > datetime(2026, 11, 3, 0, 0, tzinfo=UTC).isoformat()
    monkeypatch.undo()
    time.tzset()


def test_exec_upsert_moves_last_seen_forward_only(tmp_path):
    db = usage.connect(tmp_path / "u.sqlite3")
    usage.upsert_execs(db, "proc", [("/bin/a", "root", "2026-11-03T10:00:00+00:00")])
    usage.upsert_execs(db, "proc", [("/bin/a", "root", "2026-11-02T10:00:00+00:00")])
    row = db.execute("SELECT first_seen, last_seen, samples FROM exec_seen").fetchone()
    assert row == ("2026-11-02T10:00:00+00:00", "2026-11-03T10:00:00+00:00", 2)


def test_unit_snapshot_upserts_units(tmp_path):
    db = usage.connect(tmp_path / "u.sqlite3")
    run = Fake(
        (
            ["list-units"],
            Result(0, "a.service loaded active running A\nb.mount loaded active mounted B\n"),
        ),
        (
            ["show"],
            Result(
                0,
                "Id=a.service\nActiveState=active\nActiveEnterTimestamp=@1799999000\n"
                "InactiveEnterTimestamp=@0\n\n",
            ),
        ),
    )
    assert usage.snapshot_units(db, "system", ["systemctl"], "2026-11-03T00:00:00+00:00", run) == 1
    row = db.execute(
        "SELECT unit, active_state, last_active_enter, last_inactive_enter FROM unit_seen"
    ).fetchone()
    assert row[:2] == ("a.service", "active") and row[2].startswith("2027-") and row[3] is None


def test_proc_sample_is_recorded(tmp_path):
    path = tmp_path / "u.sqlite3"
    assert usage.record_proc_sample(path, datetime.fromtimestamp(NOW, UTC)) > 0
    assert usage.last_collected(path) is None  # a sample is not a full collection


def usage_ctx(tmp_path, state=None, now=NOW):
    cfg = {**DATA["checks"]["usage"], "db": str(tmp_path / "u.sqlite3")}
    return core.Ctx(cfg=cfg, site=DATA["site"], now=now, state=state if state is not None else {})


def test_usage_check_waits_then_warns_when_no_collection_happens(tmp_path):
    state = {}
    first = usage_check.run(usage_ctx(tmp_path, state))
    assert [(s.code, s.state) for s in first] == [("usage.collect", "ok")]
    late = usage_check.run(usage_ctx(tmp_path, state, NOW + 40 * 3600))
    assert [(s.code, s.state) for s in late] == [("usage.collect_stale", "warn")]


def test_usage_check_ok_after_a_full_collection(tmp_path):
    path = tmp_path / "u.sqlite3"
    db = usage.connect(path)
    when = datetime.fromtimestamp(NOW - 3600, UTC).isoformat(timespec="seconds")
    db.execute("INSERT INTO runs VALUES(?,?,?)", (when, "units_system", 5))
    db.commit()
    db.close()
    state = {"watch_since": NOW - 100 * 3600}
    assert [s.state for s in usage_check.run(usage_ctx(tmp_path, state))] == ["ok"]


def job_data(tmp_path):
    data = json.loads(json.dumps(DATA, default=str))
    data["checks"]["usage"]["db"] = str(tmp_path / "u.sqlite3")
    data["checks"]["usage"]["pacct_files"] = []
    data["checks"]["usage"]["user_managers"] = ["nobody-here"]
    return data


def test_collect_usage_job_posts_a_warn_row_without_process_accounting(tmp_path, monkeypatch):
    monkeypatch.setattr(usage, "snapshot_units", lambda *a, **k: 3)
    posted = []
    code = collect_usage.main(
        argparse.Namespace(dry_run=False),
        job_data(tmp_path),
        lambda rows: posted.append(rows) or True,
    )
    row = posted[0][0]
    assert code == 0 and row["id"].endswith("/job-collect-usage") and row["kind"] == "job"
    assert row["state"] == "warn" and "acct" in row["meaning"]
    assert (
        sqlite3.connect(tmp_path / "u.sqlite3").execute("SELECT count(*) FROM runs").fetchone()[0]
        >= 3
    )


def test_collect_usage_job_failure_is_a_failed_row(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("x")

    monkeypatch.setattr(usage, "collect", boom)
    posted = []
    collect_usage.main(
        argparse.Namespace(dry_run=False),
        job_data(tmp_path),
        lambda rows: posted.append(rows) or True,
    )
    assert posted[0][0]["state"] == "failed"


# telemetry


def test_telemetry_records_a_run_and_its_steps(tmp_path):
    path = tmp_path / "t.sqlite3"
    with telemetry.run("check", path) as measured, measured.step("a", "note"):
        measured.detail["n"] = 1
    db = sqlite3.connect(path)
    assert db.execute("SELECT unit, status, detail FROM runs").fetchone() == (
        "check",
        "ok",
        '{"n": 1}',
    )
    assert db.execute("SELECT name, note FROM steps").fetchone() == ("a", "note")


def test_telemetry_stays_quiet_for_a_user_who_cannot_write_it(tmp_path, capsys):
    path = tmp_path / "t.sqlite3"
    sqlite3.connect(path).close()
    path.chmod(0o444)
    try:
        with telemetry.run("declare", path):
            pass
    finally:
        path.chmod(0o644)
    assert capsys.readouterr().out == ""
    assert path.stat().st_size == 0


def test_telemetry_marks_a_raising_run_as_error(tmp_path):
    path = tmp_path / "t.sqlite3"
    try:
        with telemetry.run("job", path):
            raise ValueError
    except ValueError:
        pass
    assert sqlite3.connect(path).execute("SELECT status FROM runs").fetchone() == ("error",)


def test_telemetry_never_fails_the_run_when_it_cannot_write(tmp_path, capsys):
    blocked = tmp_path / "file"
    blocked.write_text("x")
    with telemetry.run("check", blocked / "t.sqlite3"):
        pass
    assert "not recorded" in capsys.readouterr().out


def test_telemetry_prunes_old_rows(tmp_path):
    db = telemetry.connect(tmp_path / "t.sqlite3")
    db.execute(
        "INSERT INTO runs(unit,started_at,wall_s,cpu_s,status) VALUES('x','2020-01-01T00:00:00+00:00',1,1,'ok')"
    )
    db.execute(
        "INSERT INTO runs(unit,started_at,wall_s,cpu_s,status) VALUES('y',?,1,1,'ok')",
        (datetime.now(UTC).isoformat(),),
    )
    telemetry.prune(db, datetime.now(UTC))
    assert [r[0] for r in db.execute("SELECT unit FROM runs")] == ["y"]


# push path

UNITS = {
    "user": [
        "nightshift-notify-critical.service",
        "nightshift-notify-critical.path",
        "nightshift-notify-critical.timer",
    ],
    "system": ["nightshift-outbox.service", "nightshift-outbox.path", "nightshift-outbox.timer"],
}


def block(unit, **props):
    base = {
        "Id": unit,
        "LoadState": "loaded",
        "ActiveState": "active",
        "Result": "success",
        "ExecMainStatus": "0",
    }
    base.update(props)
    return "\n".join(f"{k}={v}" for k, v in base.items()) + "\n\n"


def systemd(user_over=None, system_over=None, user_ok=True):
    """A command runner answering `systemctl show` for the Nightshift path (and not-found for anything else)."""
    user_over, system_over = user_over or {}, system_over or {}

    def run(argv, timeout=60, input_text=None):
        names = argv[argv.index("--") + 1 :] if "--" in argv else []
        is_user = "--user" in argv
        if is_user and not user_ok:
            return Result(1, "", "no bus")
        out = ""
        for unit in names:
            if unit.startswith(("aico", "tether")):
                out += block(unit, LoadState="not-found", ActiveState="inactive")
            elif unit.endswith(".service") and unit == "nightshift-notify-critical.service":
                out += block(
                    unit,
                    ActiveState="inactive",
                    ExecMainExitTimestamp=f"@{int(NOW - 600)}",
                    **user_over.get(unit, {}),
                )
            elif is_user:
                out += block(unit, **user_over.get(unit, {}))
            else:
                out += block(unit, **system_over.get(unit, {}))
        return Result(0, out)

    return run


def floor_ctx(tmp_path, run, state=None, now=NOW, uptime=100_000):
    up = tmp_path / "uptime"
    up.write_text(f"{uptime} 1\n")
    cfg = {**DATA["checks"]["floor"], "uptime_file": str(up), "owner_uid": 1000}
    # Exercise the generic multi-path/stale-pass detector with explicit fixture units. The production
    # Nightshift route was retired at M5b; its removal must not erase this behavior coverage.
    cfg["paths"] = [{**p, "delivery_file": ""} for p in cfg["paths"]] + [{
        "name": "Nightshift",
        "user_units": ["nightshift-notify-critical.service", "nightshift-notify-critical.path", "nightshift-notify-critical.timer"],
        "system_units": ["nightshift-outbox.service", "nightshift-outbox.path", "nightshift-outbox.timer"],
        "heartbeat_unit": "nightshift-notify-critical.service", "delivery_file": "", "skip_when_absent": True,
    }]
    return core.Ctx(
        cfg=cfg, site=DATA["site"], now=now, run=run, state=state if state is not None else {}
    )


def codes(signals):
    return [(s.code, s.state) for s in signals]


def test_floor_ok_when_every_unit_is_up_and_the_scan_finished_recently(tmp_path):
    out = floor.run(floor_ctx(tmp_path, systemd()))
    assert codes(out) == [("floor.ok", "ok")]  # Aico's path is skipped (nothing of it installed)


def test_floor_skips_a_path_without_installed_units_and_warns_when_there_is_none(tmp_path):
    def nothing(argv, timeout=60, input_text=None):
        names = argv[argv.index("--") + 1 :]
        return Result(
            0, "".join(block(u, LoadState="not-found", ActiveState="inactive") for u in names)
        )

    assert codes(floor.run(floor_ctx(tmp_path, nothing))) == [("floor.none", "warn")]


def test_floor_failed_unit_is_watched_first_then_fails_after_confirm(tmp_path):
    run = systemd(
        system_over={
            "nightshift-outbox.service": {
                "ActiveState": "failed",
                "Result": "exit-code",
                "ExecMainStatus": "1",
            }
        }
    )
    state = {}
    first = floor.run(floor_ctx(tmp_path, run, state))
    assert (
        codes(first) == [("floor.watching", "ok")]
        and "nightshift-outbox.service failed" in first[0].fields["why"]
    )
    held = floor.run(floor_ctx(tmp_path, run, state, now=NOW + 11 * 60))
    assert (
        codes(held) == [("floor.down", "failed")] and "exit-code, status 1" in held[0].fields["why"]
    )


def test_floor_stopped_timer_and_masked_unit(tmp_path):
    run = systemd(
        user_over={
            "nightshift-notify-critical.timer": {"ActiveState": "inactive"},
            "nightshift-notify-critical.path": {"LoadState": "masked"},
        }
    )
    state = {}
    floor.run(floor_ctx(tmp_path, run, state))
    held = floor.run(floor_ctx(tmp_path, run, state, now=NOW + 11 * 60))[0]
    assert "timer is stopped" in held.fields["why"] and "path is masked" in held.fields["why"]


def test_floor_path_names_its_own_meaning(tmp_path):
    run = systemd(user_ok=False)
    state = {}
    ctx = floor_ctx(tmp_path, run, state)
    ctx.cfg["paths"][-1]["down_signal"] = "sessions.down"
    floor.run(ctx)
    later = floor_ctx(tmp_path, run, state, now=NOW + 11 * 60)
    later.cfg["paths"][-1]["down_signal"] = "sessions.down"
    assert codes(floor.run(later)) == [("sessions.down", "failed")]


def test_floor_unreadable_user_manager(tmp_path):
    state = {}
    run = systemd(user_ok=False)
    floor.run(floor_ctx(tmp_path, run, state))
    assert codes(floor.run(floor_ctx(tmp_path, run, state, now=NOW + 11 * 60))) == [
        ("floor.down", "failed")
    ]


def test_floor_stale_scan_fails_at_once_but_only_after_the_watch_clock(tmp_path):
    def stale_run(argv, timeout=60, input_text=None):
        res = systemd()(argv, timeout, input_text)
        return Result(0, res.out.replace(f"@{int(NOW - 600)}", f"@{int(NOW - 7200)}"))

    state = {"Nightshift": {"watch_since": NOW - 7200}}
    out = floor.run(floor_ctx(tmp_path, stale_run, state))
    assert (
        codes(out) == [("floor.down", "failed")]
        and "last finished 120 min ago" in out[0].fields["why"]
    )
    fresh = floor.run(
        floor_ctx(tmp_path, stale_run, {})
    )  # watching for the first time: the clock starts now
    assert codes(fresh) == [("floor.ok", "ok")]


def test_floor_boot_holds_the_stale_clock_back(tmp_path):
    def stale_run(argv, timeout=60, input_text=None):
        res = systemd()(argv, timeout, input_text)
        return Result(0, res.out.replace(f"@{int(NOW - 600)}", f"@{int(NOW - 7200)}"))

    state = {"Nightshift": {"watch_since": NOW - 7200}}
    out = floor.run(floor_ctx(tmp_path, stale_run, state, uptime=600))  # booted 10 minutes ago
    assert codes(out) == [("floor.ok", "ok")]


def test_floor_run_in_progress_counts_like_a_success_unless_the_last_run_failed(tmp_path):
    def mid_run(argv, timeout=60, input_text=None):
        res = systemd()(argv, timeout, input_text)
        out = res.out.replace("ActiveState=inactive", "ActiveState=activating").replace(
            f"ExecMainExitTimestamp=@{int(NOW - 600)}", f"ExecMainStartTimestamp=@{int(NOW - 60)}"
        )
        return Result(0, out)

    state = {"Nightshift": {"watch_since": NOW - 7200}}
    assert codes(floor.run(floor_ctx(tmp_path, mid_run, state))) == [("floor.ok", "ok")]
    failed = {"Nightshift": {"watch_since": NOW - 7200, "last_result": "exit-code"}}
    assert codes(floor.run(floor_ctx(tmp_path, mid_run, failed))) == [("floor.down", "failed")]


def test_floor_delivery_heartbeat(tmp_path):
    beat = tmp_path / "delivery.json"
    beat.write_text(json.dumps({"at": NOW - 3 * 3600}))
    ctx = floor_ctx(tmp_path, systemd(), {"Nightshift": {"delivery_watch_since": NOW - 3600 * 5}})
    ctx.cfg["paths"][-1]["delivery_file"] = str(beat)
    out = floor.run(ctx)
    assert (
        codes(out) == [("floor.down", "failed")]
        and "delivery pass last ran 180 min ago" in out[0].fields["why"]
    )
    beat.write_text("{not json")
    assert floor.delivery_heartbeat(ctx, str(beat)) is False
    assert floor.delivery_heartbeat(ctx, "") is None


def test_floor_aico_path_is_judged_once_its_web_server_exists(tmp_path):
    def with_aico(argv, timeout=60, input_text=None):
        names = argv[argv.index("--") + 1 :]
        base = systemd()(argv, timeout, input_text)
        extra = "".join(
            block(u, ActiveState="failed", Result="exit-code")
            if u == "aico-web.service"
            else block(u, LoadState="not-found", ActiveState="inactive")
            for u in names
            if u.startswith("aico")
        )
        return Result(0, base.out.replace("aico", "x-aico") + extra)

    state = {}
    floor.run(floor_ctx(tmp_path, with_aico, state))
    out = floor.run(floor_ctx(tmp_path, with_aico, state, now=NOW + 11 * 60))
    assert (
        codes(out)[0] == ("floor.down", "failed")
        and "aico-web.service failed" in out[0].fields["why"]
    )
    assert "aico-jobs" not in out[0].fields["why"]  # optional unit, not installed: not a cause


def test_floor_rows_and_meanings_exist_for_every_code():
    meanings = DATA["meanings"]["signal"]
    for code in (
        "floor.down",
        "floor.watching:ok",
        "floor.none",
        "usage.collect_stale",
        "usage.collected:ok",
        "usage.acct_unavailable",
        "usage.collect_failed",
        "usage.sample_failed",
    ):
        assert code in meanings, code
    assert "floor" in DATA["meanings"]["ok"] and "usage" in DATA["meanings"]["ok"]
