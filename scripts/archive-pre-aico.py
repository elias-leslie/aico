#!/usr/bin/env python3
"""One-time M12 archive. Only metadata/counts are printed; payloads stay sealed.

Run capture once, then verify, then seal. Existing captures are never overwritten.
The live database transaction is repeatable-read and read-only. The exported
snapshot binds counts, JSON exports and pg_dump to exactly the same source state.
"""
import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import time
from pathlib import Path
from typing import Any


def run(argv, **kwargs):
    result = subprocess.run(argv, capture_output=True, check=False, **kwargs)
    if result.returncode:
        # Tool diagnostics can quote payloads: retain no SQL/COPY error content.
        raise RuntimeError(f"{Path(argv[0]).name} failed ({result.returncode}); payload diagnostics withheld")
    return result.stdout


def sql_name(name):
    return '"' + name.replace('"', '""') + '"'


class Snapshot:
    def __init__(self, container, db):
        self.proc = subprocess.Popen(
            ['sudo', '-n', 'docker', 'exec', '-i', container, 'psql', '-XAtq',
             '-v', 'ON_ERROR_STOP=1', '-U', 'admin', '-d', db],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1)
        self.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        self.id = self.query('SELECT pg_export_snapshot()')[0]

    def query(self, sql):
        assert self.proc.stdin is not None and self.proc.stdout is not None
        self.proc.stdin.write(sql + ";\nSELECT 'M12_QUERY_DONE';\n")
        self.proc.stdin.flush()
        result = []
        for line in self.proc.stdout:
            line = line.rstrip('\n')
            if line == 'M12_QUERY_DONE':
                return result
            result.append(line)
        raise RuntimeError('Read-only source transaction ended unexpectedly')

    def close(self):
        if self.proc.poll() is None:
            assert self.proc.stdin is not None
            self.proc.stdin.write('ROLLBACK;\n\\q\n')
            self.proc.stdin.flush()
        self.proc.communicate()
        if self.proc.returncode:
            raise RuntimeError('Source transaction failed')


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def copy_tree_once(source, destination):
    """Resume missing copies; retain and validate every existing archive file."""
    source, destination = Path(source), Path(destination)
    if source.is_symlink() or destination.is_symlink():
        raise RuntimeError('Archive tree links require review')
    destination.mkdir(parents=True, exist_ok=True)
    for path in sorted(source.rglob('*')):
        target = destination / path.relative_to(source)
        if path.is_symlink() or target.is_symlink():
            raise RuntimeError('Archive tree links require review')
        if path.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        elif path.is_file():
            if target.exists():
                with path.open('rb') as original, target.open('rb') as existing:
                    if hashlib.file_digest(original, 'sha256').digest() != hashlib.file_digest(existing, 'sha256').digest():
                        raise RuntimeError('Existing archive file differs from source; preserved for review')
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)
        else:
            raise RuntimeError('Unsupported archive source file type')


def disk_guard(cfg, extra):
    usage = shutil.disk_usage(Path(cfg['destination']).parent)
    projected = (usage.used + extra) / usage.total
    if projected > cfg['maximumDiskFraction']:
        raise RuntimeError(f'Projected disk use {projected:.1%} exceeds configured limit; ask coordinator')
    return {'total': usage.total, 'used': usage.used, 'extraEstimate': extra, 'projectedFraction': projected}


