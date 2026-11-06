#!/usr/bin/env python3
"""Only launched inside recovery.py's scratch network/mount namespace.

Start the real deployed web server and Tether against restored state. Fetch real
list endpoints, discard their bodies, emit only counts. No transcript or secret
value endpoint is requested.
"""
import argparse
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--node', required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--ready-seconds', type=int, required=True)
    args = parser.parse_args()
    root = Path(args.root)
    # Refuse a direct host invocation. The outer script supplies these mounts.
    if root != Path('/drill') or not Path('/recovery/recovery.py').is_file():
        raise SystemExit('Run through aico backups drill.')
    home = root / 'runtime-home'
    runtime = root / 'r'
    home.mkdir(mode=0o700)
    runtime.mkdir(mode=0o700)
    env = {
        'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(home),
        'XDG_CONFIG_HOME': str(home / '.config'), 'XDG_STATE_HOME': str(home / '.local/state'),
        'XDG_RUNTIME_DIR': str(runtime), 'AICO_DATA_DIR': str(root / 'data'),
        'AICO_WEB_DB': str(root / 'data/web.db'), 'AICO_WEB_PORT': str(args.port),
        'AICO_WEB_HOST': '127.0.0.1', 'AICO_IDENTITY_FILE': str(root / 'absent-identity'),
        'AICO_SYNC_SOCKET': str(runtime / 'sync.sock'), 'TETHER_INSTANCE': 'recovery',
        'TETHER_SOCKET': str(runtime / 'control.sock'), 'TETHER_RUNTIME_DIR': str(runtime),
        'TETHER_STATE_DIR': str(root / 'tether'), 'TETHER_RECONCILE': 'off',
        'AICO_FLEET_CONFIG': str(root / 'absent-fleet'),
        'AICO_PORTFOLIO_URL': 'off', 'MAINTENANCE_ENABLED': '0',
        'AICO_AGY_PATH': '/bin/false', 'AICO_PHONE_DEVICES_SEED': str(root / 'absent-devices'),
    }
    children = []
    try:
        for bundle, extra in [('/tether.mjs', ['serve']),
                              ('/app/packages/web-server/dist/aico-web.mjs', [])]:
            children.append(subprocess.Popen([args.node, '--disable-warning=ExperimentalWarning', bundle, *extra],
                                             env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        deadline = time.monotonic() + args.ready_seconds
        while True:
            for name, child in zip(['Tether', 'Aico web'], children, strict=True):
                if child.poll() is not None:
                    raise RuntimeError(f'{name} exited during startup (exit {child.returncode}).')
            try:
                def get(path):
                    with urllib.request.urlopen(f'http://127.0.0.1:{args.port}{path}', timeout=3) as response:
                        return json.load(response)
                sessions = get('/api/sessions')
                notes = get('/api/notes?archived=all&limit=1')
                logins = get('/api/logins')
                print(json.dumps({'sessions': len(sessions['items']), 'notes': notes['total'], 'logins': len(logins['entries'])}))
                return
            except (OSError, ValueError, KeyError):
                if time.monotonic() >= deadline:
                    raise RuntimeError('Restored Aico did not serve its lists.') from None
                time.sleep(0.1)
    finally:
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
        for child in reversed(children):
            child.wait()


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as exc:
        print(json.dumps({'error': str(exc)}))
        sys.exit(1)
