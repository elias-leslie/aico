"""One test group per host check, on fixture inputs (a fake command runner and temp files): no root, no network."""

from __future__ import annotations

import json
from collections import namedtuple
from pathlib import Path

import pytest

from host_steward import core
from host_steward.checks import (
    backups,
    ecc,
    gates,
    journal,
    ominull_lock,
    perf,
    pve,
    router,
    storage,
    thermal,
    workstation,
)
from host_steward.jobs import memctl

DATA = core.load_data()
NOW = 1_800_000_000.0
Result = core.Result


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


def ctx(check, run=None, site=None, state=None, **over):
    cfg = {**DATA["checks"][check], **over}
    return core.Ctx(cfg=cfg, site=site or DATA["site"], now=NOW, run=run or Fake(), state=state if state is not None else {})


def states(signals):
    return {s.code: s.state for s in signals}


# workstation


@pytest.fixture
def ws_files(tmp_path):
    proc = tmp_path / "proc"
    (proc / "vm").mkdir(parents=True)
    (proc / "vm/swappiness").write_text("10\n")
    conf = tmp_path / "swap.conf"
    conf.write_text("vm.swappiness = 10\n")
    zswap = tmp_path / "zswap"
    zswap.mkdir()
    for key, value in DATA["checks"]["workstation"]["zswap_expect"].items():
        (zswap / key).write_text(value + "\n")
    psi = tmp_path / "psi"
    psi.write_text("some avg10=0.00 avg60=0.00 avg300=0.50 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.10 total=1\n")
    return {
        "swap_conf": str(conf),
        "proc_sys": str(proc),
        "zswap_dir": str(zswap),
        "psi_memory": str(psi),
        "reboot_flag": str(tmp_path / "no-reboot"),
        "internet_probes": [],
        "tunnel_ready_url": "",
        "core_containers": [],
        "cert_endpoints": [],
    }


def ws_runner(failed="", ufw="Status: active\n", journald="SystemMaxUse=4G\nMaxRetentionSec=30day\n", apt=""):
    ok = Result(0, "", "")
    return Fake(
        (["--failed"], Result(0, failed, "")),
        (["ufw"], Result(0, ufw, "")),
        (["cat-config"], Result(0, journald, "")),
        (["dist-upgrade"], Result(0, apt, "")),
        (["upgrade"], ok),
    )


def test_workstation_healthy(ws_files):
    out = states(workstation.run(ctx("workstation", ws_runner(), **ws_files)))
    assert out["ws.units.failed"] == "ok" and set(out.values()) == {"ok"}


def test_workstation_failed_units_skip_old_transient_scopes_and_name_real_ones(ws_files):
    failed = (
        "myapp.service loaded failed failed My app\n"
        "run-u123.service loaded failed failed Transient\n"
        "app-gnome-foo-123.scope loaded failed failed Desktop app\n"
    )
    signals = workstation.run(ctx("workstation", ws_runner(failed=failed), **ws_files))
    unit = next(s for s in signals if s.code == "ws.units.failed")
    assert unit.state == "warn" and unit.fields["units"].startswith("myapp.service")
    assert "run-u123" not in unit.fields["units"]


def test_workstation_flags_reboot_swap_drift_firewall_journald_and_apt(ws_files, tmp_path):
    Path(ws_files["reboot_flag"]).write_text("")
    Path(ws_files["proc_sys"], "vm/swappiness").write_text("60\n")
    apt = "Inst openssl [1] (2 Ubuntu:26.04/resolute-security [amd64])\nInst htop [1] (2 Ubuntu:26.04/resolute [amd64])\n"
    run = ws_runner(ufw="Status: inactive\n", journald="SystemMaxUse=8G\nMaxRetentionSec=30day\n")
    run.rules = ((["upgrade"], Result(0, apt, "")), (["dist-upgrade"], Result(0, apt, "")), *run.rules)
    out = states(workstation.run(ctx("workstation", run, **ws_files)))
    for code in ("ws.reboot.required", "ws.swap.drift", "ws.ufw.active", "ws.journald.retention", "ws.apt.pending"):
        assert out[code] == "warn", code


def test_workstation_memory_pressure_over_the_data_file_line_warns(ws_files):
    Path(ws_files["psi_memory"]).write_text("some avg10=0 avg60=0 avg300=12.0 total=1\nfull avg10=0 avg60=0 avg300=0.0 total=1\n")
    signal = workstation.pressure(ctx("workstation", **ws_files))
    assert signal.state == "warn" and signal.fields == {"kind": "some", "pct": "12.0"}


def test_workstation_containers_and_cert_expiry(ws_files, monkeypatch):
    run = Fake((["inspect"], Result(0, "/pg running\n/redis exited\n", "")))
    down = workstation.containers(ctx("workstation", run, core_containers=["pg", "redis"], **{k: v for k, v in ws_files.items() if k != "core_containers"}))
    assert down is not None and down.state == "warn" and down.fields["names"] == "redis"
    monkeypatch.setattr(workstation, "endpoint_expiry", lambda *a, **k: NOW + 5 * 86400)
    cert = workstation.certificates(ctx("workstation", cert_endpoints=["a.example"]))
    assert cert is not None and cert.state == "failed" and cert.fields["days"] == "5"
    monkeypatch.setattr(workstation, "endpoint_expiry", lambda *a, **k: NOW + 90 * 86400)
    fine = workstation.certificates(ctx("workstation", cert_endpoints=["a.example"]))
    assert fine is not None and fine.state == "ok"


def test_workstation_probe_that_raises_does_not_hide_the_others(ws_files, monkeypatch):
    monkeypatch.setattr(workstation, "firewall", lambda c: 1 / 0)
    out = states(workstation.run(ctx("workstation", ws_runner(), **ws_files)))
    assert out["check.probe"] == "warn" and out["ws.reboot.required"] == "ok"


# storage

Usage = namedtuple("Usage", "total used free")
GIB = 1024**3


def disk_cfg(**entry):
    return [{"name": "Disk", "path": "/x", **entry}]