def capture(cfg):
    root = Path(cfg['destination'])
    root.parent.mkdir(parents=True, exist_ok=True)
    # Reserve generously for dumps and a complete restore, not compressed size alone.
    sizes = run(['sudo', '-n', 'docker', 'exec', cfg['sourceContainer'], 'psql', '-XAt',
                 '-U', 'admin', '-d', 'postgres', '-c',
                 "SELECT pg_database_size(datname) FROM pg_database WHERE datname IN ('agent_hub','summitflow')"])
    space = disk_guard(cfg, sum(int(x) for x in sizes.splitlines()) * 3)
    root.mkdir(mode=0o700)  # Refuse to overwrite any previous archive.
    receipt = {'startedAt': time.time(), 'space': space, 'databases': {}, 'sqlite': {}, 'notes': cfg['notes']}
    write_json(root / 'capture.json', receipt)
    for db, spec in cfg['databases'].items():
        snap = Snapshot(cfg['sourceContainer'], db)
        try:
            tables = snap.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")
            counts = {table: int(snap.query('SELECT count(*) FROM public.' + sql_name(table))[0]) for table in tables}
            receipt['databases'][db] = {'counts': counts, 'omittedData': spec['omitData'], 'snapshot': snap.id}
            base = ['sudo', '-n', 'docker', 'exec', cfg['sourceContainer'], 'pg_dump', '-U', 'admin',
                    '-d', db, '--format=custom', '--compress=6', '--no-owner', '--no-acl', '--snapshot=' + snap.id]
            with (root / (db + '.dump')).open('xb') as dest:
                argv = base + ['--exclude-table-data=public.' + table for table in spec['omitData'] + spec['separateData']]
                result = subprocess.run(argv, check=False, stdout=dest, stderr=subprocess.DEVNULL)
                if result.returncode:
                    raise RuntimeError('pg_dump failed')
            for table in spec['separateData']:
                with (root / (db + '-' + table + '.dump')).open('xb') as dest:
                    result = subprocess.run(base + ['--data-only', '--table=public.' + table], check=False, stdout=dest, stderr=subprocess.DEVNULL)
                    if result.returncode:
                        raise RuntimeError('Separate pg_dump failed')
            if db == 'agent_hub':
                for table in ['agents', 'agent_versions']:
                    rows = snap.query('SELECT row_to_json(t) FROM public.' + sql_name(table) + ' t')
                    (root / (table + '.jsonl')).write_text('\n'.join(rows) + '\n')
                rows = snap.query('SELECT row_to_json(t) FROM (SELECT id,name,granted_tools,created_at,revoked_at,last_seen_at FROM remote_hosts) t')
                (root / 'remote-hosts-metadata.jsonl').write_text('\n'.join(rows) + '\n')
        finally:
            snap.close()
        write_json(root / 'capture.json', receipt)
    finish_capture(cfg)


def finish_capture(cfg):
    """Complete file copying after a failed external hop without re-dumping data.

    Captured files are never replaced. This also lets the coordinator add an
    opaque file source before sealing, while preserving the database snapshot.
    """
    root = Path(cfg['destination'])
    receipt = json.loads((root / 'capture.json').read_text())
    assert set(receipt['databases']) == set(cfg['databases']), 'Database capture incomplete'
    for rel, source in cfg['sqlite'].items():
        dest = root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists():
            # SQLite backup API incorporates committed WAL rows.
            src = sqlite3.connect(Path(source).as_uri() + '?mode=ro', uri=True)
            out = sqlite3.connect(dest)
            try:
                src.backup(out)
            finally:
                out.close()
                src.close()
        receipt['sqlite'][rel] = {'source': source}
    for rel, source in cfg['trees'].items():
        copy_tree_once(source, root / rel)
    for rel, source in cfg['files'].items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        if not (root / rel).exists():
            shutil.copy2(source, root / rel)
    anchor = root / 'nightshift/pve-anchor-heads'
    if not anchor.exists():
        anchor.write_bytes(run(cfg['anchorCommandPrefix'] + ['ssh', '-o', 'BatchMode=yes', cfg['anchorHost'], 'cat', cfg['anchorPath']]))
    hub = Path(cfg['agentHubRoot'])
    for source in sorted((hub / 'docs/evaluations').glob('*202610[22][27]/README.md')):
        dest = root / 'agent-hub-files' / source.relative_to(hub)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists():
            shutil.copy2(source, dest)
    for source in sorted((hub / 'docs/examples/workflows').glob('*.json')):
        dest = root / 'agent-hub-files' / source.relative_to(hub)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists():
            shutil.copy2(source, dest)
    receipt['finishedAt'] = time.time()
    write_json(root / 'capture.json', receipt)
    print('Capture completed; contents remain private.')


