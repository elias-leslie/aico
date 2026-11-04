"""Probes check (NVIDIA modules, agent Chrome) and the journal signature miner, on fixture inputs."""

from __future__ import annotations

import json
from datetime import UTC, datetime

from host_steward import core, journal_miner
from host_steward.checks import journal, probes

DATA = core.load_data()
NOW = 1_800_000_000.0
Result = core.Result


class Fake:
    def __init__(self, *rules):
        self.rules, self.calls = rules, []

    def __call__(self, argv, timeout=60, input_text=None):
        self.calls.append(list(argv))
        for words, result in self.rules:
            if all(word in argv for word in words):
                return result
        return Result(127, "", "not found")


def ctx(check, run=None, state=None, **over):
    cfg = {**DATA["checks"][check], **over}
    return core.Ctx(cfg=cfg, site=DATA["site"], now=NOW, run=run or Fake(), state=state if state is not None else {})


DPKG = (
    "nvidia-driver-595-open ii \n"
    "linux-image-6.8.0-147-generic ii \n"
    "linux-image-6.17.0-30-generic ii \n"
    "linux-modules-nvidia-595-open-6.17.0-30-generic ii \n"
)


def nvidia_ctx(tmp_path, dpkg=DPKG, running="6.17.0-30-generic", **over):
    run = Fake((["dpkg-query"], Result(0, dpkg, "")), (["uname"], Result(0, running + "\n", "")), (["ps"], Result(0, "", "")))
    return ctx("probes", run, modules_root=str(tmp_path / "modules"), fallbacks_file="", **over)


# nvidia


def test_nvidia_old_fallback_kernel_without_a_module_is_a_note(tmp_path):
    signal = probes.nvidia(nvidia_ctx(tmp_path))
    assert (signal.code, signal.state, signal.note) == ("probes.nvidia.fallback", "ok", True)
    assert "6.8.0-147-generic" in signal.fields["kernels"]


def test_nvidia_newest_or_running_kernel_without_a_module_fails(tmp_path):
    dpkg = DPKG.replace("linux-modules-nvidia-595-open-6.17.0-30-generic ii \n", "")
    signal = probes.nvidia(nvidia_ctx(tmp_path, dpkg))
    assert (signal.code, signal.state) == ("probes.nvidia.missing", "failed")
    assert signal.fields["package"] == "linux-modules-nvidia-595-open-6.17.0-30-generic"


def test_nvidia_a_built_module_under_lib_modules_counts(tmp_path):
    dpkg = DPKG.replace("linux-modules-nvidia-595-open-6.17.0-30-generic ii \n", "")
    for kver in ("6.8.0-147-generic", "6.17.0-30-generic"):
        built = tmp_path / "modules" / kver / "updates"
        built.mkdir(parents=True)
        (built / "nvidia.ko.zst").write_text("")
    assert probes.nvidia(nvidia_ctx(tmp_path, dpkg)).code == "probes.nvidia"


def test_nvidia_no_driver_is_fine(tmp_path):
    signal = probes.nvidia(nvidia_ctx(tmp_path, "linux-image-6.17.0-30-generic ii \n"))
    assert signal.state == "ok" and not signal.note


# browser

AGENT = "100 2097152 /opt/google/chrome/chrome --remote-debugging-port=0 --user-data-dir=/s/1\n"
RENDERER = "101 1048576 /opt/google/chrome/chrome --type=renderer --user-data-dir=/s/1\n"
DESKTOP = "102 9999999 /opt/google/chrome/chrome --profile-directory=Default\n"


def test_agent_chromes_counts_agent_browsers_and_their_children_only():
    assert probes.agent_chromes(AGENT + RENDERER + DESKTOP) == (1, 2097152 + 1048576)
    assert probes.agent_chromes(DESKTOP) == (0, 0)


