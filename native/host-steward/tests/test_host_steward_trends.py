"""Trends, history, storage fill rate, PVE guests and the asset registry (host-steward, ns-01 leftovers and ns-23)."""

import json
import sqlite3
import time
from collections import namedtuple
from datetime import UTC, datetime, timedelta

import pytest

from host_steward import assets, core, history, trend
from host_steward.checks import CHECKS, ecc, guests, pve, registry, storage, trends

DATA = core.load_data()
NOW = datetime(2026, 11, 3, 12, 0, 0).timestamp()
DAY = 86400


@pytest.fixture(autouse=True)
def scratch(monkeypatch, tmp_path):
    """Every file these checks keep (history, asset state, guard state) lives in the test's folder."""
    monkeypatch.setattr(history, "DEFAULT_PATH", tmp_path / "history.sqlite3")
    monkeypatch.setattr(assets, "STATE_PATH", tmp_path / "assets.json")


@pytest.fixture
def store(tmp_path):
    s = history.Store(tmp_path / "h.sqlite3")
    yield s
    s.close()


def ctx_for(check, now=NOW, cache=None, state=None, cfg=None, site=None):
    return core.Ctx(
        cfg=cfg or DATA["checks"][check],
        site=site or DATA["site"],
        now=now,
        cache=cache if cache is not None else {},
        state=state if state is not None else {},
    )


def fill_days(store, metric, host, values, dim="", end=NOW, kind="gauge"):
    """One reading per day, the last value on `end`'s day."""
    for i, value in enumerate(reversed(values)):
        store.record(metric, host, value, dim, end - i * DAY, "last", kind)


def nightshift_db(path, rows):
    db = sqlite3.connect(path)
    db.executescript(
        "CREATE TABLE series (metric TEXT, host TEXT, kind TEXT, created REAL, coverage_start REAL);"
        "CREATE TABLE daily (metric TEXT, host TEXT, dim TEXT, day TEXT, value REAL, ts REAL);"
    )
    for metric, host, dim, day, value in rows:
        db.execute(
            "INSERT OR IGNORE INTO series VALUES (?,?,?,?,?)",
            (metric, host, "gauge", NOW - 30 * DAY, NOW - 30 * DAY),
        )
        db.execute("INSERT INTO daily VALUES (?,?,?,?,?,?)", (metric, host, dim, day, value, NOW))
    db.commit()
    db.close()


# ---------------------------------------------------------------- history


def test_seed_copies_once_and_existing_rows_win(store, tmp_path):
    src = tmp_path / "ns.sqlite3"
    days = [history.day_of(NOW - i * DAY) for i in range(5)]
    nightshift_db(
        src,
        [("pool.data_pct", "davion-gem", "pve/data", d, 50.0 + i) for i, d in enumerate(days)]
        + [("pool.data_pct", "other-host", "x", days[0], 1.0)]
        + [("posture.score", "davion-gem", "", days[0], 9.0)],
    )
    store.record(
        "pool.data_pct", "pve", 99.0, "pve/data", NOW, "last"
    )  # started recording before the seed ran
    hosts, metrics = {"davion-gem": "pve"}, ["pool.data_pct"]
    assert (
        store.seed_once(src, hosts, metrics) == 4
    )  # the other host, the other metric and today's row are not copied
    assert store.day_value("pool.data_pct", "pve", days[0], "pve/data") == 99.0
    assert (
        store.series("pool.data_pct", "pve")["coverage_start"] == NOW - 30 * DAY
    )  # the earlier start wins
    assert store.series("posture.score", "pve") is None
    assert store.seed_once(src, hosts, metrics) == 0  # once


def test_seed_with_unreadable_source_is_tried_again(store, tmp_path):
    assert store.seed_once(tmp_path / "missing.sqlite3", {"a": "pve"}, ["m"]) == 0
    src = tmp_path / "later.sqlite3"
    nightshift_db(src, [("m", "a", "", history.day_of(NOW), 1.0)])
    assert store.seed_once(src, {"a": "pve"}, ["m"]) == 1


