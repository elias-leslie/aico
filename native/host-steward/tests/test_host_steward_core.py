"""host_steward core and runner: data files, row building, caps, due times, the one-batch post, contract rows."""

from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import ClassVar

import pytest

import aico_status
from host_steward import core, runner
from host_steward.checks import CHECKS

DATA = core.load_data()
NOW = 1_800_000_000.0
ROOT = Path(__file__).resolve().parents[3]


def cfg(**over):
    return {"what": "Thing", "every_min": 15, "slack_min": 10, **over}


def test_every_check_has_settings_an_ok_line_and_a_valid_schedule():
    assert set(DATA["checks"]) == set(CHECKS) == set(DATA["meanings"]["ok"])
    for name, settings in DATA["checks"].items():
        assert 0 < settings["every_min"] <= 24 * 60, name
        assert settings["slack_min"] > 0, name
        assert settings["what"] and len(settings["what"]) <= aico_status.TEXT_LIMITS["what"][0], name


def test_meanings_read_as_plain_sentences_within_the_row_limit():
    for code, entry in DATA["meanings"]["signal"].items():
        assert entry["what"].strip(), code
        for key in ("what", "impact", "next"):
            assert not entry.get(key, "").rstrip().endswith("."), f"{code}.{key}: the row adds the full stop"
        assert len(entry["what"]) + len(entry.get("impact", "")) + len(entry.get("next", "")) < 260, code


def test_a_problem_says_what_it_means_and_what_next_and_other_problems_stay_short():
    signals = [
        core.Signal("storage.disk.space", "failed", {"name": "System disk", "free": "4", "pct": "99"}),
        core.Signal("perf.swap", "warn", {"pct": "90", "avail": "12"}),
        core.Signal("storage.smart", "ok", {"dev": "/dev/sda"}),
    ]
    text = core.meaning("storage", signals, DATA["meanings"])
    assert text.startswith("System disk has 4 GiB free (99% used). Backups and builds stop when it runs out.")
    assert "Free some space." in text
    assert text.endswith("Also: Swap is 90% full while 12 GiB of memory is free.")


def test_an_ok_row_says_its_ok_line_plus_notes_and_unknown_fields_read_as_a_question_mark():
    signals = [core.Signal("ecc.corrected", "ok", {"n": 40}, note=True)]
    assert core.meaning("ecc", signals, DATA["meanings"]) == (
        "No uncorrected memory errors on the PVE host. 40 corrected memory errors in a day; recorded only."
    )
    assert core.explain("perf.swap", {}, DATA["meanings"], False) == "Swap is ?% full while ? GiB of memory is free."
    assert core.explain("nope.code", {"detail": "Seen."}, DATA["meanings"], True) == "Seen."


def test_caps_keep_a_record_only_signal_at_ok_and_the_first_pattern_wins():
    assert core.cap_state("ecc.corrected", "warn", {"ecc.corrected": "ok"}) == "ok"
    assert core.cap_state("ecc.uncorrected", "failed", {"ecc.corrected": "ok"}) == "failed"
    assert core.cap_state("a.b", "failed", {"a.*": "warn", "a.b": "ok"}) == "warn"
    assert core.cap_state("a.b", "ok", {"a.*": "warn"}) == "ok"


def test_the_row_is_a_valid_status_row_with_slack_and_run_and_log_actions():
    signals = [core.Signal("ecc.spike", "warn", {"n": 90, "base": "10"}, note=True)]
    row = core.make_row("ecc", signals, cfg(), DATA["meanings"], "davion-sidarli", NOW, DATA["caps"])
    assert row["id"] == "davion-sidarli/check-ecc"
    assert row["state"] == "ok"  # the data file's cap: record only
    assert row["next_run"] - row["last_run"] == core.timedelta(minutes=25)
    assert [a["kind"] for a in row["actions"]] == ["run", "log"]
    assert row["actions"][0]["ref"] == "host-steward check --only ecc"
    assert aico_status.check_row(row)["kind"] == "check"