def test_browser_small_local_chrome_is_a_note_and_large_or_persistent_warns(tmp_path):
    log = tmp_path / "fallbacks.jsonl"
    fresh = json.dumps({"at_ms": (NOW - 60) * 1000})
    log.write_text((fresh + "\n") * 3)
    run = Fake((["ps"], Result(0, AGENT, "")))
    signal = probes.browser(ctx("probes", run, fallbacks_file=str(log)))
    assert (signal.state, signal.note, signal.fields["recent"]) == ("ok", True, 3)
    big = Fake((["ps"], Result(0, AGENT + RENDERER, "")))
    assert probes.browser(ctx("probes", big, fallbacks_file="")).state == "warn"
    log.write_text((fresh + "\n") * 10)
    assert probes.browser(ctx("probes", Fake((["ps"], Result(0, "", ""))), fallbacks_file=str(log))).state == "warn"


def test_browser_old_fallbacks_and_nothing_running_are_quiet(tmp_path):
    log = tmp_path / "fallbacks.jsonl"
    log.write_text(json.dumps({"at_ms": (NOW - 90000) * 1000}) + "\nnot json\n")
    signal = probes.browser(ctx("probes", Fake((["ps"], Result(0, DESKTOP, ""))), fallbacks_file=str(log)))
    assert signal.state == "ok" and not signal.note


def test_stopped_spans_follow_stop_and_start_tasks():
    detail = {
        "guests": [{"name": "st-browser", "vmid": 120, "status": "running"}],
        "tasks": {"120": [{"action": "stop", "ok": True, "ts": 1000}, {"action": "start", "ok": True, "ts": 2000}]},
    }
    assert probes.stopped_spans(detail, "st-browser", 5000.0, 4000.0) == [(1000.0, 2000.0)]
    assert probes.stopped_spans(detail, "other", 5000.0) == []
    assert probes.stopped_spans(None, "st-browser", 5000.0) == []
    detail["tasks"]["120"] = [{"action": "stop", "ok": True, "ts": 1000}]
    detail["guests"][0]["status"] = "stopped"
    assert probes.stopped_spans(detail, "st-browser", 9000.0, 4000.0) == [(1000.0, 7600.0)]


def test_fallbacks_while_the_browser_vm_was_off_do_not_warn(tmp_path, monkeypatch):
    state_dir = tmp_path / "host-steward"
    state_dir.mkdir()
    detail = {
        "guests": [{"name": "st-browser", "vmid": 120, "status": "stopped"}],
        "tasks": {"120": [{"action": "stop", "ok": True, "ts": NOW - 7200}]},
    }
    (state_dir / "pve-guests.json").write_text(json.dumps({"seen": NOW - 60, "details": detail}))
    log = tmp_path / "fallbacks.jsonl"
    log.write_text((json.dumps({"at_ms": (NOW - 600) * 1000}) + "\n") * 12)
    signal = probes.browser(ctx("probes", Fake((["ps"], Result(0, "", ""))), fallbacks_file=str(log)))
    assert signal.state == "ok" and signal.fields["recent"] == 0 and "12 while" in signal.fields["off"]


# journal signatures


def entry(message, ident="app", cursor="c1", ts=NOW, priority=4, **extra):
    return json.dumps(
        {"MESSAGE": message, "SYSLOG_IDENTIFIER": ident, "__CURSOR": cursor, "__REALTIME_TIMESTAMP": str(int(ts * 1e6)), "PRIORITY": str(priority), **extra}
    )


def journal_run(*lines, rc=0):
    return Fake((["--after-cursor"], Result(rc, "\n".join(lines), "")), (["-p"], Result(rc, "\n".join(lines), "")), (["journalctl"], Result(0, "", "")))


def sig_ctx(run, tmp_path, **over):
    base = {"adopt_from": "", **over}
    return ctx("journal", run, **base)


def test_miner_generalizes_numbers_into_one_cluster_with_a_stable_id():
    miner = journal_miner.Miner()
    when = datetime.fromtimestamp(NOW, UTC)
    first = miner.add("sshd", "Failed password for root from 10.0.0.1 port 22", when)
    again = miner.add("sshd", "Failed password for root from 10.0.0.9 port 2200", when)
    assert first is again and again.count == 2
    assert miner.add("sshd", "Something else entirely different here now", when) is not first


def test_container_output_and_empty_messages_are_not_counted():
    miner = journal_miner.Miner()
    lines = [entry("boom", CONTAINER_ID="abc"), entry(""), "not json", entry("host warning one")]
    n, cursor = journal_miner.ingest(miner, lines)
    assert n == 1 and len(miner.clusters()) == 1 and cursor


