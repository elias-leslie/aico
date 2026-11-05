#!/usr/bin/env python3
"""Standalone Aico recovery: Python + rsync/restic; no ST, Aico API or database dependency.

All output is metadata. Child stdout/stderr is captured, never forwarded. Source
repositories are always opened with --no-lock: even stale locks stay untouched.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
import re
import shutil
import signal
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path


class RecoveryError(Exception):
    pass


def require(value, message):
    if not value:
        raise RecoveryError(message)


def load(path):
    return json.loads(Path(path).expanduser().read_text())


def expanded(path):
    return Path(path).expanduser().absolute()


def real(path):
    path = expanded(path)
    require(path.resolve() == path, 'Path contains a symlink or traversal.')
    return path


def private_file(path):
    path = real(path)
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
            and stat.S_IMODE(info.st_mode) == 0o600, 'Credential file must be private (0600).')
    return path


def scratch(root, destination):
    root = real(root)
    require(root.is_dir(), 'Scratch root must exist.')
    destination = real(destination)
    require(destination != root and root in destination.parents, 'Restore only below the scratch root.')
    require(not destination.exists(), 'Choose a new scratch target; existing files are preserved.')
    require(destination.parent.is_dir(), 'Scratch target parent must exist.')
    return destination


def relative_path(raw):
    p = Path(raw)
    require(not p.is_absolute() and p.parts and all(x not in ('.', '..') for x in p.parts),
            'Destination mapping must stay inside scratch.')
    return p


def run(argv, *, env=None, check=True):
    with subprocess.Popen([str(a) for a in argv], env=env, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True) as child:
        try:
            out, err = child.communicate()
        except BaseException:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                child.wait()
            raise
        result = subprocess.CompletedProcess(argv, child.returncode, out, err)
    if check:
        require(result.returncode == 0, f'{Path(argv[0]).name} failed (exit {result.returncode}); no output shown.')
    return result


def restic_base(spec, *, readonly=True):
    repo = spec['repository']
    require(isinstance(repo, str) and '\n' not in repo and '\0' not in repo, 'Invalid repository.')
    if not repo.startswith('rclone:'):
        require(real(repo).is_dir() and str(real(repo)) != '/', 'Local repository must exist.')
    else:
        require(re.fullmatch(r'rclone:[A-Za-z0-9_-]+:[A-Za-z0-9_./-]+', repo)
                and all(p not in ('', '.', '..') for p in repo.split(':', 2)[2].split('/')),
                'Use a bounded repository folder.')
    argv = ['restic', '--repo', repo, '--password-file', str(private_file(spec['passwordFile'])), '--no-cache']
    if readonly:
        argv += ['--no-lock']
    env = {k: v for k, v in os.environ.items() if not k.startswith(('RESTIC_', 'RCLONE_', 'AWS_', 'B2_', 'AZURE_'))}
    env['GOMAXPROCS'] = spec.get('gomaxprocs', '4')
    env['GOMEMLIMIT'] = spec.get('gomemlimit', '2GiB')
    if spec.get('rcloneConfig'):
        # Token refresh may rewrite rclone's file. The caller supplies a private scratch copy.
        env['RCLONE_CONFIG'] = str(private_file(spec['rcloneConfig']))
    if spec.get('ssh'):
        s = spec['ssh']
        key = private_file(s['key'])
        require(re.fullmatch(r'[A-Za-z0-9_.@-]+', s['host']) and str(s['port']).isdigit(), 'Invalid SSH endpoint.')
        require(not any(c.isspace() for c in str(key)), 'SSH credential path must contain no whitespace.')
        argv += ['-o', f'rclone.program=ssh -F /dev/null -p {s["port"]} -i {key} -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes {s["host"]}',
                 '-o', 'rclone.args=serve restic --stdio']
    return argv, env


def repo_run(spec, args, *, readonly=True, check=True):
    argv, env = restic_base(spec, readonly=readonly)
    return run(argv + args, env=env, check=check)


def repository_check(spec):
    result = repo_run(spec, ['check'], check=False)
    return {'ok': result.returncode == 0, 'exit': result.returncode, 'readOnly': True}


def select_snapshot(spec, source, snapshot=None):
    result = repo_run(spec, ['snapshots', '--json', '--tag', f'source:{source}'])
    rows = json.loads(result.stdout) or []
    valid = [s for s in rows if re.fullmatch('[a-f0-9]{64}', s.get('id', ''))]
    if snapshot:
        valid = [s for s in valid if s['id'] == snapshot]
    require(valid, 'No snapshot for this source. Check the password and source selection.')
    return max(valid, key=lambda s: s['time'])


def config(path):
    path = real(path)
    cfg = load(path)
    require(cfg.get('version') == 1, 'Unsupported recovery configuration.')
    cfg['_file'] = str(path)
    cfg['_backup'] = load(path.parent / cfg['backupConfig'])
    cfg['_import'] = load(path.parent / cfg['importConfig'])
    cfg['_loginPolicy'] = load(path.parent / cfg['loginPolicy'])
    return cfg


def append_spec(cfg, machine):
    b = cfg['_backup']
    m = cfg['machines'][machine]
    client = b['appendClients'][m['machine']]
    return {'repository': client['repository'], 'passwordFile': m['passwordFile'],
            'ssh': {'key': m['key'], 'host': b['pve']['user'] + '@' + b['pve']['address'], 'port': b['pve']['port']}}


def native_items(cfg, machine, state):
    result = []
    for item in cfg['machines'][machine]['items']:
        path = real(item['path'])
        require(not any(path == Path(p) or Path(p) in path.parents for p in cfg['forbiddenPaths']), 'Excluded project.')
        points = [p for p in state['points'] if path == Path(p['source']) or Path(p['source']) in path.parents]
        require(points, 'No native recovery point covers an item.')
        point = max(points, key=lambda p: len(p['source']))
        root = Path(point['target'])
        require(root.is_absolute(), 'Native recovery point must be absolute.')
        result.append({**item, 'from': str(root / path.relative_to(point['source'])),
                       'snapshotRoot': str(root), 'dataAt': point['dataAt']})
    return result


def plan(cfg, machine, destination):
    to = scratch(cfg['scratchRoot'], destination)
    require(machine in cfg['machines'], 'Choose a configured machine.')
    spec = cfg['machines'][machine]
    items = spec['items']
    for item in items:
        relative_path(item['into'])
        require(Path(item['path']).is_absolute() and '..' not in Path(item['path']).parts, 'Invalid restore path.')
    if spec['kind'] == 'native':
        items = native_items(cfg, machine, load(cfg['backupState']))
    else:
        require(spec['kind'] == 'append', 'Unsupported recovery source.')
    if spec.get('projectFrom'):
        items = [*items, *[item for item in native_items(cfg, spec['projectFrom'], load(cfg['backupState'])) if item['into'] == 'repo']]
    return {'machine': machine, 'kind': spec['kind'], 'destination': str(to), 'items': items,
            'activatesUnits': False, 'scratchOnly': True}


def native_copy(cfg, item, destination):
    # Validate containment with the same privilege needed to read the root-only T7.
    source = item['from']
    found = run(['sudo', '-n', 'realpath', '-e', '--', source], check=False)
    if found.returncode and item.get('optional'):
        return False
    require(found.returncode == 0, 'Native backup item is missing.')
    root = run(['sudo', '-n', 'realpath', '-e', '--', item['snapshotRoot']]).stdout.decode().strip()
    actual = found.stdout.decode().strip()
    require(actual == root or actual.startswith(root + '/'), 'Native item escapes its snapshot.')
    kind = run(['sudo', '-n', 'test', '-d', source], check=False).returncode == 0
    destination.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    if kind:
        destination.mkdir(mode=0o700)
    excludes = [v for pattern in cfg['exclude'] for v in ['--exclude', pattern]]
    run(['sudo', '-n', 'rsync', '-a', '--safe-links', *excludes, '--', source + ('/' if kind else ''), str(destination) + ('/' if kind else '')])
    # rsync checksum dry-run proves both payload and metadata before changing ownership.
    verified = run(['sudo', '-n', 'rsync', '-acni', '--safe-links', *excludes, '--', source + ('/' if kind else ''), str(destination) + ('/' if kind else '')])
    require(not verified.stdout, 'Native restore checksum differs.')
    run(['sudo', '-n', 'chown', '-Rh', f'{os.getuid()}:{os.getgid()}', str(destination)])
    return True


def restore(cfg, machine, destination):
    prepared = plan(cfg, machine, destination)
    to = Path(prepared['destination'])
    to.mkdir(mode=0o700)
    if prepared['kind'] == 'native':
        for item in prepared['items']:
            native_copy(cfg, item, to / item['into'])
    else:
        spec = append_spec(cfg, machine)
        selected = select_snapshot(spec, cfg['machines'][machine]['source'])
        prepared['snapshot'] = selected['id']
        prepared['dataAt'] = selected['time']
        raw = to / 'raw'
        # Restore reads the immutable snapshot and verifies files; never unlocks or repairs the source.
        repo_run(spec, ['restore', selected['id'], '--target', str(raw), '--verify'])
        for item in prepared['items']:
            if item.get('from'):
                native_copy(cfg, item, to / item['into'])
                continue
            source = raw / item['path'].lstrip('/')
            if item.get('optional') and not source.exists():
                continue
            require(source.exists() and source.resolve() == source, 'Required append backup item is missing or linked.')
            dest = to / item['into']
            dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.move(source, dest)
        db = cfg['machines'][machine].get('tetherDatabase')
        if db:
            (to / 'tether').mkdir(mode=0o700)
            shutil.move(to / 'data' / db, to / 'tether/tether.db')
    require((to / 'data/notes.db').is_file() and (to / 'tether/tether.db').is_file(), 'Aico databases are missing.')
    secrets = to / 'data/secrets'
    require(secrets.is_dir(), 'The backup has no Logins folder; use a newer backup.')
    secrets.chmod(0o700)
    for p in secrets.iterdir():
        require(p.is_file() and not p.is_symlink(), 'Unexpected entry in restored Logins folder.')
        p.chmod(0o600)
    prepared['manual'] = ['Install OS, disks and recovery dependencies.', 'Review restored units/config and machine identity before activation.',
                          'Install dependencies from the restored lockfile; deploy Aico after reviewing paths and host settings.']
    (to / 'recovery.json').write_text(json.dumps(prepared, indent=2) + '\n')
    return prepared


def counts(root, cfg):
    def count(db, query):
        require(db.is_file(), 'Restored database is missing.')
        with sqlite3.connect(f'file:{db}?mode=ro', uri=True) as conn:
            require(conn.execute('PRAGMA quick_check').fetchone()[0] == 'ok', 'Restored database integrity failed.')
            return conn.execute(query).fetchone()[0]
    secrets = root / 'data/secrets'
    index = load(secrets / 'index.json')
    entries = [e for e in index['entries'] if e['file'] not in cfg['_loginPolicy']['localFiles']]
    for e in entries:
        require(Path(e['file']).name == e['file'], 'Invalid Logins file mapping.')
        private_file(secrets / e['file'])
    chats = count(root / 'data/agent.db', "SELECT count(*) FROM chats WHERE state != 'ended'")
    return {'sessions': count(root / 'tether/tether.db', 'SELECT count(*) FROM sessions') + chats,
            'notes': count(root / 'data/notes.db', 'SELECT count(*) FROM notes WHERE deleted = 0'),
            'logins': len(entries)}


def runtime_code(cfg, code):
    if (code / 'packages/web-server/dist/aico-web.mjs').is_file():
        return code
    # Ops-only releases need no web rebuild. Read the live unit's code path;
    # this never starts, stops or changes the unit, and its data stays outside the drill.
    env = {**os.environ}
    env.setdefault('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')
    env.setdefault('DBUS_SESSION_BUS_ADDRESS', f'unix:path={env["XDG_RUNTIME_DIR"]}/bus')
    result = run(['systemctl', '--user', '--no-ask-password', 'show', cfg['runtime']['webUnit'],
                  '--property=WorkingDirectory', '--value'], env=env)
    directory = real(result.stdout.decode().strip())
    code = directory.parent.parent
    require((code / 'packages/web-server/dist/aico-web.mjs').is_file(),
            'No built Aico web runtime found; pass --code for a built checkout.')
    return code


def runtime_command(cfg, root, code):
    # A scratch runtime must not reach owner sockets, restored fleet peers or the network.
    tether = code / 'packages/tether/dist/tether.mjs'
    if not tether.is_file():
        tether = expanded(cfg['runtime']['tetherBundle'])
    return ['bwrap', '--unshare-all', '--die-with-parent', '--tmpfs', '/',
            '--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc',
            '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
            '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev',
            '--tmpfs', '/home', '--tmpfs', '/run', '--tmpfs', '/tmp', '--tmpfs', '/srv',
            '--ro-bind', str(code), '/app', '--ro-bind', str(Path(__file__).resolve().parent), '/recovery',
            '--ro-bind', str(expanded(cfg['runtime']['node']).resolve()), '/node',
            '--ro-bind', str(tether.resolve()), '/tether.mjs',
            '--bind', str(root), '/drill', '--chdir', '/app',
            '--clearenv', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
            'python3', '/recovery/recovery-runtime.py',
            '--root', '/drill', '--node', '/node', '--port', str(cfg['runtime']['port']),
            '--ready-seconds', str(cfg['runtime']['readySeconds'])]


def clean_owned(path, identity):
    info = path.lstat()
    require(not path.is_symlink() and (info.st_dev, info.st_ino, info.st_uid) == identity,
            'Scratch target identity changed; automatic removal refused.')
    try:
        shutil.rmtree(path)
    except PermissionError:
        # A failed sudo rsync can leave root-owned private directories. Only the
        # exact mkdtemp target (identity checked above) is eligible for this fallback.
        run(['sudo', '-n', 'rm', '-rf', '--', str(path)])


def interrupted(_signum, _frame):
    raise RecoveryError('Restore drill interrupted.')


def drill(cfg, code, *, scheduled=False):
    receipt_path = expanded(cfg['receipt'])
    receipt_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Serialise manual and scheduled drills; only this lock file is changed outside scratch.
    with (receipt_path.parent / 'drill.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        now = dt.datetime.now(dt.UTC)
        if scheduled and receipt_path.exists():
            old = load(receipt_path)
            if old.get('started', '')[:7] == now.isoformat()[:7]:
                return {**old, 'skipped': True}
        started = time.monotonic()
        receipt = {'ok': False, 'started': now.isoformat(), 'machines': [], 'manual': [], 'scratchDestroyed': False}
        owned = Path(tempfile.mkdtemp(prefix='aico-drill-', dir=real(cfg['scratchRoot'])))
        info = owned.stat()
        identity = (info.st_dev, info.st_ino, info.st_uid)
        handlers = {s: signal.signal(s, interrupted) for s in [signal.SIGTERM, signal.SIGINT]}
        try:
            for machine in cfg['machines']:
                tick = time.monotonic()
                target = owned / machine
                restored = restore(cfg, machine, target)
                if any(item['into'] == 'repo' for item in restored.get('items', cfg['machines'][machine]['items'])):
                    require((target / 'repo/.git').is_dir(), 'The promised project repository was not restored.')
                    run(['git', '-c', 'core.hooksPath=/dev/null', '-C', str(target / 'repo'), 'rev-parse', '--verify', 'HEAD'])
                    run(['git', '-c', 'core.hooksPath=/dev/null', '-C', str(target / 'repo'), 'fsck', '--full'])
                    receipt['projectRepo'] = {'restored': True, 'fsck': True}
                expected = counts(target, cfg)
                runtime = runtime_code(cfg, real(code))
                receipt['runtimeCode'] = str(runtime)
                result = run(runtime_command(cfg, target, runtime), check=False)
                served = json.loads(result.stdout)
                require(result.returncode == 0, served.get('error', 'Scratch Aico runtime failed.'))
                require(served == expected, 'Restored Aico serves different counts.')
                after = counts(target, cfg)
                require(after == expected, 'Aico startup changed retained counts.')
                receipt['machines'].append({'machine': machine, 'snapshot': restored.get('snapshot'),
                                            'nativePoints': list({item['snapshotRoot']: {'root': item['snapshotRoot'], 'dataAt': item['dataAt']} for item in restored['items'] if item.get('snapshotRoot')}.values()),
                                            'expected': expected, 'served': served, 'after': after,
                                            'durationSeconds': round(time.monotonic() - tick, 3)})
            require(receipt.get('projectRepo'), 'No project repository was verified.')
            receipt['ok'] = True
        except RecoveryError as exc:
            receipt['error'] = str(exc)
        except (OSError, ValueError, sqlite3.Error):
            receipt['error'] = 'Restore drill failed; check recovery inputs and available backups.'
        finally:
            # mkdtemp created this exact directory. No path supplied by a caller is ever removed.
            try:
                clean_owned(owned, identity)
            except (OSError, RecoveryError):
                receipt['ok'] = False
                receipt['error'] = 'Scratch cleanup failed; remove only the recorded owned target after inspection.'
                receipt['scratchTarget'] = str(owned)
            receipt['scratchDestroyed'] = not owned.exists()
            receipt['durationSeconds'] = round(time.monotonic() - started, 3)
            receipt['finished'] = dt.datetime.now(dt.UTC).isoformat()
            temp = receipt_path.with_suffix('.tmp')
            temp.write_text(json.dumps(receipt, indent=2) + '\n')
            temp.chmod(0o600)
            os.replace(temp, receipt_path)
            for sig, handler in handlers.items():
                signal.signal(sig, handler)
        return receipt


def repo_command(args, cfg):
    spec = {'repository': args.repository, 'passwordFile': args.password_file}
    require(spec['repository'] and spec['passwordFile'], 'Repository and password-file references are required.')
    # Any rclone refresh belongs to an owned temporary directory, never the owner's auth file.
    with tempfile.TemporaryDirectory(prefix='aico-recover-', dir=real(cfg['scratchRoot'])) as work:
        if args.rclone_config:
            dest = Path(work) / 'rclone.conf'
            shutil.copyfile(private_file(args.rclone_config), dest)
            dest.chmod(0o600)
            spec['rcloneConfig'] = str(dest)
        diagnosis = repository_check(spec)
        if args.mode == 'check':
            return diagnosis
        if args.mode == 'snapshots':
            result = repo_run(spec, ['snapshots', '--json', *(['--tag', f'source:{args.source}'] if args.source else [])], check=False)
            rows = json.loads(result.stdout) if result.returncode == 0 else []
            return {'diagnosis': diagnosis, 'snapshots': [{'id': s['id'], 'time': s['time'], 'sources': [tag.removeprefix('source:') for tag in s.get('tags', []) if tag.startswith('source:')]} for s in rows or []]}
        target = scratch(cfg['scratchRoot'], args.to)
        require(args.mode != 'restore' or re.fullmatch('[a-f0-9]{64}', args.snapshot or ''), 'Restore requires a full snapshot ID.')
        if args.mode == 'repair':
            source = real(args.repository)
            require(not args.repository.startswith('rclone:'), 'Copy the remote repository locally before scratch repair.')
            require(source not in target.parents and target not in source.parents, 'Repository and scratch copy must be separate.')
            for folder, dirs, files in os.walk(source, followlinks=False):
                require(not any((Path(folder) / name).is_symlink() for name in [*dirs, *files]),
                        'A repair source must not contain symlinks.')
            run(['cp', '-a', '--reflink=auto', '--', str(source), str(target)])
            spec['repository'] = str(target)
            repo_run(spec, ['repair', 'index'], readonly=False)
            repaired = repository_check(spec)
            return {'sourceDiagnosis': diagnosis, 'scratchDiagnosis': repaired, 'destination': str(target), 'ok': repaired['ok']}
        require(diagnosis['ok'], 'Repository check failed; repair an owned scratch copy before restoring.')
        path = Path(args.path or '')
        require(path.is_absolute() and str(path) != '/' and '..' not in path.parts,
                'Restore requires --path for one absolute folder or file.')
        require(not any(path == Path(p) or Path(p) in path.parents or path in Path(p).parents for p in cfg['forbiddenPaths']), 'Choose one permitted project or data folder.')
        repo_run(spec, ['restore', args.snapshot, '--target', str(target), '--include', str(path), '--verify'])
        require((target / str(path).lstrip('/')).exists(), 'The selected path was not restored.')
        return {'ok': True, 'destination': str(target), 'sourceDiagnosis': diagnosis}


def extract_archive(cfg, archive, destination):
    archive = real(archive)
    require(real(cfg['scratchRoot']) in archive.parents, 'Materialize the archive in scratch first.')
    to = scratch(cfg['scratchRoot'], destination)
    with tarfile.open(archive, 'r:*') as payload:
        members = payload.getmembers()
        for member in members:
            path = Path(member.name)
            require(not path.is_absolute() and '..' not in path.parts and (member.isfile() or member.isdir()),
                    'Archive has traversal, links, devices or unsupported entries.')
            require(not any(str(path).lstrip('./') == p.lstrip('/') or str(path).lstrip('./').startswith(p.lstrip('/') + '/') for p in cfg['forbiddenPaths']), 'Archive includes an excluded project.')
        to.mkdir(mode=0o700)
        payload.extractall(to, members=members, filter='data')
    return {'ok': True, 'destination': str(to), 'items': len(members)}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default=str(Path(__file__).resolve().parent.parent / 'data/recovery.json'))
    commands = parser.add_subparsers(dest='command', required=True)
    recover = commands.add_parser('recover', help='Read-only diagnosis, scratch repair/restore, or machine bootstrap')
    recover.add_argument('mode', choices=['check', 'snapshots', 'restore', 'repair', 'bootstrap', 'extract'])
    recover.add_argument('--machine', default='workstation')
    recover.add_argument('--to')
    recover.add_argument('--plan', action='store_true')
    recover.add_argument('--repository')
    recover.add_argument('--password-file')
    recover.add_argument('--rclone-config')
    recover.add_argument('--snapshot')
    recover.add_argument('--source')
    recover.add_argument('--path')
    recover.add_argument('--archive')
    dr = commands.add_parser('drill', help='Restore and serve both machines in disposable scratch targets')
    dr.add_argument('--scheduled', action='store_true', help='Run at most once per calendar month')
    dr.add_argument('--code', default=str(Path(__file__).resolve().parents[3]))
    dr.add_argument('--plan', action='store_true')
    args = parser.parse_args()
    try:
        cfg = config(args.config)
        if args.command == 'drill':
            if args.plan:
                print(json.dumps({'scratchOnly': True, 'machines': list(cfg['machines']), 'runtime': 'Aico web + Tether; no network or live sockets', 'activatesUnits': False}))
                return 0
            result = drill(cfg, args.code, scheduled=args.scheduled)
        elif args.mode == 'bootstrap':
            require(args.to, 'Bootstrap requires --to NEW_SCRATCH_FOLDER.')
            result = plan(cfg, args.machine, args.to) if args.plan else restore(cfg, args.machine, args.to)
        elif args.mode == 'extract':
            require(args.archive and args.to, 'Extract requires --archive and --to NEW_SCRATCH_FOLDER.')
            result = extract_archive(cfg, args.archive, args.to)
        else:
            result = repo_command(args, cfg)
        print(json.dumps(result))
        return 0 if result.get('ok', True) else 1
    except (RecoveryError, OSError, ValueError, KeyError, sqlite3.Error, tarfile.TarError):
        print('Recovery could not complete. Check configuration, file permissions, scratch target and backup selection. No child-process output is shown.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