def test_record_aggregates_per_day(store):
    store.record("m", "pve", 5.0, "", NOW, "max")
    store.record("m", "pve", 3.0, "", NOW + 60, "max")
    store.record("n", "pve", 5.0, "", NOW, "last")
    store.record("n", "pve", 3.0, "", NOW + 60, "last")
    today = history.day_of(NOW)
    assert (store.day_value("m", "pve", today), store.day_value("n", "pve", today)) == (5.0, 3.0)


def test_record_never_fails_the_check(monkeypatch, tmp_path):
    blocked = tmp_path / "file"
    blocked.write_text("")
    monkeypatch.setattr(
        history, "DEFAULT_PATH", blocked / "h.sqlite3"
    )  # a folder under a file: cannot open
    history.record({}, "m", "pve", 1.0)  # swallowed, logged


# ---------------------------------------------------------------- trend rules and the thin pool


def spec_named(code):
    return trend.spec_from(next(s for s in DATA["checks"]["trends"]["specs"] if s["code"] == code))


def test_thin_pool_reaches_the_failed_line_in_about_27_days(store):
    fill_days(
        store,
        "pool.data_pct",
        "pve",
        [round(65.26 - 0.99 * i, 2) for i in range(21, -1, -1)],
        "pve/data",
    )
    fill_days(store, "pool.meta_pct", "pve", [2.9] * 22, "pve/data")
    spec = spec_named("pve.thin.trend")
    ev = trend.evaluate(store, spec, NOW)
    assert ev["verdict"] == "worsening"
    assert "reaches 92.0% in ~27 days" in trend.line(spec, ev, {"pve": "PVE host"})
    assert trend.state_of(spec, ev) == "warn"


def test_thin_limit_is_the_pve_failed_line():
    assert spec_named("pve.thin.trend").rules[0].limit == DATA["checks"]["pve"]["thin_crit"]
    assert (
        spec_named("pve.guest_disk_trend").rules[0].limit
        == DATA["checks"]["guests"]["guest_disk_crit_pct"]
    )


def test_thin_trend_check_is_failed_on_the_pve_host_because_it_holds_data(store, monkeypatch):
    fill_days(
        store,
        "pool.data_pct",
        "pve",
        [round(65.26 - 0.99 * i, 2) for i in range(21, -1, -1)],
        "pve/data",
    )
    ctx = ctx_for("trends", cache={"history": store})
    sig = next(s for s in trends.run(ctx) if s.code == "pve.thin.trend")
    assert sig.state == "failed"
    assert "pve/data data reaches 92.0% in ~27 days" in core.meaning(
        "trends", [sig], DATA["meanings"]
    )
    # the same trend on a host that holds no data stays at the spec's warn
    plain = assets.load_file()
    for a in plain["assets"]:
        if a["id"] == "davion-gem":
            a["data"] = False
    monkeypatch.setattr(assets, "load_file", lambda *_: plain)
    sig = next(
        s
        for s in trends.run(ctx_for("trends", cache={"history": store}))
        if s.code == "pve.thin.trend"
    )
    assert sig.state == "warn"


def test_flat_pool_is_stable_and_young_history_is_not_enough(store):
    fill_days(
        store,
        "pool.data_pct",
        "pve",
        [
            65.0,
            65.01,
            65.0,
            65.02,
            65.0,
            65.01,
            65.0,
            65.0,
            65.02,
            65.0,
            65.0,
            65.01,
            65.0,
            65.0,
            65.0,
        ],
        "pve/data",
    )
    assert trend.evaluate(store, spec_named("pve.thin.trend"), NOW)["verdict"] == "stable"
    fill_days(store, "disk.used_pct", "workstation", [50.0, 52.0], "/")
    assert trend.evaluate(store, spec_named("storage.disk_trend"), NOW)["verdict"] == "insufficient"


def test_counter_rule_flags_a_new_media_error(store):
    fill_days(store, "disk.media_errors", "pve", [0.0] * 9 + [1.0], "SERIAL1", kind="counter")
    spec = spec_named("pve.smart.trend")
    ev = trend.evaluate(store, spec, NOW)
    assert ev["verdict"] == "worsening"
    assert trend.state_of(spec, ev) == "failed"


