"""The Proxmox backup key's forced command runs fixed verbs only and never ships PVE's private keys."""

from __future__ import annotations

import concurrent.futures
import hashlib
import importlib.machinery
import importlib.util
import inspect
import io
import json
import os
import shlex
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterable
from pathlib import Path
from types import ModuleType
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "backup-hosts" / "pve-backup" / "summitflow-pve-backup"
DIRECTORY, FILE = 4, 8


class px:
    @staticmethod
    def path_digest(path: str) -> str:
        return hashlib.sha256(path.encode()).hexdigest()

    @staticmethod
    def dispatcher_entry(path: str) -> dict[str, Any]:
        parsed = urlsplit(path)
        parts = parsed.path.strip("/").split("/")
        query = parse_qs(parsed.query)
        files = None
        if parts[-1] == "files":
            kind = "host" if parts[0] == "host" else parts[0]
            files = {"via": "host" if kind == "host" else query["via"][0], "paths": query["path"],
                     "excludes": query.get("exclude", [])}
        kind = "config" if parts[0] == "config" else ("host" if parts[0] == "host" else parts[0])
        vmid = int(parts[1]) if parts[0] in ("lxc", "qemu") else None
        return {"digest": px.path_digest(path), "kind": kind, "vmid": vmid, "files": files}


