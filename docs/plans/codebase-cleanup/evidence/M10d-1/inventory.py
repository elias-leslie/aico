"""Read only service configuration/environment and connection lists; never emit credential values."""
import json
import os
import re
import subprocess
from pathlib import Path
from urllib.parse import urlsplit


def dependencies(text):
    result = set()
    for line in text.splitlines():
        if not re.search(r'(?:DATABASE|DB_URL|DSN|POSTGRES|REDIS|HATCHET)', line, re.IGNORECASE):
            continue
        # Only report product and a URL's hostname/port/database; no userinfo or query parameters.
        for raw in re.findall(r'(?:postgres(?:ql)?(?:\+[a-z0-9]+)?|redis|rediss)://[^\s\"\x27]+', line, re.IGNORECASE):
            try:
                url = urlsplit(raw)
                product = 'Postgres' if url.scheme.startswith('postgres') else 'Redis'
                result.add(f'{product}: {url.hostname}:{url.port or (5432 if product == "Postgres" else 6379)}{url.path}')
            except ValueError:
                result.add('Database endpoint configured (unparsed)')
        if re.search(r'HATCHET_(?:CLIENT_(?:HOST|SERVER|TOKEN)|SERVER|GRPC|HOST)', line):
            result.add('Hatchet client configured (value suppressed)')
        if re.search(r'(?:POSTGRES|PGHOST)',line) and not any(x.startswith('Postgres:') for x in result):
            result.add('Postgres configured (values suppressed)')
        if 'REDIS' in line.upper() and not any(x.startswith('Redis:') for x in result):
            result.add('Redis configured (values suppressed)')
    return sorted(result)


def run(argv):
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, check=False)
    except FileNotFoundError:
        return ''
    return proc.stdout if proc.returncode == 0 else ''


def main():
    rows = []
    scopes = [(['systemctl'], 'system')]
    if Path(f'/run/user/{os.getuid()}/bus').exists():
        os.environ['XDG_RUNTIME_DIR'] = f'/run/user/{os.getuid()}'
        os.environ['DBUS_SESSION_BUS_ADDRESS'] = f'unix:path=/run/user/{os.getuid()}/bus'
        scopes.append((['systemctl', '--user'], 'user'))
    for base,scope in scopes:
        listing=run([*base,'list-unit-files','--type=service','--no-legend','--no-pager'])
        for line in listing.splitlines():
            unit=line.split()[0]
            config=run([*base,'show',unit,'-p','Environment','-p','EnvironmentFiles','-p','MainPID','-p','ActiveState','-p','FragmentPath'])
            values=dict(x.split('=',1) for x in config.splitlines() if '=' in x)
            texts=[values.get('Environment','')]
            for file in re.findall(r'(/[^ ;]+)\s+\(ignore_errors=', values.get('EnvironmentFiles','')):
                try: texts.append(Path(file).read_text())
                except OSError: pass
            # A unit's effective process environment includes its referenced environment and default config.
            # For Neri this is the only process material touched; never its code or data.
            pid=values.get('MainPID','0')
            if pid.isdecimal() and int(pid)>0:
                try: texts.append(Path(f'/proc/{pid}/environ').read_bytes().replace(b'\0',b'\n').decode(errors='replace'))
                except OSError: pass
            deps=dependencies('\n'.join(texts))
            if deps: rows.append({'scope':scope,'unit':unit,'active':values.get('ActiveState'),'uses':deps})
    # Inspect only compose config under registered project roots, at bounded depth; never Neri.
    projects=run(['aico','projects','list'])
    try: projects=json.loads(projects)
    except ValueError: projects=[]
    for project in projects:
        if project.get('id')=='neri':continue
        root=project.get('root_path')
        if not root or not Path(root).is_dir():continue
        for directory,dirs,files in os.walk(root):
            depth=len(Path(directory).relative_to(root).parts)
            dirs[:]=[] if depth>=4 else [x for x in dirs if x not in {'.git','.snapshots','node_modules','.venv','vendor','.next','dist','out','.st','.dev-tools'}]
            for file in files:
                if not re.fullmatch(r'(?:docker-)?compose(?:\.[^.]+)?\.ya?ml',file):continue
                path=Path(directory)/file
                try: deps=dependencies(path.read_text())
                except OSError:continue
                if deps:rows.append({'compose':str(path),'uses':deps})
    connections=run(['ss','-Hntp'])
    relevant=[line for line in connections.splitlines() if re.search(r':(?:5432|6379|7077|8888)\b',line)]
    print(json.dumps({'host':os.uname().nodename,'service_config':rows,'connections':relevant},indent=2))

if __name__=='__main__':main()