def test_a_cleanup_resets_the_disk_projection(store):
    values = [
        60.0,
        62.0,
        64.0,
        66.0,
        68.0,
        70.0,
        72.0,
        74.0,
        76.0,
        78.0,
        80.0,
        82.0,
        84.0,
        86.0,
        70.0,
        70.1,
    ]
    fill_days(store, "disk.used_pct", "workstation", values, "/")
    assert trend.evaluate(store, spec_named("storage.disk_trend"), NOW)["verdict"] != "worsening"


def test_trends_seeds_once_then_skips_specs_with_nothing_recorded(store, tmp_path):
    src = tmp_path / "ns.sqlite3"
    nightshift_db(
        src,
        [
            ("pool.data_pct", "davion-gem", "pve/data", history.day_of(NOW - i * DAY), 65.0)
            for i in range(3)
        ],
    )
    cfg = {
        **DATA["checks"]["trends"],
        "seed": {**DATA["checks"]["trends"]["seed"], "source": str(src)},
    }
    first = trends.run(ctx_for("trends", cache={"history": store}, cfg=cfg))
    assert {s.code for s in first} >= {"pve.thin.trend", "trends.seeded"}
    assert not any(
        s.code == "storage.smart_trend" for s in first
    )  # nothing recorded for the workstation
    second = trends.run(ctx_for("trends", cache={"history": store}, cfg=cfg))
    assert not any(s.code == "trends.seeded" for s in second)


def test_empty_history_still_makes_a_row(store):
    cfg = {**DATA["checks"]["trends"], "seed": {}}
    assert [s.code for s in trends.run(ctx_for("trends", cache={"history": store}, cfg=cfg))] == [
        "trends.none"
    ]


def test_ecc_trend_is_record_only_in_the_row(store):
    fill_days(store, "mem.ce", "pve", [5.0] * 20 + [60.0] * 7, kind="events")
    sig = next(
        s
        for s in trends.run(ctx_for("trends", cache={"history": store}))
        if s.code == "pve.ecc.trend"
    )
    assert sig.state == "failed" and sig.note  # the spec says failed ...
    row = core.make_row(
        "trends", [sig], DATA["checks"]["trends"], DATA["meanings"], "m", NOW, DATA["caps"]
    )
    assert row["state"] == "ok"  # ... the owner's decision caps it, and the text stays
    assert "corrected" in row["meaning"]


# ---------------------------------------------------------------- readings the checks record


def test_pve_check_records_pool_and_disk_readings(store):
    lvs = json.dumps(
        {
            "report": [
                {
                    "lv": [
                        {
                            "lv_name": "data",
                            "vg_name": "pve",
                            "lv_attr": "twi-aotz--",
                            "data_percent": "65.2",
                            "metadata_percent": "2.9",
                        }
                    ]
                }
            ]
        }
    )
    smart = "DEV /dev/nvme0\n" + json.dumps(
        {
            "serial_number": "S1",
            "smart_status": {"passed": True},
            "nvme_smart_health_information_log": {
                "media_errors": 0,
                "percentage_used": 3,
                "available_spare": 100,
            },
        }
    )
    ctx = ctx_for("pve", cache={"history": store})
    pve.record_readings(ctx, {"lvs": lvs, "smart": smart})
    day = history.day_of(NOW)
    assert store.day_value("pool.data_pct", "pve", day, "pve/data") == 65.2
    assert store.day_value("pool.meta_pct", "pve", day, "pve/data") == 2.9
    assert store.day_value("disk.wear_pct", "pve", day, "S1") == 3.0
    assert store.day_value("disk.spare_used_pct", "pve", day, "S1") == 0.0
    assert store.series("disk.media_errors", "pve")["kind"] == "counter"


def ecc_journal(first, events):
    lines = [f"FIRST {first}"] + [
        f"{kind} {ts} MC0_STATUS 1 0x{addr:x} 1"
        if over
        else f"{kind} {ts} MC0_STATUS 0 0x{addr:x} 1"
        for kind, ts, over, addr in events
    ]
    return "\n".join(lines)


