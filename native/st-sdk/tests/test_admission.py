"""Exercise real advisory locks and child processes against temporary lanes."""

from __future__ import annotations

import contextlib
import importlib.util
import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from st_sdk import admission as guard

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def lane(tmp_path, monkeypatch):
    directory = tmp_path / 'lane'
    directory.mkdir(mode=0o700)
    monkeypatch.setattr(guard, '_LOCK_DIRECTORY', directory)
    monkeypatch.setattr(guard, '_spare_capacity', lambda: False)
    monkeypatch.setattr(guard, 'admission_state', lambda: guard.Admission(True, 'fixture'))
    monkeypatch.delenv('ST_HEAVY_LEASE', raising=False)
    return directory


def bootstrap(lane):
    return (f"import sys; sys.path.insert(0, {str(ROOT)!r}); from pathlib import Path; "
            f"from st_sdk import admission as guard; guard._LOCK_DIRECTORY = Path({str(lane)!r}); "
            "guard._spare_capacity = lambda: False; "
            "guard.admission_state = lambda: guard.Admission(True, 'fixture'); ")


def test_policy_preserves_shared_lane_names_and_worker_caps(lane):
    assert guard._lane_name('admission.lock', 'heavy') == 'admission.lock'
    assert guard._lane_name('admission.lock', 'heavy2') == 'heavy2-admission.lock'
    with guard.heavy_work('outer') as work:
        with guard.heavy_work('same-process nested') as nested:
            assert nested is work
        env = work.environment({'GOMAXPROCS': '1', 'VITEST_MAX_WORKERS': '999'})
        assert env['GOMAXPROCS'] == '1'
        assert env['VITEST_MAX_WORKERS'] == str(guard.WORKERS)
        assert env['ST_HEAVY_LEASE'] == work.token
        assert guard.lane_activity()[0]['label'] == 'outer'
    assert guard.lane_activity() == []


def test_light_cannot_upgrade_in_process_or_descendant(lane):
    with guard.heavy_work('light owner', work_class='light') as work:
        with pytest.raises(guard.HeavyWorkError, match='cannot be upgraded'), guard.heavy_work('heavy'):
            pass
        script = bootstrap(lane) + "\nwith guard.heavy_work('heavy descendant'): pass\n"
        result = work.run([sys.executable, '-c', script], capture_output=True, text=True, timeout=5)
        assert result.returncode != 0
        assert 'cannot be upgraded' in result.stderr


def test_verified_exec_descendant_reenters_even_when_intermediate_closes_fds(lane):
    grandchild = bootstrap(lane) + "\nwith guard.heavy_work('grandchild') as work: print(work.token)\n"
    intermediate = ("import subprocess,sys; "
                    f"sys.exit(subprocess.run([sys.executable, '-c', {grandchild!r}], close_fds=True).returncode)")
    with guard.heavy_work('ancestor') as work:
        result = work.run([sys.executable, '-c', intermediate], capture_output=True, text=True, timeout=5)
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip().split(':')[2] == work.token.split(':')[2]
        assert result.stdout.strip().split(':')[4] == '1'


def test_unrelated_thread_queues_and_then_enters(lane):
    started, entered = threading.Event(), threading.Event()

    def actor():
        started.set()
        with guard.heavy_work('another thread'):
            entered.set()

    with guard.heavy_work('owner'):
        thread = threading.Thread(target=actor)
        thread.start()
        assert started.wait(2)
        assert not entered.wait(0.15)
    thread.join(5)
    assert not thread.is_alive() and entered.is_set()


def test_fifo_queued_processes_keep_their_order(lane):
    code = bootstrap(lane) + f"""
with guard.heavy_work(sys.argv[1]):
    with Path({str(lane.parent / 'order')!r}).open('a') as order:
        order.write(sys.argv[1] + '\\n')
    print(sys.argv[1], flush=True)
"""
    actors = []
    try:
        with guard.heavy_work('owner'):
            first = subprocess.Popen([sys.executable, '-c', code, 'first'], stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True)
            actors.append(first)
            # Synchronize on the actual waiter record, rather than guessing startup time.
            for _ in range(200):
                if list(lane.glob('wait-heavy-*.json')):
                    break
                threading.Event().wait(0.01)
            assert list(lane.glob('wait-heavy-*.json'))
            second = subprocess.Popen([sys.executable, '-c', code, 'second'], stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, text=True)
            actors.append(second)
        for actor, label in zip(actors, ('first', 'second'), strict=True):
            output, error = actor.communicate(timeout=5)
            assert actor.returncode == 0, error
            assert output.strip() == label
        assert (lane.parent / 'order').read_text().splitlines() == ['first', 'second']
    finally:
        for actor in actors:
            if actor.poll() is None:
                actor.terminate()
                actor.communicate(timeout=5)


def test_missing_child_and_nonzero_exit_preserve_cli_contract(lane):
    with guard.heavy_work('child status') as work:
        with pytest.raises(FileNotFoundError):
            work.run(['aico-test-definitely-absent'])
        result = work.run([sys.executable, '-c', 'raise SystemExit(7)'])
        assert result.returncode == 7
        with pytest.raises(subprocess.CalledProcessError) as exc:
            work.run([sys.executable, '-c', 'raise SystemExit(9)'], check=True)
        assert exc.value.returncode == 9