def test_a_check_that_returns_nothing_is_a_failed_row_not_a_missing_one():
    row = core.make_row("gates", [], cfg(), DATA["meanings"], "m", NOW, {})
    assert row["state"] == "failed"
    assert "gates check returned nothing" in row["meaning"]


def test_a_long_meaning_is_cut_to_the_row_limit():
    signals = [core.Signal("check.probe", "warn", {"probe": "x" * 400, "why": "y"})]
    assert len(core.meaning("workstation", signals, DATA["meanings"])) <= aico_status.TEXT_LIMITS["meaning"][0]


def test_run_command_turns_a_missing_program_and_a_timeout_into_results():
    assert core.run_command(["/no/such/program"]).rc == 127
    assert core.run_command([sys.executable, "-c", "import time; time.sleep(5)"], timeout=0.5).rc == 124
    assert (
        core.run_command([sys.executable, "-c", "import sys; sys.stdout.write(sys.stdin.read())"], input_text="hi").out
        == "hi"
    )


def test_state_round_trips_and_a_missing_or_broken_file_is_empty(tmp_path):
    path = tmp_path / "sub" / "state.json"
    assert core.load_state(path) == {}
    core.save_state({"a": 1}, path)
    assert core.load_state(path) == {"a": 1}
    path.write_text("[1]")
    assert core.load_state(path) == {}