def test_ecc_check_records_whole_days_with_zeros_for_quiet_ones(store):
    today = NOW - 3600
    ev = [
        ("CE", today, True, 0x200000),
        ("CE", today - 10, False, 0x400000),
        ("CE", NOW - 2 * DAY, False, 0x200000),
        ("UE", NOW - 2 * DAY + 90, False, 0x200000),
    ]
    sections = {"ecc": ecc_journal(NOW - 8 * DAY, ev), "rasmce": ""}
    ecc.evaluate(sections, DATA["checks"]["ecc"], NOW, {}, {"history": store})
    d = lambda n: history.day_of(NOW - n * DAY)
    assert store.day_value("mem.ce", "pve", d(0)) == 2
    assert store.day_value("mem.ce_overflow", "pve", d(0)) == 1
    assert store.day_value("mem.ce", "pve", d(1)) == 0 and store.series("mem.ce", "pve")
    assert (
        store.day_value("mem.ce", "pve", d(2)) == 1 and store.day_value("mem.ue", "pve", d(2)) == 1
    )
    assert store.daily("mem.ce", "pve", "", history.day_of(NOW - 9 * DAY))[0][1] == d(
        7
    )  # the partly covered 8th day is left alone


# ---------------------------------------------------------------- storage fill rate


Usage = namedtuple("Usage", "total used free")
GIB = 1024**3
SYSTEM = {"name": "System disk", "path": "/", "balance": True}


def storage_cfg(tmp_path, **over):
    return {
        **DATA["checks"]["storage"],
        "guard_inherit": [],
        "growers_inherit": [],
        "samples_inherit": str(tmp_path / "none.json"),
        **over,
    }


def falling(rate_gib_h, hours, free_now_gib):
    """A sample every 15 minutes, `hours` back from NOW, free space falling at rate_gib_h."""
    return [
        [NOW - i / 4 * 3600, int((free_now_gib + rate_gib_h * i / 4) * GIB)]
        for i in range(int(hours * 4), 0, -1)
    ]


def run_fill(monkeypatch, tmp_path, samples, free_gib, guard=None, cfg_over=None):
    monkeypatch.setattr(
        storage.shutil,
        "disk_usage",
        lambda _p: Usage(500 * GIB, int((500 - free_gib) * GIB), int(free_gib * GIB)),
    )
    cfg = storage_cfg(tmp_path, **(cfg_over or {}))
    if guard is not None:
        path = tmp_path / "guard.json"
        path.write_text(json.dumps(guard))
        cfg["guard_inherit"] = [str(path)]
    ctx = ctx_for(
        "storage",
        cfg=cfg,
        state={"samples": {"/": samples}},
        cache={"history": history.Store(tmp_path / "f.sqlite3")},
    )
    return {s.code: s for s in storage.disk(ctx, SYSTEM)}


def test_fill_rate_and_hours():
    pts = [[NOW - h * 3600, int((100 + 3 * h) * GIB)] for h in (6, 5, 4, 3, 2, 1, 0)]
    assert storage.fill_rate(pts, NOW, 6 * 3600 + 60) == pytest.approx(3.0, abs=0.01)
    assert storage.fill_rate(pts[-2:], NOW, 3600) is None  # two samples are no trend
    assert storage.hours_to(60.0, 25.0, 3.0) == 11.7
    assert storage.hours_to(60.0, 25.0, 0.001) is None
    assert storage.fill_state(11.0, None, 12, 48) == "failed"
    assert storage.fill_state(30.0, None, 12, 48) == "warn"
    assert storage.fill_state(None, 60.0, 12, 48) == "ok"


def test_filling_disk_fails_before_the_reserve_and_the_ballast_counts_as_free(
    monkeypatch, tmp_path
):
    samples = falling(3.0, 6, 60.0)
    sig = run_fill(monkeypatch, tmp_path, samples, 60.0)["storage.fill"]
    assert sig.state == "failed" and sig.fields["hours"] == "11.7"
    ballast = {"at": datetime.now(UTC).isoformat(), "ballast": {"/": 6 * GIB}}
    sigs = run_fill(monkeypatch, tmp_path, samples, 60.0, guard=ballast)
    assert sigs["storage.fill"].state == "warn"  # 66 GiB over a 25 GiB reserve at 3 GiB/h: 13.7 h
    assert sigs["storage.ballast"].fields["gib"] == "6"


