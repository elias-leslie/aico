"""Runtime metadata only. No environment, credentials, Neri files or log bodies."""
import json
import os
import re
import subprocess
from pathlib import Path


def run(argv):
    result = subprocess.run(argv, capture_output=True, text=True, check=False)
    return result.stdout if result.returncode == 0 else ''


def main():
    uid = os.getuid()
    os.environ.update(XDG_RUNTIME_DIR=f'/run/user/{uid}', DBUS_SESSION_BUS_ADDRESS=f'unix:path=/run/user/{uid}/bus')
    scopes = [('system', ['systemctl'])]
    if Path(f'/run/user/{uid}/bus').exists():
        scopes.append(('user', ['systemctl', '--user']))
    rows = []
    pattern = r'^(?:summitflow|agent-hub|nightshift|codex-session)'
    for scope, base in scopes:
        for line in run(base + ['list-unit-files', '--no-legend', '--no-pager']).splitlines():
            name = line.split()[0]
            if not re.search(pattern, name):
                continue
            props = run(base + ['show', name, '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'FragmentPath', '-p', 'Triggers', '-p', 'TriggeredBy', '-p', 'Requires', '-p', 'WantedBy'])
            rows.append({'scope': scope, 'unit': name, 'install_state': line.split()[1], **dict(x.split('=', 1) for x in props.splitlines() if '=' in x)})
    crons = []
    for root in ['/etc/cron.d', '/etc/cron.daily', '/etc/cron.hourly', '/etc/cron.weekly', '/etc/cron.monthly']:
        for file in Path(root).glob('*'):
            if file.is_file():
                try:
                    lines = file.read_text().splitlines()
                except (OSError, UnicodeError):
                    continue
                hits = sum(1 for line in lines if not line.lstrip().startswith('#') and re.search(r'summitflow|agent.hub|nightshift', line, re.I))
                if hits:
                    crons.append({'file': str(file), 'legacy_lines': hits})
    for account in ['root', 'kasadis']:
        lines = run(['crontab', '-u', account, '-l']).splitlines()
        crons.append({'account': account, 'active_lines': sum(bool(x.strip()) and not x.lstrip().startswith('#') for x in lines)})
    print(json.dumps({'host': os.uname().nodename, 'units': rows, 'cron': crons}, indent=2))


if __name__ == '__main__':
    main()