def test_timeout_cancels_owned_child_and_releases_lane(lane, tmp_path):
    pid_file = tmp_path / 'child-pid'
    script = ('import os,time; from pathlib import Path; '
              f'Path({str(pid_file)!r}).write_text(str(os.getpid())); time.sleep(30)')
    with guard.heavy_work('cancel child') as work, pytest.raises(subprocess.TimeoutExpired):
        work.run([sys.executable, '-c', script], capture_output=True, timeout=0.5)
    child_pid = int(pid_file.read_text())
    assert not Path(f'/proc/{child_pid}').exists()
    with guard.heavy_work('after cancellation'):
        pass


def test_forged_or_stale_lease_cannot_reenter(lane):
    with guard.heavy_work('real') as work:
        admission = guard._open_lane('admission.lock')
        descriptor = guard._open_lane('activity.lock')
        try:
            assert guard._inherited(descriptor, admission, {'ST_HEAVY_LEASE': 'forged'}) is None
            assert guard._inherited(descriptor, admission, {'ST_HEAVY_LEASE': work.token}) is None
        finally:
            os.close(descriptor)
            os.close(admission)


def test_host_decision_and_psi_fallback_keep_existing_thresholds(monkeypatch, tmp_path):
    decision = tmp_path / 'admission.json'
    pressure = tmp_path / 'memory'
    monkeypatch.setattr(guard, 'HOST_ADMISSION', decision)
    monkeypatch.setattr(guard, '_PSI_MEMORY', pressure)
    pressure.write_text('some avg10=0 avg60=0 avg300=0 total=0\nfull avg10=6 avg60=0 avg300=0 total=0\n')
    assert not guard.admission_state(100).admit
    decision.write_text(json.dumps({'v': 1, 'expires_at': 101, 'admit': True,
                                    'state': 'green', 'reason': 'fixture'}))
    assert guard.admission_state(100).admit
    assert not guard.admission_state(102).admit


def test_wait_reason_stays_readable_and_wait_lines_back_off(monkeypatch, tmp_path):
    decision = tmp_path / 'admission.json'
    monkeypatch.setattr(guard, 'HOST_ADMISSION', decision)
    decision.write_text(json.dumps({'v': 1, 'expires_at': 101, 'admit': False, 'state': 'amber',
                                    'reason': 'Memory is tight: 12.8 GiB available, swap 47% (parked, no stalls); defer'}))
    assert guard.admission_state(100).reason == (
        'host amber: Memory is tight: 12.8 GiB available, swap 47% (parked, no stalls); defer')
    clock = iter([0.0, 3.0, 20.0, 500.0])
    monkeypatch.setattr(guard.time, 'monotonic', lambda: next(clock))
    assert [guard._next_status(0.0) for _ in range(4)] == [5.0, 8.0, 40.0, 560.0]


def tools_run_module():
    spec = importlib.util.spec_from_file_location('tools_run_under_test', ROOT / 'tools_run.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(('argv', 'admit', 'held_class'), [
    (['--label', 'quick', '--class', 'light'], True, 'light'),
    (['--label', 'quick', '--class', 'light'], False, 'heavy'),
    (['--label', 'gate'], True, 'heavy'),
])
def test_tools_run_takes_the_light_lane_only_when_the_host_has_room(lane, monkeypatch, argv, admit, held_class):
    tools_run = tools_run_module()
    monkeypatch.setattr(tools_run, 'admission_state', lambda: guard.Admission(admit, 'fixture'))
    held = []
    real = tools_run.heavy_work

    @contextlib.contextmanager
    def watched(label, *, work_class='heavy', project=None):
        with real(label, work_class=work_class, project=project) as work:
            held.append(work.work_class)
            yield work

    monkeypatch.setattr(tools_run, 'heavy_work', watched)
    assert tools_run.main([*argv, '--', sys.executable, '-c', 'pass']) == 0
    assert held == [held_class]


def test_tools_run_under_a_light_lane_stays_light_when_the_host_has_no_room(lane, monkeypatch):
    tools_run = tools_run_module()
    monkeypatch.setattr(tools_run, 'admission_state', lambda: guard.Admission(False, 'fixture'))
    monkeypatch.setenv(guard._LEASE_ENV, 'light:fixture')
    asked = []

    @contextlib.contextmanager
    def watched(_label, *, work_class='heavy', project=None):
        asked.append(work_class)
        yield SimpleNamespace(run=lambda *_a, **_k: SimpleNamespace(returncode=0))

    monkeypatch.setattr(tools_run, 'heavy_work', watched)
    assert tools_run.main(['--label', 'nested', '--class', 'light', '--', sys.executable, '-c', 'pass']) == 0
    assert asked == ['light']


def test_light_lane_runs_while_a_full_gate_holds_heavy(lane):
    with guard.heavy_work('full gate'):
        result = subprocess.run(
            [sys.executable, '-c', bootstrap(lane) + "\nwith guard.heavy_work('quick', work_class='light') as w: print(w.work_class)"],
            capture_output=True, text=True, timeout=30,
            env={k: v for k, v in os.environ.items() if k != 'ST_HEAVY_LEASE'})
    assert result.stdout.strip() == 'light', result.stderr