def test_a_step_the_last_hour_no_longer_shows_is_not_a_trend(monkeypatch, tmp_path):
    samples = [
        [NOW - h * 3600, int(((60.0 + 18.0) if h > 1 else 60.0) * GIB)]
        for h in (6, 5.5, 5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1.01, 0.75, 0.5, 0.25)
    ]
    assert "storage.fill" not in run_fill(monkeypatch, tmp_path, samples, 60.0)


def test_the_first_run_starts_from_nightshifts_samples(monkeypatch, tmp_path):
    seed = tmp_path / "samples.json"
    seed.write_text(json.dumps({"/": falling(3.0, 6, 60.0)}))
    monkeypatch.setattr(
        storage.shutil, "disk_usage", lambda _p: Usage(500 * GIB, 440 * GIB, 60 * GIB)
    )
    ctx = ctx_for(
        "storage",
        cfg=storage_cfg(tmp_path, samples_inherit=str(seed)),
        cache={"history": history.Store(tmp_path / "f.sqlite3")},
    )
    assert any(s.code == "storage.fill" for s in storage.disk(ctx, SYSTEM))
    assert len(ctx.state["samples"]["/"]) > 20 and ctx.state["samples"]["/"][-1][0] == NOW


def test_reclaim_that_ran_out_of_tiers_is_failed(monkeypatch, tmp_path):
    guard = {
        "at": datetime.now(UTC).isoformat(),
        "filesystems": [
            {
                "path": "/",
                "ladder": {
                    "tiers": ["cleanup", "balance"],
                    "exhausted": True,
                    "free_before_gib": 10,
                    "free_after_gib": 12,
                },
            }
        ],
    }
    sig = run_fill(monkeypatch, tmp_path, [[NOW - 60, 40 * GIB]], 40.0, guard=guard)[
        "storage.reclaim.exhausted"
    ]
    assert sig.state == "failed" and sig.fields["tiers"] == "cleanup, balance"


def test_the_newest_guard_state_wins(tmp_path):
    old, new = tmp_path / "old.json", tmp_path / "new.json"
    old.write_text(json.dumps({"at": "2026-11-01T00:00:00+00:00", "k": "old"}))
    new.write_text(json.dumps({"at": "2026-11-02T00:00:00+00:00", "k": "new"}))
    assert storage.newest_state([str(old), str(new), str(tmp_path / "gone.json")])["k"] == "new"
    assert storage.newest_state([str(tmp_path / "gone.json")]) == {}


def test_storage_smart_counters_for_the_history():
    text = "Serial Number:    S6NR\nMedia and Data Integrity Errors:    1,234\nPercentage Used:    12%\n  5 Reallocated_Sector_Ct 0x0033 100 100 010 Pre-fail Always - 7\n"
    assert storage.smart_counters(text) == {
        "media_errors": 1234,
        "percentage_used": 12,
        "reallocated": 7,
        "serial": "S6NR",
    }


# ---------------------------------------------------------------- PVE guests


VMS = """VM 100 running
name: st-browser
onboot: 1
agent: 1
scsi0: local-lvm:vm-100-disk-0,discard=on,size=40G
VM 110 stopped
name: wfp-target-win11
onboot: 0
scsi0: local-lvm:vm-110-disk-0,size=60G
VM 9000 stopped
name: ubuntu-2404-cloud
template: 1
CT 150 running ob=1 ominull-hub
CT 160 stopped ob=1 restic-append
BOOT 1000
TASK 160 vzstop 69000000 root@pam ok
HIST 160 vzstop 69000000 root@pam ok
HIST 100 qmstart 69000001 summitflow@pve!automation ok
"""


def test_parse_guests_templates_and_containers():
    got = {g["vmid"]: g for g in guests.parse_guests(VMS)}
    assert got["9000"]["template"] and got["150"]["type"] == "ct" and got["160"]["onboot"]
    assert got["100"]["status"] == "running" and not got["110"]["template"]


def test_discard_off_names_the_thin_pool_disks_without_it():
    sig = guests.discard_signal(guests.parse_vms(VMS), "local-lvm")
    assert sig.state == "warn" and sig.fields["n"] == 1 and "VM 110 scsi0" in sig.fields["where"]