def storage_ctx(monkeypatch, free_gib, used_gib=100, usage="", stats="", smart_scan="", **entry):
    monkeypatch.setattr(storage.shutil, "disk_usage", lambda path: Usage(0, int(used_gib * GIB), int(free_gib * GIB)))
    monkeypatch.setattr(storage.shutil, "which", lambda name: f"/usr/sbin/{name}")
    run = Fake(
        (["usage"], Result(0, usage, "")), (["stats"], Result(0, stats, "")), (["--scan-open"], Result(0, smart_scan, ""))
    )
    return ctx("storage", run, disks=disk_cfg(**entry))


BTRFS_OK = "Device size: 1000\nDevice unallocated: 100000000000\nDevice missing: 0\nFree (estimated): 500000000000\n"


def test_storage_system_disk_is_rated_against_the_backup_reserve(monkeypatch):
    for free, want in ((200, "ok"), (35, "warn"), (28, "failed")):
        out = storage.run(storage_ctx(monkeypatch, free, usage=BTRFS_OK, balance=True, btrfs=True))
        assert states(out)["storage.disk.space"] == want, free


def test_storage_plain_disk_uses_percent_and_headroom_lines(monkeypatch):
    assert states(storage.run(storage_ctx(monkeypatch, 500, 100)))["storage.disk.space"] == "ok"
    assert states(storage.run(storage_ctx(monkeypatch, 12, 100)))["storage.disk.space"] == "warn"
    assert states(storage.run(storage_ctx(monkeypatch, 4, 100)))["storage.disk.space"] == "failed"


def test_storage_a_disk_that_is_not_mounted_uses_its_missing_state(monkeypatch):
    def gone(path):
        raise FileNotFoundError(path)

    monkeypatch.setattr(storage.shutil, "disk_usage", gone)
    monkeypatch.setattr(storage.shutil, "which", lambda name: None)
    assert states(storage.run(ctx("storage", disks=disk_cfg(missing="warn"))))["storage.disk.missing"] == "warn"
    assert states(storage.run(ctx("storage", disks=disk_cfg())))["storage.disk.missing"] == "failed"


def test_storage_btrfs_allocation_and_device_errors(monkeypatch):
    tight = BTRFS_OK.replace("100000000000", "4000000000")
    out = states(storage.run(storage_ctx(monkeypatch, 200, usage=tight, stats="[/dev/x].write_io_errs 3\n", btrfs=True)))
    assert out["storage.alloc"] == "failed" and out["storage.btrfs.errors"] == "failed"
    clean = states(storage.run(storage_ctx(monkeypatch, 200, usage=BTRFS_OK, stats="[/dev/x].write_io_errs 0\n", btrfs=True)))
    assert clean["storage.alloc"] == "ok" and clean["storage.btrfs.errors"] == "ok"


def test_storage_smart_failure_and_missing_tool(monkeypatch):
    run = Fake(
        (["--scan-open"], Result(0, "/dev/sda -d sat # x\n", "")),
        (["-H"], Result(0, "SMART overall-health self-assessment test result: FAILED!\n", "")),
    )
    monkeypatch.setattr(storage.shutil, "which", lambda name: "/usr/sbin/smartctl")
    assert states(storage.smart(ctx("storage", run))) == {"storage.smart": "failed"}
    monkeypatch.setattr(storage.shutil, "which", lambda name: None)
    assert states(storage.smart(ctx("storage"))) == {"storage.smart.missing": "warn"}


# perf


def test_perf_crash_loop_and_swap(tmp_path):
    lines = "\n".join(json.dumps({"MESSAGE": f"loopy.service: Scheduled restart job, restart counter is at {i}"}) for i in range(7))
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemAvailable: 33554432 kB\nSwapTotal: 10485760 kB\nSwapFree: 1048576 kB\n")
    out = perf.run(ctx("perf", Fake((["journalctl"], Result(0, lines, ""))), meminfo=str(meminfo)))
    assert states(out) == {"perf.crash_loop": "warn", "perf.swap": "warn"}
    assert "loopy.service (7/h)" in out[0].fields["units"]
    meminfo.write_text("MemAvailable: 33554432 kB\nSwapTotal: 10485760 kB\nSwapFree: 9437184 kB\n")
    calm = perf.run(ctx("perf", Fake((["journalctl"], Result(1, "", ""))), meminfo=str(meminfo)))
    assert set(states(calm).values()) == {"ok"}


def test_perf_clears_stale_swap_itself_only_when_it_is_safe(tmp_path):
    """Swap full of old pages with memory free is cleared by the check (no warning). It only does so when switched
    on, with room to take the pages back and no memory stalls; otherwise it still warns."""
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemAvailable: 20971520 kB\nSwapTotal: 8388608 kB\nSwapFree: 524288 kB\n")  # 20 GiB free, 7.5 swapped
    psi = tmp_path / "psi"
    psi.write_text("some avg10=0.10 avg60=0.2 avg300=0.2 total=1\nfull avg10=0.00 avg60=0.0 avg300=0.0 total=0\n")

    def swap(acting, run=None, **over):
        c = ctx("perf", run or Fake((["swapoff"], Result(0)), (["swapon"], Result(0))), meminfo=str(meminfo), psi=str(psi), **over)
        c.acting = acting
        return c, perf.swap_while_free(c)

    c, sig = swap({"swap_clear": True})
    assert (sig.code, sig.state, sig.note) == ("perf.swap.cleared", "ok", True)
    assert [call[0] for call in c.run.calls] == [["swapoff", "-a"], ["swapon", "-a"]]
    # switched off: no action, the warning stays
    c, sig = swap({})
    assert (sig.code, sig.state) == ("perf.swap", "warn") and not c.run.calls
    # not enough memory beyond what swap holds, or memory stalls now: no action
    assert swap({"swap_clear": True}, swap_clear_headroom_gib=20.0)[1].state == "warn"
    psi.write_text("some avg10=12.00 avg60=1 avg300=1 total=1\n")
    c, sig = swap({"swap_clear": True})
    assert sig.state == "warn" and not c.run.calls
    psi.write_text("some avg10=0.10 avg60=0.2 avg300=0.2 total=1\n")
    # swapoff failed: warns, and swap is switched back on
    c, sig = swap({"swap_clear": True}, Fake((["swapoff"], Result(1, "", "busy")), (["swapon"], Result(0))))
    assert sig.state == "warn" and [call[0] for call in c.run.calls] == [["swapoff", "-a"], ["swapon", "-a"]]


