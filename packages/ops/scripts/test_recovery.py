"""No live backups or credentials: tests exercise the standalone plans and boundaries."""
import importlib.util
import io
import json
import os
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).with_name('recovery.py'))
assert spec is not None and spec.loader is not None
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cfg = r.config(Path(__file__).parent.parent / 'data/recovery.json')
        self.cfg['scratchRoot'] = str(self.root)
        self.cfg['receipt'] = str(self.root / 'receipts/drill.json')
        self.state = {'points': [{'source': m, 'target': '/backup/' + m.replace('/', '-'), 'dataAt': '2026-11-05T00:00:00Z'}
                                 for m in ['/', '/home', '/srv/workspaces']]}
        state_file = self.root / 'state.json'
        state_file.write_text(json.dumps(self.state))
        self.cfg['backupState'] = str(state_file)

    def test_bootstrap_plan_covers_data_repo_secrets_units_without_activation(self):
        plan = r.plan(self.cfg, 'workstation', self.root / 'new')
        self.assertFalse(plan['activatesUnits'])
        self.assertTrue(plan['scratchOnly'])
        self.assertFalse((self.root / 'new').exists())
        self.assertEqual({x['into'] for x in plan['items']}, {'data', 'tether/tether.db', 'tether/tether.db-wal', 'units/user', 'units/system', 'config/aico', 'repo'})
        self.assertTrue(next(x for x in plan['items'] if x['into'] == 'repo')['from'].startswith('/backup/-srv-workspaces/'))

    def test_native_plan_uses_longest_mount_and_rejects_forbidden_paths(self):
        item = r.plan(self.cfg, 'workstation', self.root / 'new')['items'][0]
        self.assertTrue(item['from'].startswith('/backup/-home/'))
        self.cfg['machines']['workstation']['items'][0]['path'] = '/srv/workspaces/projects/neri'
        with self.assertRaises(r.RecoveryError):
            r.plan(self.cfg, 'workstation', self.root / 'new')

    def test_gem_bootstrap_combines_own_data_units_and_config_with_backed_up_repo(self):
        planned = r.plan(self.cfg, 'gem', self.root / 'gem')
        paths = {item['into'] for item in planned['items']}
        self.assertTrue({'data', 'data/secrets', 'units/user', 'config/aico', 'repo'} <= paths)
        self.assertIn('snapshotRoot', next(item for item in planned['items'] if item['into'] == 'repo'))

    def test_extract_rejects_traversal_and_links_before_creating_target(self):
        for name, link in [('../escape', False), ('secret-link', True)]:
            archive = self.root / 'unsafe.tar'
            with tarfile.open(archive, 'w') as tar:
                item = tarfile.TarInfo(name)
                if link:
                    item.type = tarfile.SYMTYPE
                    item.linkname = '/etc/passwd'
                tar.addfile(item)
            with self.assertRaises(r.RecoveryError):
                r.extract_archive(self.cfg, archive, self.root / 'extracted')
            self.assertFalse((self.root / 'extracted').exists())
        archive = self.root / 'safe.tar'
        with tarfile.open(archive, 'w') as tar:
            item = tarfile.TarInfo('data/file')
            item.size = 4
            item.mode = 0o600
            tar.addfile(item, io.BytesIO(b'test'))
        self.assertTrue(r.extract_archive(self.cfg, archive, self.root / 'extracted')['ok'])
        self.assertEqual((self.root / 'extracted/data/file').read_bytes(), b'test')

    def test_scratch_rejects_root_existing_folder_traversal_and_symlinks(self):
        linked = self.root / 'link'
        linked.symlink_to('/tmp', target_is_directory=True)
        for path in [self.root, self.root / 'state.json', self.root / '../escape', linked / 'new', '/home/restore']:
            with self.subTest(path=path), self.assertRaises(r.RecoveryError):
                r.scratch(self.root, path)

    def test_repository_source_has_no_lock_no_cache_and_no_inherited_auth(self):
        repo = self.root / 'repo'
        repo.mkdir()
        password = self.root / 'password'
        password.write_text('fixture-only')
        password.chmod(0o600)
        with patch.dict(os.environ, {'RESTIC_PASSWORD': 'must-not-pass', 'RCLONE_CONFIG': 'must-not-pass'}):
            argv, env = r.restic_base({'repository': str(repo), 'passwordFile': str(password)})
        self.assertIn('--no-lock', argv)
        self.assertIn('--no-cache', argv)
        self.assertNotIn('RESTIC_PASSWORD', env)
        self.assertNotIn('RCLONE_CONFIG', env)
        password.chmod(0o644)
        with self.assertRaises(r.RecoveryError):
            r.restic_base({'repository': str(repo), 'passwordFile': str(password)})

    def test_runtime_hides_live_state_and_sockets_and_unshares_network(self):
        argv = r.runtime_command(self.cfg, self.root, Path('/code'))
        self.assertIn('--unshare-all', argv)
        self.assertIn('--clearenv', argv)
        for path in ['/run', '/home', '/srv']:
            self.assertIn(['--tmpfs', path], [argv[i:i+2] for i in range(len(argv)-1)])
        self.assertNotIn('systemctl', argv)

    def test_partial_ops_release_uses_the_installed_tether_bundle(self):
        code = self.root / 'release'
        code.mkdir()
        bundle = self.root / 'tether.mjs'
        bundle.write_text('// fixture')
        self.cfg['runtime']['tetherBundle'] = str(bundle)
        argv = r.runtime_command(self.cfg, self.root, code)
        self.assertIn(['--ro-bind', str(bundle), '/tether.mjs'], [argv[i:i+3] for i in range(len(argv)-2)])

    def test_counts_include_nonended_aico_chats_served_by_sessions_endpoint(self):
        for folder in ['data/secrets', 'tether']:
            (self.root / folder).mkdir(parents=True)
        (self.root / 'data/secrets/index.json').write_text('{"entries": []}')
        for path, sql in [
            ('tether/tether.db', 'CREATE TABLE sessions (id); INSERT INTO sessions VALUES (1), (2)'),
            ('data/notes.db', 'CREATE TABLE notes (deleted); INSERT INTO notes VALUES (0), (1)'),
            ('data/agent.db', "CREATE TABLE chats (state); INSERT INTO chats VALUES ('idle'), ('working'), ('ended')"),
        ]:
            with sqlite3.connect(self.root / path) as conn:
                conn.executescript(sql)
        self.assertEqual(r.counts(self.root, self.cfg), {'sessions': 4, 'notes': 1, 'logins': 0})

    def test_failed_drill_cleans_only_its_own_target_and_saves_failure(self):
        sentinel = self.root / 'keep'
        sentinel.mkdir()
        (sentinel / 'durable').write_text('keep')
        with patch.object(r, 'restore', side_effect=r.RecoveryError('failed')):
            receipt = r.drill(self.cfg, Path('/code'))
        self.assertFalse(receipt['ok'])
        self.assertTrue(receipt['scratchDestroyed'])
        self.assertTrue((sentinel / 'durable').exists())
        self.assertFalse(list(self.root.glob('aico-drill-*')))
        self.assertEqual(r.load(self.cfg['receipt']), receipt)
        with patch.object(r, 'restore', side_effect=AssertionError('monthly schedule ran twice')):
            skipped = r.drill(self.cfg, Path('/code'), scheduled=True)
        self.assertTrue(skipped['skipped'])
        # A manual request can always run again, even after a failure this month.
        with patch.object(r, 'restore', side_effect=r.RecoveryError('failed again')) as restore:
            r.drill(self.cfg, Path('/code'))
            self.assertTrue(restore.called)

    def test_drill_requires_the_promised_project_repository(self):
        result = {'snapshot': None, 'items': self.cfg['machines']['workstation']['items']}
        with patch.object(r, 'restore', return_value=result), patch.object(r, 'counts', return_value={}), patch.object(r, 'run', return_value=subprocess.CompletedProcess([], 0, b'{}', b'')):
            receipt = r.drill(self.cfg, Path('/code'))
        self.assertFalse(receipt['ok'], 'A missing .git must never pass the restore drill')

    def test_partial_privileged_copy_is_removed_and_receipted(self):
        original = r.shutil.rmtree
        calls = []
        def cleanup(argv, **_):
            calls.append(argv)
            original(Path(argv[-1]))
        with (patch.object(r, 'restore', side_effect=r.RecoveryError('partial privileged copy')),
              patch.object(r.shutil, 'rmtree', side_effect=PermissionError('root-owned partial data')),
              patch.object(r, 'run', side_effect=cleanup)):
            receipt = r.drill(self.cfg, Path('/code'))
        self.assertFalse(receipt['ok'])
        self.assertTrue(receipt['scratchDestroyed'])
        self.assertEqual(calls[0][:5], ['sudo', '-n', 'rm', '-rf', '--'])
        self.assertEqual(Path(calls[0][-1]).parent, self.root)

    def test_sigterm_cleans_the_target_and_records_failure(self):
        cfg_file = self.root / 'fixture-config.json'
        cfg_file.write_text(json.dumps(self.cfg))
        code = '''import json,os,signal,sys
from pathlib import Path
import recovery as r
def interrupted(*args):
    os.kill(os.getpid(), signal.SIGTERM)
r.restore = interrupted
print(json.dumps(r.drill(r.load(sys.argv[1]), Path('/code'))))
'''
        result = subprocess.run([sys.executable, '-c', code, str(cfg_file)], cwd=Path(__file__).parent,
                                capture_output=True, check=False)
        self.assertEqual(result.returncode, 0)
        receipt = json.loads(result.stdout)
        self.assertFalse(receipt['ok'])
        self.assertTrue(receipt['scratchDestroyed'])

    def test_repair_diagnoses_original_before_copy_and_changes_only_copy(self):
        args = type('Args', (), {'repository': str(self.root / 'repo'), 'password_file': '/password',
                                   'rclone_config': None, 'mode': 'repair', 'to': str(self.root / 'copy'), 'snapshot': None})()
        Path(args.repository).mkdir()
        calls = []
        def check(spec):
            calls.append(('check', spec['repository']))
            return {'ok': True}
        with patch.object(r, 'repository_check', side_effect=check), patch.object(r, 'run', side_effect=lambda argv: calls.append(('copy', argv[-1]))), patch.object(r, 'repo_run', side_effect=lambda spec, argv, **kw: calls.append(('repair', spec['repository'], argv))):
            result = r.repo_command(args, self.cfg)
        self.assertTrue(result['ok'])
        self.assertEqual(calls[0], ('check', args.repository))
        self.assertEqual(calls[2], ('repair', args.to, ['repair', 'index']))
        self.assertEqual(calls[3], ('check', args.to))


if __name__ == '__main__':
    unittest.main()