def test_a_guest_stopped_on_purpose_since_boot_is_not_down():
    sigs = {s.code: s for s in guests.run_state(VMS)}
    assert sigs["guests.running"].fields["running"] == 2
    stopped = sigs["guests.stopped"]
    assert stopped.state == "ok" and "restic-append" in stopped.fields["held"]


def test_a_guest_down_with_no_stop_task_is_a_warning():
    text = VMS.replace("TASK 160 vzstop 69000000 root@pam ok\n", "")
    assert next(s for s in guests.run_state(text) if s.code == "guests.stopped").state == "warn"


def test_guest_history_is_saved_for_the_probes_check(tmp_path):
    ctx = ctx_for("guests", cfg={**DATA["checks"]["guests"], "guests_file": "pve-guests.json"})
    guests.save_detail(ctx, VMS)
    saved = json.loads((core.STATE_PATH.parent / "pve-guests.json").read_text())
    assert saved["seen"] == NOW and saved["details"]["tasks"]["160"][0]["action"] == "stop"
    assert {g["name"] for g in saved["details"]["guests"]} >= {"st-browser", "restic-append"}


def test_segment_guard_open_is_failed_and_absent_is_idle():
    guard = [{"bridge": "labnet", "nft_table": "inet lab_isolation"}]
    assert guests.segments("BR labnet\nNFT inet lab_isolation\n", guard)[0].state == "ok"
    assert guests.segments("BR labnet\n", guard)[0].state == "failed"
    assert guests.segments("BR vmbr0\n", guard)[0].fields["how"] == "absent"


def test_guest_disk_levels_and_history(store):
    fs = "AGENT 100 ok\nFS 100 ext4 85000000000 100000000000 /\n"
    sigs = guests.agents_and_disks(
        VMS, fs, DATA["checks"]["guests"], {"history": store}, lambda _v, s: s
    )
    disk = next(s for s in sigs if s.code == "guests.disk")
    assert disk.state == "warn" and disk.fields["pct"] == "85"
    assert store.day_value("guest.disk_used_pct", "pve", history.day_of(time.time()), "100") == 85.0


def test_check_set_and_config_are_complete():
    for name in ("guests", "assets", "trends"):
        assert name in CHECKS and name in DATA["checks"] and name in DATA["meanings"]["ok"]
    assert CHECKS["assets"] is registry


# ---------------------------------------------------------------- assets


def asset(**kw):
    base = {"id": "x", "tier": "standard", "kind": "vm", "vmid": 301}
    a, why = assets.entry(kw.pop("id", "x"), {**base, **kw})
    assert a is not None, why
    return a


def test_tier_step_matrix():
    crit, lab, data = asset(tier="critical"), asset(tier="lab"), asset(data=True)
    assert (
        assets.tier_state("warn", "health", lab, True) == "ok"
    )  # a lab machine's health is a note
    assert assets.tier_state("warn", "health", crit, True) == "warn"
    assert assets.tier_state("warn", "security", crit, True) == "failed"
    assert (
        assets.tier_state("warn", "security", lab, False) == "failed"
        and assets.tier_state("warn", "security", lab, True) == "warn"
    )
    assert (
        assets.tier_state("warn", "data", data, True) == "failed"
        and assets.tier_state("warn", "data", asset(), True) == "warn"
    )
    assert assets.tier_state("ok", "data", data, True) == "ok"
    sig = assets.tier_signal(core.Signal("a.b", "warn", {}), "health", lab, True)
    assert (sig.state, sig.note) == ("ok", True)


def test_finding_classes_come_from_the_data_file():
    classes = assets.load_file()["tiers"]["classes"]
    assert assets.finding_class("pve.thin.trend", classes) == "data"
    assert assets.finding_class("tripwire.auth", classes) == "security"
    assert assets.finding_class("guests.disk", classes) == "health"


def nic(bridge="labnet", firewall=True, tag="", slot="net0"):
    return {"slot": slot, "bridge": bridge, "firewall": firewall, "tag": tag}