def test_perf_unreadable_inputs_warn(tmp_path):
    out = perf.run(ctx("perf", Fake((["journalctl"], Result(2, "", "boom"))), meminfo=str(tmp_path / "none")))
    assert states(out) == {"perf.crash_loop.unreadable": "warn", "perf.swap.unreadable": "warn"}


# pve and ecc and thermal share one ssh answer

LVS = {"report": [{"lv": [{"lv_name": "data", "vg_name": "pve", "lv_attr": "twi-aotz--", "data_percent": "40.0", "metadata_percent": "3.0"}]}]}
VGS = {"report": [{"vg": [{"vg_name": "pve", "vg_size": "1000000000000B", "vg_free": "50000000000B"}]}]}


def pve_answer(lvs=LVS, vg_free="50000000000B", up=86400, failed="", smart_ok=True, running="6.8.1-pve", req="", ecc_text="FIRST 1700000000\n", ras="active", hwmon=""):
    smart = {"smart_status": {"passed": smart_ok}}
    return "\n".join(
        [
            "===NS lvs", json.dumps(lvs),
            "===NS vgs", json.dumps(VGS).replace("50000000000B", vg_free),
            "===NS failed", failed,
            "===NS smart", "DEV /dev/nvme0n1", json.dumps(smart),
            "===NS kernel", f"RUN {running}", f"UP {up}", f"K {int(NOW) - 5 * 86400} {running}", req,
            "===NS ecc", ecc_text,
            "===NS rasdaemon", ras,
            "===NS rasmce", "",
            "===NS hwmon", hwmon,
            "===NS mem", "MemAvailable:   25165824 kB",
            "===NS end",
        ]
    )  # fmt: skip


def pve_run(text=None, rc=0, err=""):
    return Fake((["bash"], Result(rc, text if text is not None else pve_answer(), err)))


def test_pve_healthy_sends_the_script_over_the_pinned_ssh_hop():
    run = pve_run()
    out = pve.run(ctx("pve", run))
    assert set(states(out).values()) == {"ok"}
    argv, stdin = run.calls[0]
    assert "root@192.168.86.39" in argv and "StrictHostKeyChecking=yes" in argv and stdin == pve.SCRIPT


def test_pve_full_pool_failed_units_bad_disk_and_old_reboot_request():
    lvs = {"report": [{"lv": [{"lv_name": "data", "vg_name": "pve", "lv_attr": "twi-aotz--", "data_percent": "95.0", "metadata_percent": "3.0"}]}]}
    text = pve_answer(lvs=lvs, vg_free="5000000000B", up=30 * 86400, failed="foo.service loaded failed failed Foo\n", smart_ok=False, req=f"REQ {int(NOW) - 20 * 86400}", ras="inactive")
    out = states(pve.run(ctx("pve", pve_run(text))))
    assert out["pve.thin.data"] == "failed" and out["pve.vg.free"] == "warn"
    assert out["pve.units.failed"] == "warn" and out["pve.smart"] == "failed"
    assert out["pve.reboot.required"] == "warn" and out["pve.rasdaemon"] == "warn"


def test_pve_unreachable_is_a_failed_row_for_pve_and_a_warning_for_the_others():
    down = pve_run("", rc=255, err="Connection timed out")
    assert states(pve.run(ctx("pve", down))) == {"pve.unreachable": "failed"}
    assert states(ecc.run(ctx("ecc", down))) == {"pve.unreachable": "warn"}
    assert states(thermal.run(ctx("thermal", down, hwmon_root="/nonexistent")))["thermal.unavailable"] == "warn"


def test_pve_keeps_the_offload_note_memctl_publishes(tmp_path):
    """While the PVE host answers, state offload names it with its free memory (memctl reads it, as it read
    Nightshift's perf finding); unreachable drops it, so memctl never offers a host it cannot reach."""
    state: dict = {}
    pve.run(ctx("pve", pve_run(), state=state))
    assert state["offload"] == {"host": "davion-gem", "mem_available_gib": 24.0}
    doc = {"checks": {"pve": state}}
    (tmp_path / "state.json").write_text(json.dumps(doc))
    assert memctl.read_offload(tmp_path / "state.json", 8 * 2**30) == "davion-gem"
    assert memctl.read_offload(tmp_path / "state.json", 32 * 2**30) is None
    pve.run(ctx("pve", pve_run("", rc=255, err="Connection timed out"), state=state))
    assert "offload" not in state


def test_pve_is_asked_once_per_run_for_all_three_checks(tmp_path):
    run = pve_run()
    shared = core.Ctx(cfg=DATA["checks"]["pve"], site=DATA["site"], now=NOW, run=run, state={})
    pve.run(shared)
    ecc.run(core.Ctx(cfg=DATA["checks"]["ecc"], site=DATA["site"], now=NOW, run=run, state={}, cache=shared.cache))
    assert len(run.calls) == 1


def ue_line(ts):
    return f"UE {ts} 0 0 0x1000 1\n"


def test_ecc_uncorrected_error_is_failed_and_corrected_ones_are_record_only():
    text = pve_answer(ecc_text=f"FIRST {int(NOW) - 8 * 86400}\n" + ue_line(NOW - 3600))
    out = ecc.run(ctx("ecc", pve_run(text)))
    assert states(out)["ecc.uncorrected"] == "failed"
    corrected = "".join(f"CE {NOW - 1000 - i * 60} 0 0 0x{i:x}000 1\n" for i in range(3))
    out = ecc.run(ctx("ecc", pve_run(pve_answer(ecc_text=f"FIRST {int(NOW) - 8 * 86400}\n" + corrected))))
    assert states(out)["ecc.uncorrected"] == "ok" and states(out)["ecc.corrected"] == "ok"
    row = core.make_row("ecc", out, DATA["checks"]["ecc"], DATA["meanings"], "m", NOW, DATA["caps"])
    assert row["state"] == "ok" and "recorded only" in row["meaning"]