def test_signatures_the_first_run_is_the_baseline_then_new_unlabeled_is_a_note_and_known_noise_is_not(tmp_path):
    first = journal.signatures(sig_ctx(journal_run(entry("an old complaint about widgets", ident="widget")), tmp_path))
    assert first.fields["new"] == 0 and not first.note  # everything seen on the first run is history
    run = journal_run(
        entry("a brand new complaint about frobnicators", ident="frob", ts=NOW + 600),
        entry("pam_systemd(sudo:session): Failed to release session: Access denied", ident="sudo", cursor="c2", ts=NOW + 600),
    )
    later = core.Ctx(cfg={**DATA["checks"]["journal"], "adopt_from": ""}, site=DATA["site"], now=NOW + 3600, run=run, state={})
    signal = journal.signatures(later)
    assert (signal.code, signal.state, signal.note) == ("journal.signatures", "ok", True)
    assert signal.fields["new"] == 1 and signal.fields["ingested"] == 2
    report = json.loads((core.STATE_PATH.parent / "journal-signatures.json").read_text())
    assert [r["ident"] for r in report["new_unlabeled"]] == ["frob"]


def test_signatures_second_run_continues_from_the_cursor_and_an_old_cluster_is_not_new(tmp_path):
    journal.signatures(sig_ctx(journal_run(entry("a complaint about frobnicators", ident="frob", cursor="c9")), tmp_path))
    run = journal_run()
    later = core.Ctx(cfg={**DATA["checks"]["journal"], "adopt_from": ""}, site=DATA["site"], now=NOW + 3 * 86400, run=run, state={})
    signal = journal.signatures(later)
    assert signal.fields["new"] == 0 and not signal.note and signal.fields["tracked"] == 1
    assert any("--after-cursor" in call and "c9" in call for call in run.calls)


def test_signatures_a_cursor_journald_lost_falls_back_to_the_initial_window(tmp_path):
    journal.signatures(sig_ctx(journal_run(entry("first complaint", cursor="gone")), tmp_path))

    def run(argv, timeout=60, input_text=None):
        if "--after-cursor" in argv:
            return Result(1, "", "Failed to seek to cursor")
        return Result(0, entry("second complaint", ident="x", cursor="c5"), "")

    signal = journal.signatures(sig_ctx(run, tmp_path))
    assert signal.fields["ingested"] == 1


def test_signatures_first_run_adopts_nightshifts_state(tmp_path):
    miner = journal_miner.Miner()
    miner.add("frob", "an old complaint about frobnicators", datetime.fromtimestamp(NOW - 9 * 86400, UTC))
    theirs = tmp_path / "theirs.json"
    theirs.write_text(
        json.dumps(journal_miner.state_dict("cx", miner.clusters(), datetime.fromtimestamp(NOW, UTC), "2026-01-01T00:00:00+00:00", 30, 400))
    )
    run = journal_run()
    signal = journal.signatures(sig_ctx(run, tmp_path, adopt_from=str(theirs)))
    assert signal.fields["tracked"] == 1 and signal.fields["new"] == 0
    assert any("--after-cursor" in call and "cx" in call for call in run.calls)  # their cursor carries on
    report = json.loads((core.STATE_PATH.parent / "journal-signatures.json").read_text())
    assert report["adopted_from_nightshift"] is True


def test_signatures_unreadable_journal_warns(tmp_path):
    run = Fake((["-p"], Result(1, "", "no access")))
    assert journal.signatures(sig_ctx(run, tmp_path)).code == "journal.signatures.unreadable"


def test_known_table_is_anchored_at_the_start_of_the_message():
    known = journal_miner.compile_known(DATA["checks"]["journal"]["known"])
    miner = journal_miner.Miner()
    when = datetime.fromtimestamp(NOW, UTC)
    inside = miner.add("sudo", "pam_systemd(sudo:session): Failed to release session: Access denied", when)
    mid = miner.add("sudo", "user said: pam_systemd(sudo:session): Failed to release session: Access denied", when)
    labelled = journal_miner.classify(inside, known)
    assert labelled is not None and labelled["label"] == "noise"
    assert journal_miner.classify(mid, known) is None