def test_isolation_needs_nic_evidence():
    lab = asset(tier="lab", isolated=True)
    ok = assets.isolated_verified(lab, {"301": [nic()]}, ["vmbr0"])
    assert ok[0]
    assert not assets.isolated_verified(lab, {"301": [nic("vmbr0")]}, ["vmbr0"])[0]
    assert not assets.isolated_verified(lab, {"301": [nic(firewall=False)]}, ["vmbr0"])[0]
    assert not assets.isolated_verified(lab, {}, ["vmbr0"])[0]
    assert assets.isolated_verified(
        lab, {"301": [nic("vmbr0", tag="20")]}, ["vmbr0"], assets.lab_vlans([20])
    )[0]
    assert not assets.isolated_verified(
        lab, {"301": [nic("vmbr0", tag="1")]}, ["vmbr0"], assets.lab_vlans([1])
    )[0]  # tag 1 is the LAN
    assert not assets.isolated_verified(asset(tier="lab"), {"301": [nic()]}, ["vmbr0"])[0]


def test_discovery_keeps_the_tier_a_guest_got_at_first_sight():
    reg = assets.load()
    state = {}
    guest = {
        "vmid": "777",
        "name": "New Thing",
        "type": "vm",
        "template": False,
        "tags": ["lab"],
        "pools": [],
    }
    tags = assets.load_file()["tiers"]["tag_tiers"]
    assert assets.discover(reg, [guest], state, NOW, tags) == ["new-thing"]
    assert reg.assets["new-thing"].tier == "lab" and reg.assets["new-thing"].source == "discovered"
    reg2 = assets.load()
    assets.discover(
        reg2, [{**guest, "tags": []}], state, NOW + 1, tags
    )  # the tag is gone: the tier stays
    assert reg2.assets["new-thing"].tier == "lab"
    reg3 = assets.load()
    assets.discover(
        reg3, [{**guest, "tags": ["tier-critical"]}], state, NOW + 2, tags
    )  # a later tag can raise it
    assert reg3.assets["new-thing"].tier == "critical"
    assert assets.discover(
        assets.load(),
        [{"vmid": "9999", "name": "tpl", "type": "vm", "template": True}],
        {},
        NOW,
        tags,
    )


def test_registry_has_every_site_asset():
    reg = assets.load()
    assert not reg.problems and len(reg.assets) == 18
    pve_host, wfp = reg.by_role("pve"), reg.by_vmid("110")
    assert pve_host and pve_host.id == "davion-gem" and wfp and wfp.id == "wfp-target-win11"


def test_lab_claims_reads_only_safe_unexpired_files(tmp_path):
    good = tmp_path / "lab-use.json"
    good.write_text(
        json.dumps(
            {
                "wfp-target-win11": {
                    "at": NOW - 60,
                    "until": NOW + 3600,
                    "reason": "testing",
                    "by": "codex",
                },
                "neri-lab": {"at": NOW - 7200, "until": NOW - 60, "reason": "old", "by": "x"},
            }
        )
    )
    assert set(assets.lab_claims([str(good)], NOW)) == {"wfp-target-win11"}
    good.chmod(0o666)
    assert assets.lab_claims([str(good)], NOW) == {}
    assert assets.lab_claims([str(tmp_path / "missing.json")], NOW) == {}


# ---------------------------------------------------------------- the assets check


UPID = "UPID:gem:0001:0002:{hex}:qmstart:{vmid}:{user}:"


def sections(running, nics_text="", starts="", pools=""):
    vms = "\n".join(f"VM {vmid} running\nname: g{vmid}\nonboot: 0" for vmid in running)
    return {
        "vms": vms,
        "nics": nics_text,
        "pools": pools,
        "starts": starts,
        "webstarts": "",
        "end": "",
    }


def run_assets(secs, now=NOW, state=None, site=None):
    cache = {"guests": (secs, "")}
    ctx = ctx_for(
        "assets", now=now, cache=cache, state=state if state is not None else {}, site=site
    )
    return {s.code: s for s in registry.run(ctx)}, ctx


def test_a_parked_machine_running_unexplained_warns_then_fails_when_it_holds_data():
    secs = sections(
        [140], starts=UPID.format(hex=f"{int(NOW) - 600:08X}", vmid=140, user="root@pam") + " OK"
    )
    sigs, ctx = run_assets(secs)
    assert sigs["assets.parked_running"].state == "warn"
    assert "shell on PVE" in sigs["assets.parked_running"].fields["how"]
    later, _ = run_assets(
        secs, now=NOW + 2 * 3600, state=ctx.state
    )  # blackbox-vault holds data: one hour is the limit
    assert later["assets.parked_running"].state == "failed"