def test_ecc_a_spike_over_the_baseline_and_a_new_region():
    first = int(NOW) - 8 * 86400
    quiet = "".join(f"CE {NOW - (i + 1) * 86400 - 60} 0 0 0x100000 1\n" for i in range(1, 6))
    burst = "".join(f"CE {NOW - 100 - i} 0 0 0x{(i % 2 + 5):x}00000 1\n" for i in range(0, 3 * 120, 3))
    out = states(ecc.run(ctx("ecc", pve_run(pve_answer(ecc_text=f"FIRST {first}\n" + quiet + burst)))))
    assert out["ecc.spike"] == "failed"
    signals = ecc.run(ctx("ecc", pve_run(pve_answer(ecc_text=f"FIRST {first}\n" + quiet + burst))))
    row = core.make_row("ecc", signals, DATA["checks"]["ecc"], DATA["meanings"], "m", NOW, DATA["caps"])
    assert row["state"] == "ok"
    assert "recorded only" in row["meaning"] and "non-ECC host" in row["meaning"]
    assert "Check the memory-error history" not in row["meaning"]
    assert "Run a memory test" not in row["meaning"]


def test_ecc_new_corrected_regions_remain_record_only():
    def at(now, *regions):
        lines = "".join(f"CE {now - 500 - i * 100 - j} 0 0 0x{r * 0x200000 + 0x1000 * j:x} 1\n" for i, r in enumerate(regions) for j in (0, 1))
        text = pve_answer(ecc_text=f"FIRST {int(now) - 8 * 86400}\n{lines}")
        return core.Ctx(cfg=DATA["checks"]["ecc"], site=DATA["site"], now=now, run=pve_run(text), state=state)

    state = {}
    assert "ecc.new_region" not in states(ecc.run(at(NOW, 1, 2)))
    assert states(ecc.run(at(NOW + 3600, 1, 2, 3)))["ecc.new_region"] == "ok"
    assert states(ecc.run(at(NOW + 7200, 1, 2, 3)))["ecc.new_region"] == "ok"
    assert "ecc.new_region" not in states(ecc.run(at(NOW + 80 * 3600, 1, 2, 3)))


def sensors_text(cpu_c, nvme_c=40):
    return (
        f"T k10temp Tctl {cpu_c * 1000} 0 0\nT nvme Composite {nvme_c * 1000} 84850 94850\nT amdgpu edge 40000 0 0\n"
    )


def hwmon_tree(tmp_path, cpu_c):
    hw = tmp_path / "hwmon0"
    hw.mkdir(parents=True)
    (hw / "name").write_text("k10temp\n")
    (hw / "temp1_input").write_text(f"{cpu_c * 1000}\n")
    (hw / "temp1_label").write_text("Tctl\n")
    return str(tmp_path)


def test_thermal_hot_on_two_passes_warns_and_critical_fails(tmp_path):
    state = {}
    gone = Fake((["nvidia-smi"], Result(127, "", "")), (["bash"], Result(0, pve_answer(hwmon=sensors_text(50)), "")))
    root = hwmon_tree(tmp_path, 90)
    first = thermal.run(ctx("thermal", gone, state=state, hwmon_root=root))
    assert states(first)["thermal.hot"] == "ok"
    second = thermal.run(ctx("thermal", gone, state=state, hwmon_root=root))
    assert next(s for s in second if s.fields.get("host") == "Workstation").state == "warn"
    hot_root = hwmon_tree(tmp_path / "hot", 99)
    crit = thermal.run(ctx("thermal", gone, state={}, hwmon_root=hot_root))
    assert next(s for s in crit if s.fields.get("host") == "Workstation").state == "failed"


def test_thermal_reads_nvidia_and_flags_a_gpu_slowdown():
    smi = Result(0, "NVIDIA RTX, 97, Not Active, Not Active\n", "")
    gone = Fake((["nvidia-smi"], smi), (["bash"], Result(255, "", "down")))
    out = thermal.run(ctx("thermal", gone, hwmon_root="/nonexistent"))
    assert out[0].state == "failed" and "GPU 97C" in out[0].fields["sensors"]


# backups


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))
    return path


@pytest.mark.parametrize(
    ("row", "verdict"),
    [
        ({"state": "ok", "last_run": NOW - 600}, "ok"),
        ({"state": "failed", "last_run": NOW - 600}, "failed"),
        ({"state": "ok", "last_run": NOW - 3 * 3600}, "warn"),
        ({"state": "ok"}, "warn"),
        ({"state": "off", "last_run": NOW - 600}, "warn"),
        ({"state": "ok", "shown": "unknown", "last_run": NOW - 600}, "warn"),
    ],
)
def test_backups_snapshot_job_health(row, verdict, tmp_path):
    row = {"id": "jobs/backups-snapshots", **row}
    run = Fake((["curl"], Result(0, json.dumps({"rows": [row]}))))
    assert states(backups.autosnap(ctx("backups", run=run), str(tmp_path))) == {"backups.autosnap": verdict}


@pytest.mark.parametrize("result", [Result(1), Result(0, "not-json"), Result(0, '{"rows": []}'), Result(0, '{"rows": [{"id":"other", "state":"ok"}]}')])
def test_backups_snapshot_job_missing_is_unknown_not_healthy(result, tmp_path):
    run = Fake((["curl"], result))
    assert states(backups.autosnap(ctx("backups", run=run), str(tmp_path))) == {"backups.autosnap": "warn"}