def test_a_check_is_due_after_its_interval_less_a_minute_of_jitter():
    c = cfg(every_min=15)
    assert runner.is_due("x", c, {}, NOW)
    assert not runner.is_due("x", c, {"last_run": {"x": NOW - 600}}, NOW)
    assert runner.is_due("x", c, {"last_run": {"x": NOW - 15 * 60 + 30}}, NOW)


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Nothing here may reach a network: the probes that open sockets fail like an unplugged cable."""

    def down(*_args, **_kwargs):
        raise OSError("network is not available in tests")

    from host_steward.checks import gates, workstation

    monkeypatch.setattr(gates, "router_address", down)
    monkeypatch.setattr(workstation, "fetch_url", lambda *a, **k: (0, "down"))
    monkeypatch.setattr(workstation, "endpoint_expiry", down)


def fake(argv, timeout=60, input_text=None):
    return core.Result(127, "", "no such program in the test")


def test_the_runner_makes_one_valid_row_per_due_check_even_when_everything_fails():
    rows, ran = runner.run_checks(DATA, {}, NOW, run=fake, machine="davion-sidarli")
    assert ran == list(CHECKS) == [r["id"].split("check-")[1] for r in rows]
    for row in rows:
        assert aico_status.check_row(row)["machine"] == "davion-sidarli"


def test_only_runs_the_named_check_and_nothing_due_runs_nothing():
    rows, ran = runner.run_checks(DATA, {}, NOW, only=["journal"], run=fake, machine="m")
    assert ran == ["journal"] and rows[0]["state"] == "warn"
    state = {"last_run": {name: NOW for name in CHECKS}}
    assert runner.run_checks(DATA, state, NOW + 60, run=fake, machine="m") == ([], [])


def test_a_check_that_raises_becomes_a_failed_row(monkeypatch):
    def boom(ctx):
        raise RuntimeError("secret detail")

    monkeypatch.setattr(CHECKS["journal"], "run", boom)
    rows, _ = runner.run_checks(DATA, {}, NOW, only=["journal"], run=fake, machine="m")
    assert rows[0]["state"] == "failed"
    assert "journal check broke (RuntimeError)" in rows[0]["meaning"]
    assert "secret" not in rows[0]["meaning"]


class Sink(BaseHTTPRequestHandler):
    posts: ClassVar[list] = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        Sink.posts.append(json.loads(body))
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, format, *args):
        pass


def test_main_posts_all_rows_in_one_batch_over_loopback_and_records_last_run(tmp_path, monkeypatch):
    server = HTTPServer(("127.0.0.1", 0), Sink)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/api/status/rows"
    state_file = tmp_path / "state.json"
    monkeypatch.setattr(core, "STATE_PATH", state_file)
    monkeypatch.setattr(core, "run_command", fake)
    monkeypatch.setattr(runner.core, "run_command", fake)
    Sink.posts = []
    try:
        code = runner.main(["check", "--only", "journal", "--only", "ominull-lock"], post=lambda rows: aico_status.report(rows, url=url))
    finally:
        server.shutdown()
    assert code == 0
    assert len(Sink.posts) == 1 and [r["id"].split("check-")[1] for r in Sink.posts[0]] == ["journal", "ominull-lock"]
    assert set(json.loads(state_file.read_text())["last_run"]) == {"journal", "ominull-lock"}
    assert Sink.posts[0][0]["last_run"].endswith("Z")


def test_a_refused_batch_exits_1_and_leaves_the_checks_due(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(core, "STATE_PATH", tmp_path / "state.json")
    assert runner.main(["check", "--only", "ominull-lock"], post=lambda rows: False) == 1
    assert "not posted" in capsys.readouterr().out
    assert "last_run" not in core.load_state(tmp_path / "state.json")


def test_dry_run_prints_rows_and_keeps_no_state(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(core, "STATE_PATH", tmp_path / "state.json")
    assert runner.main(["check", "--only", "ominull-lock", "--dry-run"], post=lambda rows: 1 / 0) == 0
    assert json.loads(capsys.readouterr().out)[0]["id"].endswith("/check-ominull-lock")
    assert not (tmp_path / "state.json").exists()


def test_an_unknown_check_name_is_refused(capsys):
    assert runner.main(["check", "--only", "nope"]) == 2
    assert "no such check: nope" in capsys.readouterr().err


def test_valid_contract_rows_still_pass_the_helper_the_checks_post_through():
    fixtures = json.loads((ROOT / "contracts/status-row-fixtures.json").read_text())
    for item in fixtures["valid"]:
        assert aico_status.check_row(item["row"])["id"] == item["row"]["id"]


def test_install_script_copies_the_package_data_and_units(tmp_path, monkeypatch):
    import os
    import subprocess

    env = {
        **os.environ,
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HS_NO_SYSTEMCTL": "1",
        "HS_PREFIX": str(tmp_path / "lib"),
        "HS_BIN": str(tmp_path / "bin"),
        "HS_UNIT_DIR": str(tmp_path / "units"),
        "HS_USER_UNIT_DIR": str(tmp_path / "user-units"),
        "HS_SUDOERS_DIR": str(tmp_path / "sudoers.d"),
        "HS_STATE_DIR": str(tmp_path / "state"),
    }
    here = Path(__file__).resolve().parents[1]
    subprocess.run([str(here / "install-root.sh")], env=env, check=True, capture_output=True)
    assert (tmp_path / "lib/host_steward/data/checks.toml").is_file()
    assert (tmp_path / "lib/aico_status.py").is_file()
    assert (tmp_path / "bin/host-steward").resolve() == (tmp_path / "lib/host-steward").resolve()
    timer = (tmp_path / "units/host-steward-check.timer").read_text()
    assert "OnCalendar=*:0/15" in timer
    service = (tmp_path / "units/host-steward-check.service").read_text()
    assert "ExecStart=/usr/local/lib/host-steward/host-steward check" in service
    assert (tmp_path / "user-units/host-steward-memctl.service").is_file()
    assert not (tmp_path / "units/host-steward-memctl.service").exists()
    assert "systemctl start host-steward-space-guard.service" in (tmp_path / "sudoers.d/60-host-steward").read_text()
    done = subprocess.run(
        [str(tmp_path / "lib/host-steward"), "check", "--only", "nope"], capture_output=True, text=True, check=False
    )
    assert done.returncode == 2 and "no such check" in done.stderr


@pytest.mark.parametrize("name", list(CHECKS))
def test_each_check_module_has_an_id_that_matches_its_table(name):
    assert CHECKS[name].ID == name
    assert callable(CHECKS[name].run)