def test_a_token_start_or_a_lab_use_declaration_explains_a_parked_machine(tmp_path):
    secs = sections(
        [140],
        starts=UPID.format(hex=f"{int(NOW) - 600:08X}", vmid=140, user="summitflow@pve!automation")
        + " OK",
    )
    sigs, _ = run_assets(secs)
    assert sigs["assets.parked_token"].state == "ok" and "assets.parked_running" not in sigs
    claim = tmp_path / "lab-use.json"
    claim.write_text(
        json.dumps(
            {
                "blackbox-vault": {
                    "at": NOW - 60,
                    "until": NOW + 3600,
                    "reason": "restore drill",
                    "by": "claude",
                }
            }
        )
    )
    site = {**DATA["site"], "assets": {**DATA["site"]["assets"], "lab_use_files": [str(claim)]}}
    sigs, _ = run_assets(sections([140]), site=site)
    assert (
        sigs["assets.parked_in_use"].fields["by"] == "claude"
        and "assets.parked_running" not in sigs
    )


def test_a_lab_guest_on_the_lan_is_a_breach():
    nics = "G 110 vm running\nnet0: e1000=AA:BB,bridge=vmbr0,firewall=1\n"
    sigs, _ = run_assets(sections([110], nics_text=nics))
    assert sigs["assets.lab_on_lan"].state == "failed"


def test_an_isolated_lab_guest_on_its_own_bridge_is_fine_and_state_is_kept():
    nics = "G 110 vm running\nnet0: e1000=AA:BB,bridge=labnet,firewall=1\n"
    sigs, ctx = run_assets(sections([110], nics_text=nics))
    assert "assets.lab_on_lan" not in sigs
    assert ctx.state["isolation"]["wfp-target-win11"] is True
    assert sigs["assets.registry"].fields["n"] >= 18


def test_unknown_guests_are_discovered_and_pve_down_is_a_note():
    secs = sections([555])
    secs["vms"] += "\nVM 777 stopped\nname: Fresh One\nonboot: 0"
    sigs, ctx = run_assets(secs)
    assert "assets.discovered" in sigs and "fresh-one" in sigs["assets.discovered"].fields["names"]
    assert ctx.state["first_seen"]["777"]["tier"] == "standard"
    down = registry.run(ctx_for("assets", cache={"guests": (None, "ssh: timed out")}))
    assert down[0].code == "assets.pve_meta_unavailable" and down[0].note


def test_start_attribution():
    starts = registry.parse_starts(
        UPID.format(hex="6A000000", vmid=140, user="root@pam")
        + " OK\n"
        + UPID.format(hex="6A000100", vmid=141, user="a@pve!tok")
        + " OK"
    )
    at = float(int("6A000000", 16))
    web = registry.parse_webstarts(
        f'10.0.0.5 - root@pam [{datetime.fromtimestamp(at, UTC).strftime("%d/%m/%Y:%H:%M:%S %z")}] "POST /api2/json/nodes/gem/qemu/140/status/start HTTP/1.1" 200 50'
    )
    assert registry.attribution(140, starts, web)["kind"] == "web"
    assert registry.attribution(140, starts, [])["kind"] == "shell"
    assert registry.attribution(141, starts, [])["kind"] == "token"
    assert registry.attribution(999, starts, [])["kind"] == "unknown"


def test_dry_run_of_the_new_checks_makes_rows(monkeypatch, tmp_path):
    from host_steward import runner

    data = {**DATA, "checks": {k: v for k, v in DATA["checks"].items() if k in ("trends",)}}
    monkeypatch.setattr(runner, "CHECKS", {"trends": CHECKS["trends"]})
    rows, ran = runner.run_checks(data, {}, NOW, run=lambda *a, **k: core.Result(1), machine="m")
    assert ran == ["trends"] and rows[0]["id"] == "m/check-trends"
    assert timedelta(minutes=1) < rows[0]["next_run"] - rows[0]["last_run"]