def test_backups_snapshots_follow_aico_job_not_retired_sweep(tmp_path):
    write(tmp_path / ".local/share/st/snaps/autosnap-state.json", {"last_sweep_at": NOW - 99 * 3600})
    row = {"id": "jobs/backups-snapshots", "state": "ok", "shown": "ok", "last_run": NOW - 600}
    run = Fake((["curl"], Result(0, json.dumps({"rows": [row]}))))
    assert states(backups.autosnap(ctx("backups", run=run), str(tmp_path))) == {"backups.autosnap": "ok"}


def test_backups_unknown_owner_is_one_warning():
    site = {**DATA["site"], "owner": {"user": "no-such-user-xyz"}}
    assert states(backups.run(ctx("backups", site=site))) == {"backups.owner": "warn"}


def aico_backup_health():
    return {
        "entries": [{"id": "drive/" + source, "source": source, "target": "drive",
                     "state": "ok", "dataAt": NOW - 3600, "snapshot": "restorable-copy"}
                    for source in DATA["site"]["pve"]["backup_required_targets"]] + [
                         {"id": "native/" + source, "source": source, "target": "native", "state": "ok",
                          "dataAt": NOW - 3600, "snapshot": "local-point", "path": "/backup/point"}
                         for source in ["root-volume", "home", "srv-workspaces", "var-lib-docker", "srv-models", "var-log"]],
        "runs": {"drive": {"ok": True, "finished": NOW - 3600}, "native": {"ok": True, "finished": NOW - 3600}},
    }


def aico_backup_runner(data):
    fleet = {"owners": [{
        "machine": "davion-sidarli", "repository": "workstation-repository", "state": "read",
        "sources": DATA["site"]["pve"]["backup_required_targets"],
        "entries": data.get("entries", []), "retained": [], "runs": data.get("runs", {}),
    }]}
    if not data.get("entries"):
        fleet["owners"][0]["state"] = "unknown"
    return Fake(
        (["--fleet"], Result(0, json.dumps(fleet))),
        (["http://127.0.0.1:3002/api/backups"], Result(0, json.dumps(data))),
        (["http://127.0.0.1:3002/api/status?q=backups-drill"], Result(0, json.dumps({"rows": [
            {"id": "jobs/backups-drill", "state": "ok", "last_run": NOW - 600}]}))),
        (["http://127.0.0.1:3002/api/status?q=backups-snapshots"], Result(0, json.dumps({"rows": [
            {"id": "jobs/backups-snapshots", "state": "ok", "last_run": NOW - 600}]}))),
    )


def test_backups_moved_sources_keep_verified_coverage_in_the_previous_repository(tmp_path):
    data = aico_backup_health()
    drive = [e for e in data["entries"] if e["target"] == "drive"]
    data["entries"] = [e for e in data["entries"] if e["target"] != "drive"]
    fleet = {"owners": [
        {"machine": "davion-sidarli", "repository": "previous-repository", "state": "read",
         "sources": [], "entries": [], "retained": drive, "runs": data["runs"]},
        {"machine": "aico", "repository": "current-repository", "state": "read",
         "sources": [e["source"] for e in drive],
         "entries": [{**e, "dataAt": None, "snapshot": None, "state": "warn"} for e in drive],
         "retained": [], "runs": data["runs"]},
    ]}
    runner = aico_backup_runner(data)
    runner.rules = ((["fleet-backups-fixture"], Result(0, json.dumps(fleet))), *runner.rules)
    out = backups.run(ctx("backups", run=runner, fleet_status_command=["fleet-backups-fixture"], native_config=str(tmp_path / "absent")))
    assert states(out)["backups.pve"] == "ok"
    assert states(out)["backups.native"] == "ok"


@pytest.mark.parametrize("owner_state,with_retained,coverage,run_state", [
    ("read", True, "ok", "failed"),
    ("unknown", True, "ok", "warn"),
    ("unknown", False, "warn", "warn"),
])
def test_backups_coverage_and_owner_run_health_are_independent(owner_state, with_retained, coverage, run_state):
    data = aico_backup_health()
    drive = [e for e in data["entries"] if e["target"] == "drive"]
    fleet = {"owners": [
        {"machine": "davion-sidarli", "repository": "previous-repository", "state": "read",
         "sources": [], "entries": [], "retained": drive if with_retained else [], "runs": data["runs"]},
        {"machine": "aico", "repository": "current-repository", "state": owner_state,
         "sources": [e["source"] for e in drive], "entries": drive if with_retained else [], "retained": [],
         "runs": {"drive": {"ok": False, "finished": NOW - 600}}},
    ]}
    runner = aico_backup_runner(data)
    runner.rules = ((["--fleet"], Result(0, json.dumps(fleet))), *runner.rules)
    out = states(backups.run(ctx("backups", run=runner)))
    assert out["backups.pve"] == coverage
    assert out["backups.drive"] == run_state
    assert out["backups.native"] == "ok"


def test_backups_unread_local_api_does_not_hide_readable_fleet_coverage():
    runner = aico_backup_runner(aico_backup_health())
    runner.rules = ((["http://127.0.0.1:3002/api/backups"], Result(1)), *runner.rules)
    out = states(backups.run(ctx("backups", run=runner)))
    assert out["backups.sources"] == out["backups.native"] == "warn"
    assert out["backups.pve"] == out["backups.drive"] == "ok"


def test_backups_unread_fleet_does_not_change_local_native_health():
    data = aico_backup_health()
    data["runs"]["native"]["ok"] = False
    runner = aico_backup_runner(data)
    runner.rules = ((["--fleet"], Result(1)), *runner.rules)
    out = states(backups.run(ctx("backups", run=runner)))
    assert out["backups.pve"] == out["backups.drive"] == "warn"
    assert out["backups.native"] == "failed"