def _load() -> ModuleType:
    loader = importlib.machinery.SourceFileLoader("summitflow_pve_backup", str(SCRIPT))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class Runs:
    """Records each argv; answers like the PVE tools would."""

    def __init__(self, answers: dict[str, Any] | None = None) -> None:
        self.calls: list[list[str]] = []
        self.answers = answers or {}

    def __call__(self, argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        assert isinstance(argv, list) and not kwargs.get("shell")
        self.calls.append(argv)
        answer = self.answers.get(argv[0], "")
        result = answer(argv) if callable(answer) else answer
        if isinstance(result, tuple):
            code, stdout, *errors = result
            stderr = errors[0] if errors else ""
        else:
            code, stdout, stderr = 0, result, ""
        return subprocess.CompletedProcess(argv, code, stdout, stderr)


@pytest.fixture
def dispatcher(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    module = _load()
    monkeypatch.setattr(module, "SOURCES", tmp_path / "sources.json")
    monkeypatch.setattr(module, "DUMP_DIRECTORY", tmp_path / "dump")
    monkeypatch.setattr(module, "CAPTURE_LOCKS", tmp_path / "locks")
    monkeypatch.setattr(module, "GUARD_STATUS", tmp_path / "guard.json")
    monkeypatch.setattr(module, "BOOT_ID", tmp_path / "boot_id")
    module.BOOT_ID.write_text("test-boot")
    _budget(module)
    monkeypatch.delenv("SSH_ORIGINAL_COMMAND", raising=False)
    return module


def _install(module: ModuleType, sources: dict[str, str]) -> dict[str, str]:
    """What install.sh writes: SummitFlow's own manifest of each registered path."""
    entries = {name: px.dispatcher_entry(path) for name, path in sources.items()}
    module.SOURCES.write_text(json.dumps(entries))
    return {name: px.path_digest(path) for name, path in sources.items()}


def _budget(module, quota=50, **changes):
    payload = {"cpu_quota_percent": quota, "admission_open": True, "observed_at": time.time(),
               "boot_id": "test-boot", "policy": {"sample_s": 15, "stale_s": 45}, **changes}
    module.GUARD_STATUS.write_text(json.dumps(payload))


class Stream:
    def __init__(self, ticks: Iterable[Callable[[], None]] = ()):
        self.ticks = iter(ticks)
        self.code = None
        self.terminated = False

    def wait(self, timeout=None):
        tick = next(self.ticks, None)
        if tick:
            tick()
            raise subprocess.TimeoutExpired("synthetic export", timeout)
        self.code = 0 if self.code is None else self.code
        return self.code

    def poll(self):
        return self.code

    def terminate(self):
        self.terminated = True
        self.code = -15


def _stream_process(monkeypatch, process=None):
    calls = []
    process = process or Stream()

    def start(argv, **kwargs):
        calls.append(argv)
        return process

    monkeypatch.setattr(subprocess, "Popen", start)
    return calls, process


HOST = "proxmox://proxmox-gem/host/files?path=/vault/identity&path=/etc/pve/qemu-server/120.conf"
CT = "proxmox://proxmox-gem/lxc/140/files?via=pct&path=/srv/data&exclude=*.tmp"
VM = "proxmox://proxmox-gem/qemu/100/files?via=agent&path=/home/u/p&exclude=Cache"


@pytest.mark.parametrize("command", [
    "", "id", "bash -c id", "sh", "guests --type node", "thinpool pve/root", "capture", "capture pve-host-files",
    "pvesh delete /nodes/davion-gem/qemu/100", "vzdump 150 --stdout 1", "capture ../../etc/shadow " + "0" * 64,
    "host-boot /etc/shadow", "host-boot; id",
    "capture pve-host-files " + "0" * 64 + " extra", "rm -rf /",
])
def test_only_the_fixed_verbs_run(dispatcher, command, capsys):
    runs = Runs()
    _install(dispatcher, {"pve-host-files": HOST})
    assert dispatcher.main(command, run=runs, out=io.BytesIO()) == 2
    assert runs.calls == [] and "summitflow-pve-backup:" in capsys.readouterr().err


def test_forced_command_reads_the_original_ssh_command(dispatcher, monkeypatch):
    runs = Runs()
    monkeypatch.setenv("SSH_ORIGINAL_COMMAND", "guests")
    assert dispatcher.main(run=runs) == 0
    monkeypatch.setenv("SSH_ORIGINAL_COMMAND", "thinpool")
    assert dispatcher.main(run=runs) == 0
    assert runs.calls == [["pvesh", "get", "/cluster/resources", "--type", "vm", "--output-format", "json"],
                          ["lvs", "--noheadings", "-o", "data_percent", "pve/data"]]


def test_host_boot_reads_only_the_kernel_boot_identity(dispatcher, tmp_path, monkeypatch):
    boot_id = tmp_path / "boot_id"
    boot_id.write_text("0db4609d-4ec6-4c36-8890-f43ea90c83f1\n")
    monkeypatch.setattr(dispatcher, "BOOT_ID", boot_id, raising=False)
    runs, out = Runs(), io.BytesIO()
    assert dispatcher.main("host-boot", run=runs, out=out) == 0
    assert out.getvalue() == boot_id.read_bytes()
    assert runs.calls == []
    boot_id.unlink()
    assert dispatcher.main("host-boot", run=runs, out=io.BytesIO()) == 2
    assert runs.calls == []


@pytest.mark.parametrize("failure", [False, True])
def test_same_guest_captures_wait_for_cleanup_but_other_guests_can_run(dispatcher, tmp_path, monkeypatch, failure):
    monkeypatch.setattr(dispatcher, "CAPTURE_LOCKS", tmp_path / "locks", raising=False)
    digests = _install(dispatcher, {"first": VM, "second": VM, "other": VM.replace("/100/", "/101/")})
    local = threading.local()
    first_started, second_attempted, second_started, release = (threading.Event() for _ in range(4))
    real_flock = __import__("fcntl").flock

    def flock(handle, operation):
        if local.name == "second":
            second_attempted.set()
        return real_flock(handle, operation)

    monkeypatch.setattr("fcntl.flock", flock)

    def capture(entry, out, run):
        if local.name == "first":
            first_started.set()
            assert release.wait(5), "the held synthetic capture was never released"
            if failure:
                raise dispatcher.Refused("synthetic capture failed after cleanup")
        elif local.name == "second":
            second_started.set()
            second_attempted.set()
        return 0

    monkeypatch.setattr(dispatcher, "capture", capture)

    def request(name):
        local.name = name
        return dispatcher.main(f"capture {name} {digests[name]}", run=Runs(), out=io.BytesIO())

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        first = pool.submit(request, "first")
        try:
            assert first_started.wait(5)
            second = pool.submit(request, "second")
            assert second_attempted.wait(5)
            assert not second_started.is_set(), "two captures of the same guest overlapped"
            assert pool.submit(request, "other").result(timeout=5) == 0
        finally:
            release.set()
        assert first.result(timeout=5) == (2 if failure else 0)
        assert second.result(timeout=5) == 0
        assert second_started.is_set()


def test_capture_needs_the_installed_source_and_its_current_path(dispatcher, capsys):
    digests = _install(dispatcher, {"pve-host-files": HOST})
    runs = Runs()
    # A source registered (or changed) on the workstation after root installed the list is refused.
    assert dispatcher.main(f"capture pve-other {digests['pve-host-files']}", run=runs, out=io.BytesIO()) == 2
    assert "not installed" in capsys.readouterr().err
    changed = px.path_digest(HOST + "&path=/etc/pve/priv")
    assert dispatcher.main(f"capture pve-host-files {changed}", run=runs, out=io.BytesIO()) == 2
    assert "changed on the workstation" in capsys.readouterr().err
    assert runs.calls == []
    assert dispatcher.main(f"capture pve-host-files {digests['pve-host-files']}", run=runs, out=io.BytesIO()) == 0
    assert runs.calls and runs.calls[0][0] == "tar"


@pytest.mark.parametrize("entry", [
    {"kind": "host", "vmid": None, "files": {"via": "host", "paths": ["/a/../etc/pve/priv"], "excludes": []}},
    {"kind": "host", "vmid": None, "files": {"via": "host", "paths": ["etc/shadow"], "excludes": []}},
    {"kind": "host", "vmid": None, "files": {"via": "host", "paths": ["/x;id"], "excludes": []}},
    {"kind": "host", "vmid": None, "files": {"via": "host", "paths": ["/x"], "excludes": ["$(id)"]}},
    {"kind": "host", "vmid": None, "files": {"via": "pct", "paths": ["/x"], "excludes": []}},
    {"kind": "host", "vmid": None, "files": None},
    {"kind": "lxc", "vmid": "140; id", "files": None},
    {"kind": "lxc", "vmid": True, "files": None},
    {"kind": "qemu", "vmid": 100, "files": {"via": "pct", "paths": ["/x"], "excludes": []}},
    {"kind": "config", "vmid": 1, "files": None},
    {"kind": "shell", "vmid": None, "files": None},
])
def test_a_tampered_source_list_is_refused(dispatcher, entry, capsys):
    digest = "a" * 64
    dispatcher.SOURCES.write_text(json.dumps({"s": {**entry, "digest": digest}}))
    runs = Runs()
    assert dispatcher.main(f"capture s {digest}", run=runs, out=io.BytesIO()) == 2
    assert runs.calls == []


def _config_db(path: Path) -> None:
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE tree (inode INTEGER PRIMARY KEY NOT NULL, parent INTEGER NOT NULL, version INTEGER NOT NULL, "
               "writer INTEGER NOT NULL, mtime INTEGER NOT NULL, type INTEGER NOT NULL, name TEXT NOT NULL, data BLOB)")
    rows = [
        (0, 0, FILE, "__version__", None),
        (1, 0, DIRECTORY, "priv", None),
        (2, 1, FILE, "authkey.key", b"AUTHKEY-SECRET"),
        (3, 1, FILE, "token.cfg", b"TOKEN-SECRET"),
        (4, 1, DIRECTORY, "lock", None),
        (5, 4, FILE, "deep", b"DEEP-SECRET"),
        (6, 0, FILE, "pve-www.key", b"WWW-SECRET"),
        (7, 0, FILE, "pve-root-ca.pem", b"public-ca"),
        (8, 0, DIRECTORY, "nodes", None),
        (9, 8, DIRECTORY, "davion-gem", None),
        (10, 9, FILE, "pve-ssl.key", b"SSL-SECRET"),
        (11, 9, FILE, "pve-ssl.pem", b"public-cert"),
        (12, 9, DIRECTORY, "priv", None),
        (13, 12, FILE, "acme.cfg", b"NODE-PRIV-SECRET"),
        (14, 9, DIRECTORY, "qemu-server", None),
        (15, 14, FILE, "100.conf", b"name: st-browser"),
        (16, 0, FILE, "storage.cfg", b"dir: local"),
        (17, 0, FILE, "pve-root-ca.KEY", b"CASE-SECRET"),
    ]
    db.executemany("INSERT INTO tree VALUES (?, ?, 1, 0, 0, ?, ?, ?)", rows)
    db.commit()
    db.close()


def test_config_dump_leaves_out_priv_and_every_key_file(dispatcher, tmp_path, monkeypatch):
    database = tmp_path / "config.db"
    _config_db(database)
    monkeypatch.setattr(dispatcher, "CONFIG_DATABASE", str(database))
    _install(dispatcher, {"pve-cluster-config": "proxmox://proxmox-gem/config"})
    out = io.BytesIO()
    command = f"capture pve-cluster-config {px.path_digest('proxmox://proxmox-gem/config')}"
    assert dispatcher.main(command, run=Runs(), out=out) == 0
    dump = out.getvalue()
    assert dump.startswith(b"BEGIN TRANSACTION")  # what the stored-stream header check expects
    assert b"SECRET" not in dump and b"'priv'" not in dump and b".key'" not in dump and b".KEY'" not in dump
    restored = sqlite3.connect(":memory:")
    restored.executescript(dump.decode())
    names = {row[0] for row in restored.execute("SELECT name FROM tree")}
    assert names == {"__version__", "pve-root-ca.pem", "nodes", "davion-gem", "pve-ssl.pem", "qemu-server", "100.conf", "storage.cfg"}
    # The source database is opened read-only and left as it was.
    assert sqlite3.connect(database).execute("SELECT count(*) FROM tree").fetchone() == (18,)


LIVE_HOST = ("proxmox://proxmox-gem/host/files?path=/vault/identity&path=/vault/meta/recovery-key.json"
             "&path=/etc/pve/qemu-server/120.conf&path=/var/lib/vz/snippets/neri-120-init.yaml"
             "&path=/var/lib/vz/snippets/neri-120-meta.yaml")


@pytest.mark.parametrize("path", [
    "/", "/var", "/var/lib", "/var/lib/pve-cluster", "/var/lib/pve-cluster/config.db", "/etc", "/etc/pve", "/etc/pve/priv",
    "/etc/pve/priv/authkey.key", "/etc/pve/nodes", "/etc/pve/nodes/davion-gem", "/etc/pve/nodes/x/priv",
    "/etc/pve/nodes/x/priv/acme.cfg", "/etc/pve/local/priv", "/etc/pve/local/priv/x", "/etc/pve/pve-www.KEY",
    "/etc/pve/nodes/x/pve-ssl.key", "/root", "/root/.ssh", "/root/.ssh/authorized_keys", "/etc/ssh",
    "/etc/ssh/ssh_host_ed25519_key", "/etc/corosync", "/etc/corosync/authkey",
])
def test_a_host_path_holding_pve_or_root_secrets_is_refused(dispatcher, path, capsys):
    # Written as root would install it from an agent-registered source; the floor holds whatever the workstation parsed.
    files = {"via": "host", "paths": ["/vault/identity", path], "excludes": []}
    dispatcher.SOURCES.write_text(json.dumps({"h": {"digest": "a" * 64, "kind": "host", "vmid": None, "files": files}}))
    runs = Runs()
    assert dispatcher.main(f"capture h {'a' * 64}", run=runs, out=io.BytesIO()) == 2
    error = capsys.readouterr().err
    assert runs.calls == [] and ("holds PVE or root secrets" in error or (path == "/" and "unsafe path" in error))
    assert dispatcher.protected_host_path(path)


@pytest.mark.parametrize("target", ["/etc/pve/nodes/davion-gem/priv/lock", "/var/lib/vz/dump", "/proc/4242/root/var/lib/x", "/etc"])
def test_a_host_path_is_also_checked_where_it_resolves(dispatcher, monkeypatch, target):
    real = os.path.realpath
    monkeypatch.setattr(dispatcher.os.path, "realpath",
                        lambda path: path.replace("/vault/meta/link", target, 1) if path.startswith("/vault/meta/link") else real(path))
    digests = _install(dispatcher, {"h": "proxmox://proxmox-gem/host/files?path=/vault/meta/link/x"})
    runs = Runs()
    assert dispatcher.main(f"capture h {digests['h']}", run=runs, out=io.BytesIO()) == 2
    assert runs.calls == []


@pytest.mark.parametrize("path", [
    # OmniNull's CT 150 vzdump staging (authority keys inside), a guest's root through /proc, Nightshift's dead-man and
    # Web Push credentials, other host secrets, and anything next to or under the captured files: none is in HOST_PATHS.
    "/var/lib/vz", "/var/lib/vz/dump", "/var/lib/vz/dump/st-ominull-1/vzdump-lxc-150-x.tar", "/proc/1/root/x",
    "/proc/4242/root/var/lib/ominull-response-authority", "/etc/shadow", "/etc/gshadow", "/etc/nightshift/deadman",
    "/var/lib/nightshift", "/var/lib/lxc/150", "/etc/ssl/private", "/usr/local/sbin", "/etc/summitflow-pve-backup",
    "/var/backups", "/sys/firmware", "/dev/sda", "/vault", "/vault/data", "/vault/identityx", "/etc/pve/lxc/150.conf",
    "/etc/pve/qemu-server-x", "/var/lib/vz/snippetsx", "/vault/meta", "/vault/meta/other.json", "/vault/identity/../data",
    "/etc/pve/qemu-server", "/etc/pve/qemu-server/130.conf", "/var/lib/vz/snippets", "/var/lib/vz/snippets/other.yaml",
    "/etc/pve/nodes/davion-gem/qemu-server/120.conf",
])
def test_a_host_path_outside_the_allowed_list_is_refused(dispatcher, path, capsys):
    files = {"via": "host", "paths": ["/vault/identity", path], "excludes": []}
    dispatcher.SOURCES.write_text(json.dumps({"h": {"digest": "a" * 64, "kind": "host", "vmid": None, "files": files}}))
    runs = Runs()
    assert dispatcher.main(f"capture h {'a' * 64}", run=runs, out=io.BytesIO()) == 2
    error = capsys.readouterr().err
    assert runs.calls == [] and ("host paths must be one of" in error or (".." in path and "unsafe path" in error))
    assert not dispatcher.allowed_host_path(path)


def test_a_key_file_inside_an_allowed_directory_is_still_refused(dispatcher, capsys):
    digests = _install(dispatcher, {"h": "proxmox://proxmox-gem/host/files?path=/vault/meta/admin.KEY"})
    runs = Runs()
    assert dispatcher.main(f"capture h {digests['h']}", run=runs, out=io.BytesIO()) == 2
    assert runs.calls == [] and "holds PVE or root secrets" in capsys.readouterr().err


def test_qemu_server_configs_pass_where_proxmox_links_them(dispatcher, monkeypatch, capsys):
    real = os.path.realpath
    node = "/etc/pve/nodes/davion-gem/qemu-server"
    monkeypatch.setattr(dispatcher.os.path, "realpath",
                        lambda path: path.replace("/etc/pve/qemu-server", node, 1) if path.startswith("/etc/pve/qemu-server") else real(path))
    digests = _install(dispatcher, {"h": "proxmox://proxmox-gem/host/files?path=/etc/pve/qemu-server/120.conf",
                                    "n": f"proxmox://proxmox-gem/host/files?path={node}/120.conf"})
    runs = Runs()
    assert dispatcher.main(f"capture h {digests['h']}", run=runs, out=io.BytesIO()) == 0
    assert runs.calls[0][-1] == "etc/pve/qemu-server/120.conf"
    # Written outside the list, even though it is the same file.
    assert dispatcher.main(f"capture n {digests['n']}", run=Runs(), out=io.BytesIO()) == 2
    assert "host paths must be one of" in capsys.readouterr().err


def test_the_registered_host_files_still_pass_the_floor(dispatcher):
    digests = _install(dispatcher, {"h": LIVE_HOST})
    runs = Runs()
    assert dispatcher.main(f"capture h {digests['h']}", run=runs, out=io.BytesIO()) == 0
    assert runs.calls[0][-5:] == ["vault/identity", "vault/meta/recovery-key.json", "etc/pve/qemu-server/120.conf",
                                  "var/lib/vz/snippets/neri-120-init.yaml", "var/lib/vz/snippets/neri-120-meta.yaml"]


@pytest.mark.parametrize("path", [
    "proxmox://proxmox-gem/lxc/150", "proxmox://proxmox-gem/lxc/160", "proxmox://proxmox-gem/qemu/150",
    "proxmox://proxmox-gem/lxc/150/files?via=pct&path=/var/lib/ominull-response-authority",
])
def test_the_ominull_hub_and_append_only_restic_are_never_captured(dispatcher, path, capsys):
    digests = _install(dispatcher, {"g": path})
    runs = Runs()
    assert dispatcher.main(f"capture g {digests['g']}", run=runs, out=io.BytesIO()) == 2
    assert runs.calls == [] and "never captured" in capsys.readouterr().err


def test_sources_shows_the_installed_list(dispatcher):
    out = io.BytesIO()
    assert dispatcher.main("sources", run=Runs(), out=out) == 0 and json.loads(out.getvalue()) == {}
    _install(dispatcher, {"h": HOST})
    out = io.BytesIO()
    assert dispatcher.main("sources", run=Runs(), out=out) == 0 and sorted(json.loads(out.getvalue())) == ["h"]


@pytest.mark.skipif(shutil.which("tar") is None, reason="needs GNU tar")
def test_the_host_floor_excludes_secrets_under_an_allowed_directory(dispatcher, tmp_path):
    root = tmp_path / "root"
    files = ["etc/pve/priv/authkey.key", "etc/pve/nodes/gem/priv/acme.cfg", "etc/pve/pve-www.KEY", "etc/pve/nodes/gem/pve-ssl.key",
             "etc/pve/qemu-server/120.conf", "var/lib/pve-cluster/config.db", "root/.ssh/id", "etc/ssh/ssh_host_ed25519_key",
             "etc/ssh/sshd_config", "vault/identity/a"]
    for name in files:
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text("x")
    (root / "etc/pve/local").symlink_to("nodes/gem")
    command = dispatcher.tar_command({"paths": ["/etc", "/var", "/root", "/vault", "/etc/pve/local/priv/acme.cfg"], "excludes": []}, host=True)
    command[command.index("-C") + 1] = str(root)
    stream = subprocess.run(command, capture_output=True, check=False)
    assert stream.returncode <= 1
    listed = set(subprocess.run(["tar", "-t"], input=stream.stdout, capture_output=True, check=True).stdout.decode().split())
    assert {"etc/pve/qemu-server/120.conf", "etc/ssh/sshd_config", "vault/identity/a", "etc/pve/local"} <= listed
    assert not [name for name in listed if "priv" in name or name.lower().endswith(".key") or "pve-cluster/" in name
                or ".ssh/" in name or "ssh_host" in name]


def test_host_tar_never_carries_pve_private_files_and_accepts_a_changed_file(dispatcher):
    digests = _install(dispatcher, {"h": HOST})
    runs = Runs({"tar": (1, "")})
    assert dispatcher.main(f"capture h {digests['h']}", run=runs, out=io.BytesIO()) == 0
    tar = runs.calls[0]
    floor = tar[tar.index("--ignore-case"):tar.index("--no-ignore-case")]
    assert {"--exclude=etc/pve/priv", "--exclude=etc/pve/*/priv", "--exclude=etc/pve/*.key", "--exclude=var/lib/pve-cluster",
            "--exclude=root/.ssh", "--exclude=etc/ssh/ssh_host_*"} <= set(floor)
    assert tar[tar.index("--") + 1:] == ["vault/identity", "etc/pve/qemu-server/120.conf"]
    assert dispatcher.main(f"capture h {digests['h']}", run=Runs({"tar": (2, "")}), out=io.BytesIO()) == 2


def _container(status: str):
    return {"pvesh": json.dumps([{"vmid": 140, "type": "lxc", "node": "davion-gem", "status": status}])}


def test_container_files_run_in_a_capped_guest_scope_and_leave_no_staging(dispatcher, monkeypatch):
    digests = _install(dispatcher, {"ct": CT})
    runs = Runs(_container("running"))
    calls, _ = _stream_process(monkeypatch)
    assert dispatcher.main(f"capture ct {digests['ct']}", run=runs, out=io.BytesIO()) == 0
    command = calls[0]
    assert command[:4] == ["pct", "exec", "140", "--"] and command[4] == "flock"
    assert "systemd-run" in command[-1] and "CPUQuota=50%" in command[-1]
    assert "--exclude=*.tmp" in command[-1] and "srv/data" in command[-1]
    assert "split" not in command[-1] and "gzip" not in command[-1]
    assert runs.calls[-1][:4] == ["pct", "exec", "140", "--"] and "stop" in runs.calls[-1]


def test_a_stopped_container_is_read_from_a_read_only_thin_snapshot_without_starting_it(dispatcher, tmp_path, monkeypatch):
    monkeypatch.setattr(dispatcher, "MOUNT_PARENT", str(tmp_path))
    digests = _install(dispatcher, {"ct": CT})

    def pvesh(argv: list[str]) -> str:
        if argv[2] == "/cluster/resources":
            return json.dumps([{"vmid": 140, "type": "lxc", "node": "davion-gem", "status": "stopped"}])
        assert argv[2] == "/nodes/davion-gem/lxc/140/config"
        return json.dumps({"rootfs": "local-lvm:vm-140-disk-0,size=12G", "hostname": "x"})

    runs = Runs({"pvesh": pvesh, "pvesm": "/dev/pve/vm-140-disk-0\n", "blkid": "ext4\n"})
    assert dispatcher.main(f"capture ct {digests['ct']}", run=runs, out=io.BytesIO()) == 0
    verbs = [call[0] for call in runs.calls]
    assert "pct" not in verbs and not any(call[0] == "losetup" and "--find" in call for call in runs.calls)
    create = next(call for call in runs.calls if call[0] == "lvcreate")
    assert create[-1] == "pve/vm-140-disk-0" and "st-backup-140" in create
    mount = next(call for call in runs.calls if call[0] == "mount")
    assert mount[-2] == "/dev/pve/st-backup-140" and "ro,nodev,nosuid,noexec,norecovery" in mount
    tar = next(call for call in runs.calls if call[0] == "tar")
    assert "--exclude=*.tmp" in tar and "srv/data" in tar
    assert verbs[-2:] == ["umount", "lvremove"]
    assert list(tmp_path.glob("st-backup-140-*")) == []


def test_whole_guest_streams_in_snapshot_mode_and_trims_week_old_logs(dispatcher):
    path = "proxmox://proxmox-gem/lxc/140"
    digests = _install(dispatcher, {"ct": path})
    logs = dispatcher.DUMP_DIRECTORY
    logs.mkdir()
    old, recent, other = logs / "vzdump-lxc-140-2026_10_01.log", logs / "vzdump-lxc-140-2026_10_14.log", logs / "vzdump-lxc-150-2026_10_01.log"
    for item in (old, recent, other):
        item.write_text("log")
    stamp = time.time() - 8 * 86400
    os.utime(old, (stamp, stamp))
    os.utime(other, (stamp, stamp))
    runs = Runs()
    assert dispatcher.main(f"capture ct {digests['ct']}", run=runs, out=io.BytesIO()) == 0
    assert runs.calls == [["vzdump", "140", "--stdout", "1", "--mode", "snapshot", "--compress", "0", "--quiet", "1"]]
    assert not old.exists() and recent.exists() and other.exists()



def _stopped(contents: str = "part.00000\n"):
    config = {"boot": "order=scsi0", "scsi0": "local-lvm:vm-100-disk-0,discard=on,size=64G", "ide2": "local-lvm:vm-100-cloudinit"}
    # The shape lsblk 2.39 really prints for a loop device: partitions beside it, not under it.
    lsblk = {"blockdevices": [{"path": "/dev/loop7", "size": 9000, "fstype": None, "type": "loop"},
                              {"path": "/dev/loop7p15", "size": 100, "fstype": "vfat", "type": "part"},
                              {"path": "/dev/loop7p1", "size": 5000, "fstype": "ext4", "type": "part"},
                              {"path": "/dev/loop7p16", "size": 900, "fstype": "ext4", "type": "part"}]}

    def pvesh(argv: list[str]) -> str:
        if argv[2] == "/cluster/resources":
            return json.dumps([{"vmid": 100, "type": "qemu", "node": "davion-gem", "status": "stopped"}])
        if argv[2] == "/nodes/davion-gem/qemu/100/status/current":
            return json.dumps({"status": "stopped"})
        assert argv[2] == "/nodes/davion-gem/qemu/100/config"
        return json.dumps(config)

    return {"pvesh": pvesh, "pvesm": "/dev/pve/vm-100-disk-0\n", "losetup": lambda argv: "/dev/loop7\n" if "--find" in argv else "",
            "lsblk": json.dumps(lsblk)}


def test_a_stopped_vm_is_read_from_a_read_only_thin_snapshot_and_everything_is_released(dispatcher, tmp_path, monkeypatch):
    monkeypatch.setattr(dispatcher, "MOUNT_PARENT", str(tmp_path))
    digests = _install(dispatcher, {"vm": VM})
    runs = Runs(_stopped())
    assert dispatcher.main(f"capture vm {digests['vm']}", run=runs, out=io.BytesIO()) == 0
    verbs = [call[0] for call in runs.calls]
    assert "qm" not in verbs
    acquire = next(i for i, call in enumerate(runs.calls) if call[0] == "/usr/bin/perl" and "->set_lock" in call[3])
    current = next(i for i, call in enumerate(runs.calls) if call[:3] == ["pvesh", "get", "/nodes/davion-gem/qemu/100/status/current"])
    unlock = next(i for i, call in enumerate(runs.calls) if call[0] == "/usr/bin/perl" and "->remove_lock" in call[3])
    assert acquire < current < verbs.index("lvcreate") < unlock < verbs.index("mount")
    create = next(call for call in runs.calls if call[0] == "lvcreate")
    assert create[-1] == "pve/vm-100-disk-0" and "st-backup-100" in create and "--snapshot" in create
    assert ["losetup", "--find", "--show", "--read-only", "--partscan", "/dev/pve/st-backup-100"] in runs.calls
    mount = next(call for call in runs.calls if call[0] == "mount")
    assert mount[-2] == "/dev/loop7p1" and "ro,nodev,nosuid,noexec,norecovery" in mount
    tar = next(call for call in runs.calls if call[0] == "tar")
    assert "--exclude=Cache" in tar and mount[-1] in tar and "home/u/p" in tar
    assert verbs[-3:] == ["umount", "losetup", "lvremove"]
    assert list(tmp_path.glob("st-backup-100-*")) == []


def test_a_stopped_vm_path_that_leaves_the_guest_filesystem_is_refused_and_released(dispatcher, tmp_path, monkeypatch):
    monkeypatch.setattr(dispatcher, "MOUNT_PARENT", str(tmp_path))
    digests = _install(dispatcher, {"vm": VM})
    answers = _stopped()
    answers["mount"] = lambda argv: (Path(argv[-1]) / "home").symlink_to("/etc") or ""
    runs = Runs(answers)
    assert dispatcher.main(f"capture vm {digests['vm']}", run=runs, out=io.BytesIO()) == 2
    assert not any(call[0] == "tar" for call in runs.calls)
    assert [call[0] for call in runs.calls][-3:] == ["umount", "losetup", "lvremove"]


def _running_snapshot(failure=None, *, current="running", cached="running"):
    answers = _stopped()
    original = answers["pvesh"]
    state: dict[str, Any] = {"freeze": "thawed", "lock": None, "attempts": [], "power": current}

    def pvesh(argv):
        if argv[2] == "/cluster/resources":
            return json.dumps([{"vmid": 100, "type": "qemu", "node": "davion-gem", "status": cached}])
        if argv[2] == "/nodes/davion-gem/qemu/100/status/current":
            assert state["lock"] == "ours"
            return json.dumps({"status": state["power"], "qmpstatus": state.get("qmpstatus")})
        if failure == "locked":
            return json.dumps({"lock": "backup", "scsi0": "local-lvm:vm-100-disk-0"})
        return original(argv)

    def lock(argv):
        if "->set_lock" in argv[3]:
            if failure == "native-wins":
                state["lock"] = "native-backup"
                state["freeze"] = "frozen"
            if state["lock"]:
                return (1, "", "VM is locked (backup)")
            state["lock"] = "ours"
            if failure == "signal-acquire":
                signal.raise_signal(signal.SIGTERM)
        else:
            assert '->remove_lock($ARGV[0], "backup")' in argv[3]
            if failure == "foreign-lock":
                state["lock"] = "migration"
            if state["lock"] != "ours":
                return (1, "", "found lock migration trying to remove backup lock")
            assert (not state.get("thaw_attempted") or state["freeze"] == "thawed" or state["power"] == "stopped"
                    or (state["power"] == "running" and state.get("qmpstatus") == "shutdown"))
            state["lock"] = None
            if failure == "signal-unlock":
                signal.raise_signal(signal.SIGTERM)
        return ""

    def native_attempt():
        if state["lock"]:
            state["attempts"].append("blocked")
        else:
            state["attempts"].append("acquired")
            state["lock"] = "native-backup"
            state["freeze"] = "frozen"

    def qm(argv):
        verb = argv[-1]
        if verb == "fsfreeze-status":
            reported = state["freeze"]
            if failure == "native-during-window":
                # The native contender runs after our status result but before our next command.
                native_attempt()
            if failure == "signal-confirm" and state.get("thaw_attempted"):
                signal.raise_signal(signal.SIGTERM)
            return reported
        if verb == "fsfreeze-freeze":
            if state["freeze"] == "frozen":
                return (1, "", "already frozen")
            state["freeze"] = "frozen"
            return (1 if failure == "freeze" else 0, "1")
        if verb == "fsfreeze-thaw":
            state["thaw_attempted"] = True
            if failure in ("signal-thaw", "signal-thaw-fails"):
                signal.raise_signal(signal.SIGTERM)
            if failure in ("thaw", "signal-thaw-fails"):
                return (1, "")
            state["freeze"] = "thawed"
            return "1"
        raise AssertionError(argv)

    def create(argv):
        assert state["freeze"] == ("frozen" if state["power"] == "running" else "thawed")
        if failure == "create":
            raise subprocess.CalledProcessError(1, argv)
        if failure == "signal":
            signal.raise_signal(signal.SIGTERM)
        return ""

    answers.update({"pvesh": pvesh, "qm": qm, "lvcreate": create, "/usr/bin/perl": lock})
    return answers, state


def test_a_native_start_winning_before_backup_acquisition_uses_fresh_running_state(dispatcher, tmp_path, monkeypatch):
    monkeypatch.setattr(dispatcher, "MOUNT_PARENT", str(tmp_path))
    digest = _install(dispatcher, {"vm": VM})["vm"]
    answers, state = _running_snapshot(current="stopped", cached="stopped")
    operation = answers["/usr/bin/perl"]

    def lock(argv):
        if "->set_lock" in argv[3]:
            # Native start wins its config lock after our stopped observation, before set_lock.
            assert state["lock"] is None and state["power"] == "stopped"
            state["power"] = "running"
            state["attempts"].append("started-before-acquire")
        return operation(argv)

    answers["/usr/bin/perl"] = lock
    runs = Runs(answers)
    assert dispatcher.main(f"capture vm {digest}", run=runs, out=io.BytesIO()) == 0
    acquire = next(i for i, call in enumerate(runs.calls) if call[0] == "/usr/bin/perl" and "->set_lock" in call[3])
    current = next(i for i, call in enumerate(runs.calls) if call[:3] == ["pvesh", "get", "/nodes/davion-gem/qemu/100/status/current"])
    freeze = next(i for i, call in enumerate(runs.calls) if call[-1] == "fsfreeze-freeze")
    create = next(i for i, call in enumerate(runs.calls) if call[0] == "lvcreate")
    assert acquire < current < freeze < create
    assert state["freeze"] == "thawed" and state["lock"] is None and state["power"] == "running"
    assert state["attempts"] == ["started-before-acquire"]


def test_a_native_start_after_backup_acquisition_is_blocked_until_the_stopped_snapshot_exists(dispatcher, tmp_path, monkeypatch):
    monkeypatch.setattr(dispatcher, "MOUNT_PARENT", str(tmp_path))
    digest = _install(dispatcher, {"vm": VM})["vm"]
    answers, state = _running_snapshot(current="stopped", cached="stopped")
    operation, current = answers["/usr/bin/perl"], answers["pvesh"]

    def native_start():
        if state["lock"]:
            state["attempts"].append("blocked")
        else:
            state["attempts"].append("started")
            state["power"] = "running"

    def lock(argv):
        result = operation(argv)
        native_start()  # Native qm start checks the backup flag under its own config lock.
        return result

    def pvesh(argv):
        if argv[2].endswith("/status/current"):
            native_start()
        return current(argv)

    def create(argv):
        assert state["lock"] == "ours" and state["power"] == "stopped"
        native_start()
        assert state["power"] == "stopped"
        return ""

    answers.update({"/usr/bin/perl": lock, "pvesh": pvesh, "lvcreate": create})
    runs = Runs(answers)
    assert dispatcher.main(f"capture vm {digest}", run=runs, out=io.BytesIO()) == 0
    assert state["attempts"] == ["blocked", "blocked", "blocked", "started"]
    assert state["lock"] is None and state["power"] == "running"
    assert not any(call[0] == "qm" for call in runs.calls)
    create_at = next(i for i, call in enumerate(runs.calls) if call[0] == "lvcreate")
    unlock = next(i for i, call in enumerate(runs.calls) if call[0] == "/usr/bin/perl" and "->remove_lock" in call[3])
    assert create_at < unlock < next(i for i, call in enumerate(runs.calls) if call[0] == "mount")


@pytest.mark.parametrize("status", ["unknown", None])
def test_unconfirmed_current_vm_state_releases_our_flag_without_freeze_thaw_or_snapshot(dispatcher, tmp_path, monkeypatch, status):
    monkeypatch.setattr(dispatcher, "MOUNT_PARENT", str(tmp_path))
    digest = _install(dispatcher, {"vm": VM})["vm"]
    answers, state = _running_snapshot(current=status, cached="stopped")
    runs = Runs(answers)
    assert dispatcher.main(f"capture vm {digest}", run=runs, out=io.BytesIO()) == 2
    assert state["lock"] is None and state["freeze"] == "thawed"
    assert not any(call[0] in ("qm", "lvcreate", "mount", "tar") for call in runs.calls)


def test_running_vm_freezes_only_for_thin_snapshot_then_streams_plain_tar_on_the_host(dispatcher, tmp_path, monkeypatch):
    monkeypatch.setattr(dispatcher, "MOUNT_PARENT", str(tmp_path))
    digest = _install(dispatcher, {"vm": VM})["vm"]
    answers, state = _running_snapshot()
    runs = Runs(answers)
    assert dispatcher.main(f"capture vm {digest}", run=runs, out=io.BytesIO()) == 0
    verbs = [call[0] for call in runs.calls]
    freeze = next(i for i, call in enumerate(runs.calls) if call[-1] == "fsfreeze-freeze")
    thaw = next(i for i, call in enumerate(runs.calls) if call[-1] == "fsfreeze-thaw")
    assert freeze < verbs.index("lvcreate") < thaw < verbs.index("mount") < verbs.index("tar")
    assert state["freeze"] == "thawed" and state["lock"] is None
    acquire = next(i for i, call in enumerate(runs.calls) if call[0] == "/usr/bin/perl" and "->set_lock" in call[3])
    unlock = next(i for i, call in enumerate(runs.calls) if call[0] == "/usr/bin/perl" and "->remove_lock" in call[3])
    assert acquire < freeze < thaw < unlock < verbs.index("mount")
    assert not any("file-read" in " ".join(call) or call[0] in ("ssh", "pct") for call in runs.calls)
    assert verbs[-3:] == ["umount", "losetup", "lvremove"]


@pytest.mark.parametrize("failure", ["freeze", "create", "signal", "thaw", "locked"])
def test_failed_snapshot_or_signal_thaws_before_cleanup_and_never_streams(dispatcher, tmp_path, monkeypatch, failure):
    monkeypatch.setattr(dispatcher, "MOUNT_PARENT", str(tmp_path))
    digest = _install(dispatcher, {"vm": VM})["vm"]
    answers, state = _running_snapshot(failure)
    runs = Runs(answers)
    with dispatcher.capture_signals():
        assert dispatcher.main(f"capture vm {digest}", run=runs, out=io.BytesIO()) == (75 if failure == "locked" else 2)
    assert not any(call[0] in ("mount", "tar") for call in runs.calls)
    if failure != "locked":
        assert any(call[-1] == "fsfreeze-thaw" for call in runs.calls)
        assert state["freeze"] == ("frozen" if failure == "thaw" else "thawed")
        assert state["lock"] == ("ours" if failure == "thaw" else None)
        assert runs.calls[-1][:2] == ["lvremove", "-f"]
    else:
        assert not any(call[0] in ("qm", "lvcreate") for call in runs.calls)


def test_an_already_frozen_guest_is_not_thawed_by_this_capture(dispatcher, tmp_path, monkeypatch):
    monkeypatch.setattr(dispatcher, "MOUNT_PARENT", str(tmp_path))
    digest = _install(dispatcher, {"vm": VM})["vm"]
    answers, state = _running_snapshot()
    state["freeze"] = "frozen"
    runs = Runs(answers)
    assert dispatcher.main(f"capture vm {digest}", run=runs, out=io.BytesIO()) == 2
    assert not any(call[-1] in ("fsfreeze-freeze", "fsfreeze-thaw") or call[0] in ("lvcreate", "mount", "tar") for call in runs.calls)
    assert state["lock"] is None and state["freeze"] == "frozen"


def _poweroff_snapshot(phase, terminal, *, failure=None, stop=None):
    answers, state = _running_snapshot(failure)
    original = answers["qm"]

    def qm(argv):
        verb = argv[-1]
        off = ((phase == "before-freeze" and verb == "fsfreeze-status" and not state.get("thaw_attempted"))
               or (phase == "freeze" and verb == "fsfreeze-freeze")
               or (phase in {"thaw", "thaw-exception"} and verb == "fsfreeze-thaw")
               or (phase == "confirm" and verb == "fsfreeze-status" and state.get("thaw_attempted")))
        if off:
            state.update(terminal)
            if stop:
                signal.raise_signal(stop)
        if state["power"] == "stopped" or state.get("qmpstatus") == "shutdown":
            if verb == "fsfreeze-thaw":
                state["thaw_attempted"] = True
                if phase == "thaw-exception":
                    raise OSError("synthetic QGA process failure after guest shutdown")
            return (1, "", "guest agent is not running")
        return original(argv)

    answers["qm"] = qm
    return answers, state


@pytest.mark.parametrize("phase", ["before-freeze", "freeze", "thaw", "thaw-exception", "confirm"])
@pytest.mark.parametrize("terminal", [{"power": "stopped"}, {"power": "running", "qmpstatus": "shutdown"}])
def test_poweroff_in_the_short_snapshot_transaction_releases_only_our_flag_and_defers(dispatcher, tmp_path, monkeypatch, phase, terminal):
    monkeypatch.setattr(dispatcher, "MOUNT_PARENT", str(tmp_path))
    digest = _install(dispatcher, {"vm": VM})["vm"]
    answers, state = _poweroff_snapshot(phase, terminal)
    runs = Runs(answers)
    assert dispatcher.main(f"capture vm {digest}", run=runs, out=io.BytesIO()) == 75
    assert state["lock"] is None
    assert not any(call[0] in ("mount", "tar") for call in runs.calls)
    if phase in {"before-freeze", "freeze"}:
        assert not any(call[-1] == "fsfreeze-thaw" for call in runs.calls)
    if phase == "before-freeze":
        assert not any(call[-1] == "fsfreeze-freeze" for call in runs.calls)
    current = [i for i, call in enumerate(runs.calls) if call[:3] == ["pvesh", "get", "/nodes/davion-gem/qemu/100/status/current"]]
    unlock = next(i for i, call in enumerate(runs.calls) if call[0] == "/usr/bin/perl" and "->remove_lock" in call[3])
    assert len(current) == 2 and current[-1] < unlock


def test_an_already_terminal_qmp_shutdown_is_deferred_without_any_qga_action(dispatcher, tmp_path, monkeypatch):
    monkeypatch.setattr(dispatcher, "MOUNT_PARENT", str(tmp_path))
    digest = _install(dispatcher, {"vm": VM})["vm"]
    answers, state = _running_snapshot()
    state["qmpstatus"] = "shutdown"
    runs = Runs(answers)
    assert dispatcher.main(f"capture vm {digest}", run=runs, out=io.BytesIO()) == 75
    assert state["lock"] is None
    assert not any(call[0] in ("qm", "lvcreate", "mount", "tar") for call in runs.calls)


@pytest.mark.parametrize("result", [json.dumps({"status": "running", "qmpstatus": "paused"}),
                                   json.dumps({"status": "running", "qmpstatus": "suspended"}),
                                   json.dumps({"status": "unknown", "qmpstatus": "shutdown"}),
                                   "{}", "not json", (1, "", "status unavailable")])
def test_unconfirmed_poweroff_retains_the_unconfirmed_thaw_safety_flag(dispatcher, tmp_path, monkeypatch, capsys, result):
    monkeypatch.setattr(dispatcher, "MOUNT_PARENT", str(tmp_path))
    digest = _install(dispatcher, {"vm": VM})["vm"]
    answers, state = _running_snapshot("thaw")
    original = answers["pvesh"]

    def pvesh(argv):
        if argv[2].endswith("/status/current") and state.get("thaw_attempted"):
            return result
        return original(argv)

    answers["pvesh"] = pvesh
    runs = Runs(answers)
    assert dispatcher.main(f"capture vm {digest}", run=runs, out=io.BytesIO()) == 2
    assert state["lock"] == "ours" and state["freeze"] == "frozen"
    assert "Proxmox backup lock retained" in capsys.readouterr().err
    assert not any(call[0] in ("mount", "tar") or (call[0] == "/usr/bin/perl" and "->remove_lock" in call[3]) for call in runs.calls)


def test_poweroff_cleanup_cannot_clear_a_foreign_flag(dispatcher, tmp_path, monkeypatch):
    monkeypatch.setattr(dispatcher, "MOUNT_PARENT", str(tmp_path))
    digest = _install(dispatcher, {"vm": VM})["vm"]
    answers, state = _poweroff_snapshot("thaw", {"power": "stopped"}, failure="foreign-lock")
    runs = Runs(answers)
    assert dispatcher.main(f"capture vm {digest}", run=runs, out=io.BytesIO()) == 2
    assert state["lock"] == "migration"


@pytest.mark.parametrize("number", [signal.SIGTERM, signal.SIGHUP, signal.SIGINT])
def test_first_cancellation_during_poweroff_cleanup_releases_our_flag_before_deferred_result(dispatcher, tmp_path, monkeypatch, number):
    monkeypatch.setattr(dispatcher, "MOUNT_PARENT", str(tmp_path))
    digest = _install(dispatcher, {"vm": VM})["vm"]
    answers, state = _poweroff_snapshot("thaw", {"power": "stopped"}, stop=number)
    runs = Runs(answers)
    with dispatcher.capture_signals():
        assert dispatcher.main(f"capture vm {digest}", run=runs, out=io.BytesIO()) == 75
    assert state["lock"] is None
    assert not any(call[0] in ("mount", "tar") for call in runs.calls)


def test_host_capture_reenters_only_under_the_independent_guard(dispatcher, monkeypatch):
    digest = _install(dispatcher, {"host": HOST})["host"]
    monkeypatch.setenv("SSH_ORIGINAL_COMMAND", f"capture host {digest}")
    runs = Runs({dispatcher.GUARD: (75, "")})
    assert dispatcher.entrypoint([], run=runs, out=io.BytesIO()) == 75
    assert runs.calls == [[dispatcher.GUARD, "run", "--", dispatcher.DISPATCHER, "--guarded-capture", "host", digest]]
    monkeypatch.setenv("SSH_ORIGINAL_COMMAND", f"--guarded-capture host {digest}")
    runs = Runs()
    assert dispatcher.entrypoint([], run=runs, out=io.BytesIO()) == 2
    assert not runs.calls
    monkeypatch.setenv("SSH_ORIGINAL_COMMAND", "id")
    runs = Runs()
    assert dispatcher.entrypoint(["--guarded-capture", "host", digest], run=runs, out=io.BytesIO()) == 0
    assert runs.calls[0][0] == "tar"


def test_missing_guard_fails_before_reading_payload(dispatcher, monkeypatch):
    digest = _install(dispatcher, {"host": HOST})["host"]
    monkeypatch.setenv("SSH_ORIGINAL_COMMAND", f"capture host {digest}")

    def missing(argv, **kwargs):
        assert argv[0] == dispatcher.GUARD
        raise FileNotFoundError("guard not installed")

    assert dispatcher.entrypoint([], run=missing, out=io.BytesIO()) == 2


def test_running_guest_budget_changes_reach_actual_guest_scope_once_and_stale_retains_last_cap(dispatcher, monkeypatch):
    digest = _install(dispatcher, {"ct": CT})["ct"]
    ticks = [lambda: _budget(dispatcher, 20), lambda: _budget(dispatcher, 20),
             lambda: _budget(dispatcher, 10), lambda: _budget(dispatcher, 50, observed_at=0)]
    calls, process = _stream_process(monkeypatch, Stream(ticks))
    runs = Runs(_container("running"))
    assert dispatcher.main(f"capture ct {digest}", run=runs, out=io.BytesIO()) == 0
    updates = [call for call in runs.calls if "set-property" in call]
    assert [call[-1] for call in updates] == ["CPUQuota=20%", "CPUQuota=10%"]
    assert len({call[-2] for call in updates}) == 1 and updates[0][-2] in calls[0][-1]
    assert not process.terminated


def test_control_failure_stops_only_its_own_producer_and_preserves_failure(dispatcher, monkeypatch, capsys):
    digest = _install(dispatcher, {"ct": CT})["ct"]
    calls, process = _stream_process(monkeypatch, Stream([lambda: _budget(dispatcher, 10)]))
    runs = Runs(_container("running"))
    original = runs.__call__

    def run(argv, **kwargs):
        if "set-property" in argv:
            runs.calls.append(argv)
            return subprocess.CompletedProcess(argv, 1, "", "denied")
        return original(argv, **kwargs)

    assert dispatcher.main(f"capture ct {digest}", run=run, out=io.BytesIO()) == 2
    assert "ceiling could not be changed" in capsys.readouterr().err
    assert process.terminated and "stop" in runs.calls[-1]
    scope = runs.calls[-1][-1]
    assert scope in calls[0][-1]


def _local_export(dispatcher, tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    systemd = bin_dir / "systemd-run"
    systemd.write_text('#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n')
    systemd.chmod(0o755)
    ctl = bin_dir / "systemctl"
    cleanup = tmp_path / "cleanup"
    ctl.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> ' + shlex.quote(str(cleanup)) + '\n')
    ctl.chmod(0o755)
    monkeypatch.setenv("PATH", str(bin_dir) + ":" + os.environ["PATH"])
    monkeypatch.setattr(dispatcher, "GUEST_LOCK", str(tmp_path / "guest.lock"))
    monkeypatch.setattr(dispatcher, "guest_command", lambda vmid, argv: argv)
    source = tmp_path / "source"
    source.mkdir()
    return source, cleanup


@pytest.mark.skipif(shutil.which("tar") is None, reason="needs GNU tar")
def test_real_stream_roundtrips_without_chunks_and_cleans_its_guest_scope(dispatcher, tmp_path, monkeypatch):
    source, cleanup = _local_export(dispatcher, tmp_path, monkeypatch)
    (source / "saved.txt").write_text("synthetic durable payload")
    output = tmp_path / "stream.tar"
    with output.open("wb") as out:
        assert dispatcher.guest_stream(100, {"paths": [str(source)], "excludes": []}, out) == 0
    restored = subprocess.run(["tar", "-xOf", str(output), str(source).lstrip("/") + "/saved.txt"],
                              capture_output=True, check=True).stdout
    assert restored == b"synthetic durable payload"
    assert "stop aico-backup-export-" in cleanup.read_text()
    assert not list(tmp_path.glob("st-backup-*"))


@pytest.mark.skipif(shutil.which("tar") is None, reason="needs GNU tar")
def test_broken_output_fails_and_releases_real_stream_processes_and_lock(dispatcher, tmp_path, monkeypatch):
    source, cleanup = _local_export(dispatcher, tmp_path, monkeypatch)
    (source / "payload").write_bytes(os.urandom(2 * 1024 * 1024))
    read_fd, write_fd = os.pipe()
    os.close(read_fd)
    with os.fdopen(write_fd, "wb") as out, pytest.raises(dispatcher.Refused, match="guest file stream failed"):
        dispatcher.guest_stream(100, {"paths": [str(source)], "excludes": []}, out)
    assert "stop aico-backup-export-" in cleanup.read_text()
    with (tmp_path / "guest.lock").open("a") as lock:
        __import__("fcntl").flock(lock, __import__("fcntl").LOCK_EX | __import__("fcntl").LOCK_NB)


@pytest.mark.parametrize("changes", [{"admission_open": False}, {"observed_at": 0}, {"boot_id": "previous-boot"}])
def test_guard_change_before_container_start_defers_without_launching_a_producer(dispatcher, monkeypatch, changes):
    digest = _install(dispatcher, {"ct": CT})["ct"]
    _budget(dispatcher, **changes)
    calls, _ = _stream_process(monkeypatch)
    assert dispatcher.main(f"capture ct {digest}", run=Runs(_container("running")), out=io.BytesIO()) == 75
    assert not calls


def test_a_guest_export_lock_conflict_is_busy_and_cleans_only_its_unique_scope(dispatcher, monkeypatch):
    digest = _install(dispatcher, {"ct": CT})["ct"]
    process = Stream()
    process.code = 75
    calls, _ = _stream_process(monkeypatch, process)
    runs = Runs(_container("running"))
    assert dispatcher.main(f"capture ct {digest}", run=runs, out=io.BytesIO()) == 75
    assert runs.calls[-1][-1] in calls[0][-1]


@pytest.mark.parametrize("phase", ["acquire", "thaw", "confirm", "unlock"])
def test_first_cancellation_finishes_confirmed_thaw_and_ownership_cleanup(dispatcher, tmp_path, monkeypatch, phase):
    monkeypatch.setattr(dispatcher, "MOUNT_PARENT", str(tmp_path))
    digest = _install(dispatcher, {"vm": VM})["vm"]
    answers, state = _running_snapshot("signal-" + phase)
    runs = Runs(answers)
    with dispatcher.capture_signals():
        assert dispatcher.main(f"capture vm {digest}", run=runs, out=io.BytesIO()) == 2
    assert state["freeze"] == "thawed" and state["lock"] is None
    assert any(call[0] == "/usr/bin/perl" and "->remove_lock" in call[3] for call in runs.calls)
    assert not any(call[0] in ("mount", "tar") for call in runs.calls)
    if phase != "acquire":
        thaw = next(i for i, call in enumerate(runs.calls) if call[-1] == "fsfreeze-thaw")
        confirmed = next(i for i, call in enumerate(runs.calls) if i > thaw and call[-1] == "fsfreeze-status")
        unlock = next(i for i, call in enumerate(runs.calls) if call[0] == "/usr/bin/perl" and "->remove_lock" in call[3])
        assert thaw < confirmed < unlock


def test_cancellation_cannot_hide_a_failed_thaw_or_release_its_safety_lock(dispatcher, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(dispatcher, "MOUNT_PARENT", str(tmp_path))
    digest = _install(dispatcher, {"vm": VM})["vm"]
    answers, state = _running_snapshot("signal-thaw-fails")
    runs = Runs(answers)
    with dispatcher.capture_signals():
        assert dispatcher.main(f"capture vm {digest}", run=runs, out=io.BytesIO()) == 2
    assert state["freeze"] == "frozen" and state["lock"] == "ours"
    assert "Proxmox backup lock retained" in capsys.readouterr().err
    assert not any(call[0] in ("mount", "tar") or (call[0] == "/usr/bin/perl" and "->remove_lock" in call[3]) for call in runs.calls)


@pytest.mark.parametrize("number", [signal.SIGTERM, signal.SIGHUP, signal.SIGINT])
def test_cleanup_child_inherits_the_cancellation_shield_and_pending_stop_follows_confirmation(dispatcher, number):
    completed = []
    program = "import os, signal; os.kill(os.getppid(), int(__import__('sys').argv[1])); os.kill(os.getpid(), int(__import__('sys').argv[1])); print('cleanup child completed', flush=True)"
    with (dispatcher.capture_signals(), pytest.raises(dispatcher.Refused, match=signal.Signals(number).name),
          dispatcher.shield_capture_signals()):
        child = subprocess.run([sys.executable, "-c", program, str(number)], capture_output=True, text=True, check=True)
        completed.extend([child.stdout.strip(), "thaw confirmed"])
    assert completed == ["cleanup child completed", "thaw confirmed"]


def test_a_native_backup_winning_after_the_boot_config_read_is_never_thawed_or_unlocked(dispatcher, tmp_path, monkeypatch):
    monkeypatch.setattr(dispatcher, "MOUNT_PARENT", str(tmp_path))
    digest = _install(dispatcher, {"vm": VM})["vm"]
    answers, state = _running_snapshot("native-wins")
    runs = Runs(answers)
    assert dispatcher.main(f"capture vm {digest}", run=runs, out=io.BytesIO()) == 75
    assert state["lock"] == "native-backup" and state["freeze"] == "frozen"
    assert not any(call[0] == "qm" or (call[0] == "/usr/bin/perl" and "->remove_lock" in call[3]) for call in runs.calls)


def test_native_backup_cannot_acquire_our_flag_between_status_freeze_snapshot_and_thaw(dispatcher, tmp_path, monkeypatch):
    monkeypatch.setattr(dispatcher, "MOUNT_PARENT", str(tmp_path))
    digest = _install(dispatcher, {"vm": VM})["vm"]
    answers, state = _running_snapshot("native-during-window")
    runs = Runs(answers)
    assert dispatcher.main(f"capture vm {digest}", run=runs, out=io.BytesIO()) == 0
    assert state["attempts"] == ["blocked", "blocked", "blocked"]
    assert state["lock"] is None and state["freeze"] == "thawed"


def test_expected_lock_value_prevents_clearing_a_foreign_operation_flag(dispatcher, tmp_path, monkeypatch):
    monkeypatch.setattr(dispatcher, "MOUNT_PARENT", str(tmp_path))
    digest = _install(dispatcher, {"vm": VM})["vm"]
    answers, state = _running_snapshot("foreign-lock")
    runs = Runs(answers)
    assert dispatcher.main(f"capture vm {digest}", run=runs, out=io.BytesIO()) == 2
    assert state["lock"] == "migration" and state["freeze"] == "thawed"
    assert not any(call[0] in ("mount", "tar") for call in runs.calls)


@pytest.mark.parametrize("number", [signal.SIGTERM, signal.SIGHUP, signal.SIGINT])
@pytest.mark.parametrize("power", ["running", "stopped"])
def test_first_stop_at_the_finally_boundary_is_already_masked_and_cannot_skip_cleanup(dispatcher, tmp_path, monkeypatch, number, power):
    monkeypatch.setattr(dispatcher, "MOUNT_PARENT", str(tmp_path))
    digest = _install(dispatcher, {"vm": VM})["vm"]
    answers, state = _running_snapshot(current=power)
    runs = Runs(answers)
    lines, first = inspect.getsourcelines(dispatcher.qemu_snapshot)
    boundary = first + next(i for i, line in enumerate(lines) if line.strip() == "if owned:")
    observed = []

    def trace(frame, event, arg):
        if frame.f_code is dispatcher.qemu_snapshot.__code__ and event == "line" and frame.f_lineno == boundary and not observed:
            observed.append(number in signal.pthread_sigmask(signal.SIG_BLOCK, []))
            # This is the first stop, before any statement in the finally body can run.
            signal.raise_signal(number)
        return trace

    previous = sys.gettrace()
    with dispatcher.capture_signals():
        try:
            sys.settrace(trace)
            assert dispatcher.main(f"capture vm {digest}", run=runs, out=io.BytesIO()) == 2
        finally:
            sys.settrace(previous)
    assert observed == [True]
    assert state["freeze"] == "thawed" and state["lock"] is None
    assert not any(call[0] in ("mount", "tar") for call in runs.calls)
    if power == "stopped":
        assert not any(call[0] == "qm" for call in runs.calls)