def verify(cfg):
    root = Path(cfg['destination'])
    receipt = json.loads((root / 'capture.json').read_text())
    assert receipt.get('finishedAt'), 'Capture incomplete'
    name = cfg['restoreContainer']
    docker = ['sudo', '-n', 'docker']
    run(docker + ['run', '-d', '--name', name, '--network=none', '--memory=3g', '--cpus=2',
                  '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-v', str(root) + ':/archive:ro', cfg['image']])
    try:
        # Readiness is bounded startup probing, not a model-work timeout.
        for _ in range(60):
            if subprocess.run(docker + ['exec', name, 'pg_isready', '-U', 'postgres'], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('Throwaway Postgres failed to start')
        proof = {'databases': {}, 'sqlite': {}, 'ledger': {}, 'verifiedAt': time.time()}
        for db, spec in cfg['databases'].items():
            run(docker + ['exec', name, 'createdb', '-U', 'postgres', db])
            dumps = [db + '.dump'] + [db + '-' + t + '.dump' for t in spec['separateData']]
            for dump in dumps:
                listing = run(docker + ['exec', name, 'pg_restore', '--list', '/archive/' + dump])
                (root / (dump + '.list')).write_bytes(listing)
            restore = docker + ['exec', name, 'pg_restore', '-U', 'postgres', '-d', db, '--no-owner', '--no-acl', '--exit-on-error']
            for section in ['pre-data', 'data']:
                run(restore + ['--section=' + section, '/archive/' + db + '.dump'])
            for table in spec['separateData']:
                run(restore + ['/archive/' + db + '-' + table + '.dump'])
            run(restore + ['--section=post-data', '/archive/' + db + '.dump'])
            counts = {}
            for table, expected in receipt['databases'][db]['counts'].items():
                count = int(run(docker + ['exec', name, 'psql', '-XAt', '-U', 'postgres', '-d', db, '-c', 'SELECT count(*) FROM public.' + sql_name(table)]))
                assert count == (0 if table in spec['omitData'] else expected), f'Count mismatch: {db}.{table}'
                counts[table] = count
            proof['databases'][db] = {'restore': 'passed', 'counts': counts}
        for rel in cfg['sqlite']:
            with sqlite3.connect((root / rel).as_uri() + '?mode=ro', uri=True) as db:
                result = db.execute('PRAGMA integrity_check').fetchall()
                assert result == [('ok',)], f'SQLite integrity failed: {rel}'
                tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
                counts = {table: db.execute('SELECT count(*) FROM ' + sql_name(table)).fetchone()[0] for table in tables}
            proof['sqlite'][rel] = {'integrity': 'ok', 'counts': counts}
        entries = [json.loads(line) for line in (root / 'nightshift/chain.jsonl').read_text().splitlines()]
        previous = '0' * 64
        for seq, entry in enumerate(entries, 1):
            digest = hashlib.sha256(json.dumps({k: v for k, v in entry.items() if k != 'hash'}, sort_keys=True, separators=(',', ':'), default=str).encode()).hexdigest()
            assert entry['seq'] == seq and entry['prev'] == previous and entry['hash'] == digest, 'Ledger link failed'
            previous = digest
        anchor = json.loads((root / 'nightshift/pve-anchor.json').read_text())
        heads = (root / 'nightshift/pve-anchor-heads').read_text().splitlines()
        checked = []
        for key in ['last_good', 'prev']:
            point = anchor.get(key)
            if point:
                assert entries[point['seq'] - 1]['hash'] == point['hash'], 'Anchor does not match ledger'
                assert any(str(point['seq']) in line.split() and point['hash'] in line.split() for line in heads), 'Anchor absent from PVE'
                checked.append(point['seq'])
        assert checked, 'No PVE-confirmed anchor'
        assert not anchor.get('conflicts') and not anchor.get('regressions'), 'Recorded anchor conflict'
        proof['ledger'] = {'links': len(entries), 'anchorSequences': checked, 'verified': True}
        write_json(root / 'verification.json', proof)
    finally:
        # Only this throwaway runtime is removed. Its anonymous PG volume is scratch.
        run(docker + ['rm', '-f', '-v', name])
    print('Full restores, source snapshot counts, SQLite integrity and PVE ledger anchors passed.')


def seal(cfg):
    root = Path(cfg['destination'])
    assert (root / 'verification.json').exists(), 'Verify before sealing'
    manifest: list[dict[str, Any]] = []
    for path in sorted(root.rglob('*')):
        assert not path.is_symlink(), 'Archive links require review'
        if path.is_file():
            with path.open('rb') as source:
                digest = hashlib.file_digest(source, 'sha256').hexdigest()
            manifest.append({'path': str(path.relative_to(root)), 'bytes': path.stat().st_size, 'sha256': digest})
    write_json(root / 'manifest.json', {'files': manifest, 'notes': cfg['notes']})
    for path in root.rglob('*'):
        path.chmod(0o500 if path.is_dir() else 0o400)
    root.chmod(0o500)
    print(json.dumps({'files': len(manifest), 'bytes': sum(x['bytes'] for x in manifest)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config', type=Path)
    parser.add_argument('action', choices=['capture', 'finish_capture', 'verify', 'seal'])
    args = parser.parse_args()
    os.umask(0o077)
    config = json.loads(args.config.read_text())
    globals()[args.action](config)