@pytest.mark.parametrize("shown,kind,expected", [
    ("off", "machine", "ok"),
    ("unknown", "machine", "warn"),
    ("ok", "machine", "warn"),
    ("off", "backup", "warn"),
])
def test_backups_unread_owner_that_status_verifies_off_is_not_a_run_problem(shown, kind, expected):
    data = aico_backup_health()
    drive = [e for e in data["entries"] if e["target"] == "drive"]
    fleet = {"owners": [
        {"machine": "davion-sidarli", "repository": "previous-repository", "state": "read",
         "sources": [], "entries": [], "retained": drive, "runs": data["runs"]},
        {"machine": "aico", "repository": "current-repository", "state": "unknown",
         "sources": [e["source"] for e in drive]},
    ]}
    runner = aico_backup_runner(data)
    runner.rules = (
        (["--fleet"], Result(0, json.dumps(fleet))),
        (["machine-status-fixture"], Result(0, json.dumps({"rows": [
            {"machine": "aico", "kind": kind, "state": "failed", "shown": shown}]}))),
        *runner.rules,
    )
    out = states(backups.run(ctx("backups", run=runner, machine_status_command=["machine-status-fixture"])))
    assert out["backups.pve"] == "ok"
    assert out["backups.drive"] == expected


def test_backups_follow_aico_after_retired_receipt_writers_stop(tmp_path, monkeypatch):
    monkeypatch.setattr(backups.pwd, "getpwnam", lambda owner: type("Owner", (), {"pw_dir": str(tmp_path), "pw_uid": tmp_path.stat().st_uid}))
    old = tmp_path / ".local/state/summitflow"
    write(old / "backup-freshness/sources.json", {"generated_at": NOW - 9 * 3600})
    write(old / "backup-freshness/proxmox.json", {"schema_version": 1, "generated_at": NOW - 9 * 3600})
    write(old / "backup-health/old.json", {"ok": False})
    site = {**DATA["site"], "pve": {**DATA["site"]["pve"], "backup_receipt": str(old / "backup-freshness/proxmox.json")}}
    out = backups.run(ctx("backups", run=aico_backup_runner(aico_backup_health()), site=site, native_config=str(tmp_path / "absent")))
    assert out and set(states(out).values()) == {"ok"}


@pytest.mark.parametrize("change,source_state,pve_state,drive_state", [
    (lambda d: d["entries"][0].update(state="failed"), "failed", "failed", "failed"),
    (lambda d: d["entries"][0].update(state="warn"), "warn", "warn", "ok"),
    (lambda d: d["entries"][0].update(state="unknown"), "warn", "warn", "ok"),
    (lambda d: d["entries"][0].update(dataAt=None), "warn", "warn", "ok"),
    (lambda d: d["entries"][0].update(dataAt=NOW + 3600), "warn", "warn", "ok"),
    (lambda d: d["entries"][0].update(snapshot=None), "ok", "failed", "ok"),
    (lambda d: d["entries"][0].update(target="native"), "ok", "failed", "ok"),
    (lambda d: d["entries"].pop(0), "ok", "failed", "ok"),
    (lambda d: d["runs"]["drive"].update(ok=False), "ok", "ok", "failed"),
    (lambda d: d["runs"]["drive"].update(finished=NOW - 37 * 3600), "ok", "ok", "warn"),
    (lambda d: d["runs"]["drive"].update(finished=NOW + 3600), "ok", "ok", "warn"),
    (lambda d: d["runs"].pop("drive"), "ok", "ok", "warn"),
])
def test_backups_live_entries_keep_failures_unknown_age_and_offsite_checks(change, source_state, pve_state, drive_state, tmp_path):
    data = aico_backup_health()
    change(data)
    out = states(backups.run(ctx("backups", run=aico_backup_runner(data), native_config=str(tmp_path / "absent"))))
    assert out["backups.sources"] == source_state and out["backups.pve"] == pve_state
    assert out["backups.drive"] == drive_state


@pytest.mark.parametrize("data", [{}, {"entries": []}, {"entries": [None]}, {"entries": "unknown"}])
def test_backups_missing_live_health_is_unknown_not_zero(data, tmp_path):
    out = states(backups.run(ctx("backups", run=aico_backup_runner(data), native_config=str(tmp_path / "absent"))))
    assert out["backups.sources"] == out["backups.pve"] == "warn"


def test_backups_offline_unchanged_age_is_computed_by_owning_live_api(tmp_path):
    data = aico_backup_health()
    # Aico's owning view computed OK from the recorded offlineSince state, not a refreshed artifact time.
    data["entries"][0]["dataAt"] = NOW - 10 * 86400
    out = states(backups.run(ctx("backups", run=aico_backup_runner(data), native_config=str(tmp_path / "absent"))))
    assert set(out.values()) == {"ok"}


def test_backups_a_copy_of_a_machine_that_was_off_is_not_behind(tmp_path):
    data = aico_backup_health()
    for entry in data["entries"]:
        entry.update(state="off", dataAt=NOW - 60 * 86400)
    data["entries"].append({"id": "drive/running", "source": "running", "target": "drive", "state": "ok", "dataAt": NOW})
    out = states(backups.run(ctx("backups", run=aico_backup_runner(data), native_config=str(tmp_path / "absent"))))
    assert out["backups.sources"] == out["backups.pve"] == "ok"
    assert out["backups.native"] == "ok"


def test_backups_a_failed_copy_of_a_running_machine_still_fails(tmp_path):
    data = aico_backup_health()
    data["entries"][0].update(state="failed")
    out = states(backups.run(ctx("backups", run=aico_backup_runner(data), native_config=str(tmp_path / "absent"))))
    assert out["backups.sources"] == "failed"


def test_backups_native_follows_aico_not_unwritten_host_receipts(tmp_path, monkeypatch):
    monkeypatch.setattr(backups.pwd, "getpwnam", lambda owner: type("Owner", (), {"pw_dir": str(tmp_path), "pw_uid": tmp_path.stat().st_uid}))
    root = tmp_path / ".local/state/summitflow/host-recovery"
    write(root / "latest.json", {"status": "completed"})
    write(root / "last-good.json", {"status": "completed", "capture_complete": True, "artifacts_complete": True,
                                  "points": [{}], "finished_at": NOW - 70 * 3600})
    config = tmp_path / "btrbk.conf"
    config.touch()
    out = states(backups.run(ctx("backups", run=aico_backup_runner(aico_backup_health()), native_config=str(config))))
    assert out["backups.native"] == "ok"


def test_backups_run_cut_short_by_a_shutdown_is_not_a_failed_run(tmp_path):
    # Back from a reboot: the receipt has no end, and no new run has taken the lease yet.
    data = aico_backup_health()
    data["runs"]["drive"] = {"ok": False, "started": NOW - 600}
    out = states(backups.run(ctx("backups", run=aico_backup_runner(data), native_config=str(tmp_path / "absent"))))
    assert out["backups.pve"] == "ok"
    # One that never comes back does show, as a run that hasn't finished lately.
    data["runs"]["drive"] = {"ok": False, "started": NOW - 37 * 3600}
    out = states(backups.run(ctx("backups", run=aico_backup_runner(data), native_config=str(tmp_path / "absent"))))
    assert out["backups.drive"] == "warn"


def test_backups_running_drive_uses_last_verified_copies(tmp_path):
    data = aico_backup_health()
    data["runs"]["drive"] = {"ok": False, "started": NOW - 60}
    for entry in data["entries"]:
        if entry["target"] == "drive":
            entry["running"] = True
    out = states(backups.run(ctx("backups", run=aico_backup_runner(data), native_config=str(tmp_path / "absent"))))
    assert out["backups.pve"] == "ok"


@pytest.mark.parametrize("override,expected", [
    ({"dataAt": NOW - 40 * 3600}, "warn"),
    ({"dataAt": NOW - 70 * 3600}, "failed"),
    ({"dataAt": None}, "warn"),
    ({"state": "failed"}, "failed"),
    ({"snapshot": None}, "failed"),
    ({"path": None}, "failed"),
])
def test_backups_native_keeps_received_point_and_age_requirements(override, expected, tmp_path):
    data = aico_backup_health()
    next(e for e in data["entries"] if e["target"] == "native").update(override)
    out = states(backups.run(ctx("backups", run=aico_backup_runner(data))))
    assert out["backups.native"] == expected


def test_backups_native_requires_all_volumes_and_successful_run():
    data = aico_backup_health()
    data["entries"] = [e for e in data["entries"] if e["source"] != "srv-workspaces"]
    out = states(backups.run(ctx("backups", run=aico_backup_runner(data))))
    assert out["backups.native"] == "failed"
    data = aico_backup_health()
    data["runs"]["native"]["ok"] = False
    out = states(backups.run(ctx("backups", run=aico_backup_runner(data))))
    assert out["backups.native"] == "failed"


@pytest.mark.parametrize("result", [Result(1), Result(0, "not-json"), Result(0, '{"rows": []}'),
                                      Result(0, json.dumps({"rows": [{"id": "jobs/backups-drill", "state": "failed", "last_run": NOW}]}))])
def test_backups_restore_drill_cannot_be_hidden_by_healthy_copies(result, tmp_path):
    run = aico_backup_runner(aico_backup_health())
    run.rules = ((["http://127.0.0.1:3002/api/status?q=backups-drill"], result), *run.rules)
    out = states(backups.run(ctx("backups", run=run, native_config=str(tmp_path / "absent"))))
    assert out["backups.drill"] == ("failed" if '"failed"' in result.out else "warn")


# journal


def test_journal_corrupt_files_warn_after_the_keep_days_and_are_noted_before():
    err = "Journal file /var/log/journal/x/system@1.journal corrupted or uncleanly shut down, ignoring file.\n"
    err = err.replace("corrupted or uncleanly shut down, ", "is truncated, ")
    state = {}
    first = journal.run(ctx("journal", Fake((["journalctl"], Result(0, "", err))), state=state))
    assert first[0].state == "ok" and first[0].note and first[0].fields["n"] == 1
    late = core.Ctx(cfg=DATA["checks"]["journal"], site=DATA["site"], now=NOW + 8 * 86400, run=Fake((["journalctl"], Result(0, "", err))), state=state)
    assert journal.run(late)[0].state == "warn"
    clean = journal.run(ctx("journal", Fake((["journalctl"], Result(0, "", ""))), state={}))
    assert clean[0].state == "ok" and not clean[0].note
    assert journal.run(ctx("journal", Fake((["journalctl"], Result(1, "", "no access")))))[0].code == "journal.unreadable"


# gates


@pytest.mark.parametrize(
    ("status", "location", "verdict"),
    [
        (302, "https://team.cloudflareaccess.com/cdn-cgi/access/login/x", "ok"),
        (401, "", "ok"),
        (403, "", "ok"),
        (200, "", "open"),
        (500, "", "odd"),
        (302, "https://evil.example/", "odd"),
    ],
)
def test_gates_judge(status, location, verdict):
    assert gates.judge(status, location)[1] == verdict


def test_gates_run_maps_open_closed_and_unreachable(monkeypatch):
    monkeypatch.setattr(gates, "router_address", lambda name, server: "203.0.113.5")
    monkeypatch.setattr(gates, "anonymous_get", lambda name, ip, path: (200, ""))
    assert states(gates.run(ctx("gates"))) == {"gates.app": "failed"}
    monkeypatch.setattr(gates, "anonymous_get", lambda name, ip, path: (401, ""))
    assert states(gates.run(ctx("gates"))) == {"gates.app": "ok"}

    def refuse(name, ip, path):
        raise ConnectionRefusedError

    monkeypatch.setattr(gates, "anonymous_get", refuse)
    assert states(gates.run(ctx("gates"))) == {"gates.app": "warn"}
    assert states(gates.run(ctx("gates", apps=[{"app": "X", "host": "bad host", "path": "/"}]))) == {"gates.app": "warn"}


def test_gates_router_address_refuses_a_local_answer(monkeypatch):
    def answer(ip):
        header = b"\x00\x00\x81\x80\x00\x01\x00\x01\x00\x00\x00\x00"
        question = b"\x01a\x03com\x00\x00\x01\x00\x01"
        return header + question + b"\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x3c\x00\x04" + bytes(map(int, ip.split(".")))

    class Sock:
        reply = b""

        def __init__(self, *a):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def settimeout(self, t):
            pass

        def sendto(self, data, addr):
            self.qid = data[:2]

        def recv(self, n):
            return self.qid + self.reply[2:]

    for ip, public in (("203.0.113.9", False), ("8.8.8.8", True), ("192.168.1.5", False)):
        Sock.reply = answer(ip)
        monkeypatch.setattr(gates.socket, "socket", Sock)
        if public:
            assert gates.router_address("a.com", "192.168.86.1") == ip
        else:
            with pytest.raises(OSError):
                gates.router_address("a.com", "192.168.86.1")


# ominull lock


def lock_files(tmp_path, ceiling="engagement", roles=("tap", "auto"), packages=2):
    (tmp_path / "ceiling").write_text(ceiling + "\n")
    (tmp_path / "authority").write_text(json.dumps({"keys": [{"role": r} for r in roles]}))
    (tmp_path / "allow").write_text(json.dumps({"packages": ["a"] * packages}))
    return {"ceiling_file": str(tmp_path / "ceiling"), "authority_file": str(tmp_path / "authority"), "allow_file": str(tmp_path / "allow")}


def test_ominull_lock_matches_differs_or_is_unset(tmp_path):
    files = lock_files(tmp_path)
    ok = ominull_lock.run(ctx("ominull-lock", **files))[0]
    assert ok.state == "ok" and ok.fields["scripts"] == "signed scripts on, 2 packages without a tap"
    assert ominull_lock.run(ctx("ominull-lock", **files, expected_ceiling="monitor"))[0].code == "ominull.lock.differs"
    none = ominull_lock.run(ctx("ominull-lock", ceiling_file=str(tmp_path / "gone"), authority_file="/none", allow_file="/none", expected_ceiling=""))[0]
    assert none.state == "ok" and none.note and none.fields["scripts"] == "signed scripts off"
    bad = lock_files(tmp_path, ceiling="Not A Level!")
    assert ominull_lock.run(ctx("ominull-lock", **bad))[0].fields["ceiling"] == "none"


# router drift

DRIFT = {
    "v": 1, "mode": "drift", "glversion": "4.8", "openwrt": "23.05", "kernel": "5.15", "h_keys": "aaa", "h_dropbear": "bbb",
    "h_forwards": "ccc", "h_upnp": "ddd", "h_rc": "eee", "services": {"dnsmasq": [1, 1]}, "parental_groups": 0,
    "parental_module": 1, "parental_enable": 1,
}  # fmt: skip


def router_run(data=None, rc=0, err=""):
    return Fake((["drift"], Result(rc, json.dumps(data) if data is not None else "", err)))


def test_router_first_run_baselines_silently_then_a_change_is_held():
    state = {}
    first = router.run(ctx("router-drift", router_run(DRIFT), state=state))
    assert states(first) == {"router.drift.none": "ok"} and state["baseline"]["keys"] == "aaa"
    later = core.Ctx(cfg=DATA["checks"]["router-drift"], site=DATA["site"], now=NOW + 3600, run=router_run({**DRIFT, "h_keys": "zzz", "h_upnp": "yyy"}), state=state)
    sig = {s.fields["what"]: s.state for s in router.run(later)}
    assert sig == {"SSH login keys": "failed", "UPnP settings": "warn"}


def test_router_change_stops_counting_after_the_hold_window():
    state = {}
    router.run(ctx("router-drift", router_run(DRIFT), state=state))
    router.run(core.Ctx(cfg=DATA["checks"]["router-drift"], site={}, now=NOW + 60, run=router_run({**DRIFT, "h_upnp": "yyy"}), state=state))
    after = core.Ctx(cfg=DATA["checks"]["router-drift"], site={}, now=NOW + 60 + 25 * 3600, run=router_run({**DRIFT, "h_upnp": "yyy"}), state=state)
    assert states(router.run(after)) == {"router.drift.none": "ok"}


def test_router_firmware_change_is_a_noted_ok():
    state = {}
    router.run(ctx("router-drift", router_run(DRIFT), state=state))
    later = core.Ctx(cfg=DATA["checks"]["router-drift"], site={}, now=NOW + 60, run=router_run({**DRIFT, "glversion": "4.9"}), state=state)
    out = router.run(later)
    assert out[0].state == "ok" and out[0].note


def test_router_refused_key_is_remembered_and_not_retried_for_six_hours():
    state = {}
    run = router_run(None, rc=255, err="root@192.168.86.1: Permission denied (publickey).")
    assert states(router.run(ctx("router-drift", run, state=state))) == {"router.key_missing": "warn"}
    again = router_run(DRIFT)
    soon = core.Ctx(cfg=DATA["checks"]["router-drift"], site={}, now=NOW + 3600, run=again, state=state)
    assert states(router.run(soon)) == {"router.key_missing": "warn"} and again.calls == []
    later = core.Ctx(cfg=DATA["checks"]["router-drift"], site={}, now=NOW + 7 * 3600, run=again, state=state)
    assert states(router.run(later)) == {"router.drift.none": "ok"} and "denied" not in state


@pytest.mark.parametrize(
    ("rc", "err", "out", "code"),
    [
        (255, "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED", "", "router.host_key_changed"),
        (127, "", "", "router.script_missing"),
        (255, "", '{"error":"source"}', "router.source_rejected"),
    ],
)
def test_router_failure_kinds(rc, err, out, code):
    assert router.classify_failure(Result(rc, out, err)) == code


def test_router_unreachable_counts_minutes_and_bad_output_is_a_warning():
    state = {}
    timeout = Fake((["drift"], Result(124, "", "timed out")))
    assert router.run(ctx("router-drift", timeout, state=state))[0].fields["minutes"] == 0
    later = core.Ctx(cfg=DATA["checks"]["router-drift"], site={}, now=NOW + 1800, run=timeout, state=state)
    assert router.run(later)[0].fields["minutes"] == 30
    assert states(router.run(ctx("router-drift", Fake((["drift"], Result(0, "not json", ""))), state={}))) == {"router.bad_output": "warn"}
