"""Installed retired-command references; emit metadata only, no environment or secret values."""
import base64, json, os, pathlib, re, subprocess, sys
verbs=set(json.loads(base64.b64decode(sys.argv[1])))
owner_home=pathlib.Path('/home/kasadis')
pattern=re.compile(r'''(?<![\w-])(st|aico)["']?[\s,]+["']?([a-z][a-z0-9-]*)\b''')
roots=[pathlib.Path(s) for s in ['/usr/local/lib/host-steward/host_steward','/usr/local/lib/aico-pve-sender','/etc/systemd/system','/usr/lib/systemd/system','/run/systemd/system','/etc/systemd/user','/usr/lib/systemd/user','/run/user/1000/systemd/user','/etc/cron.d','/etc/cron.hourly','/etc/cron.daily','/etc/cron.weekly','/etc/cron.monthly']]
roots += [owner_home/'.config/systemd/user',owner_home/'.local/lib/aico/ops/packages/jobs/data']
user_prefix=[] if os.geteuid()==1000 else ['/usr/sbin/runuser','-u','kasadis','--']
user_env=['env','XDG_RUNTIME_DIR=/run/user/1000','DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus']
errors=[]; matches=[]; counts={}
def unit_meta(name,user):
 scope=([*user_prefix,*user_env,'systemctl','--user'] if user else ['systemctl'])
 r=subprocess.run([*scope,'show',name,'-p','ActiveState','-p','UnitFileState','-p','TriggeredBy','-p','Triggers'],capture_output=True,text=True)
 return {'exit':r.returncode,**dict(s.split('=',1) for s in r.stdout.splitlines() if '=' in s)}
def scan(label,text):
 for n,line in enumerate(text.splitlines(),1):
  for m in pattern.finditer(line):
   if m[2] not in verbs:continue
   row={'file':label,'line':n,'command':m[1]+' '+m[2],'comment':line.lstrip().startswith('#')}
   p=pathlib.Path(label)
   if p.suffix in ['.service','.timer']:
    row['unit_metadata']=unit_meta(p.name,'/systemd/user/' in label)
   matches.append(row)
for root in roots:
 counts[str(root)]={'exists':root.exists(),'files':0}
 if not root.exists():continue
 for p in root.rglob('*'):
  if not p.is_file() or (p.suffix not in ['.py','.toml','.json','.service','.timer','.sh','.conf'] and not root.name.startswith('cron.')):continue
  try:content=p.read_text(errors='replace')
  except OSError as e:errors.append({'file':str(p),'error':type(e).__name__});continue
  counts[str(root)]['files']+=1;scan(str(p),content)
for path in ['/etc/crontab','/var/spool/cron/crontabs/root','/var/spool/cron/crontabs/kasadis']:
 p=pathlib.Path(path)
 if p.exists():
  try:scan(str(p),p.read_text())
  except OSError as e:errors.append({'file':str(p),'error':type(e).__name__})
host_units=subprocess.run(['systemctl','list-unit-files','host-steward*','--no-pager','--no-legend'],capture_output=True,text=True)
print(json.dumps({'host_steward_units':host_units.stdout.splitlines(),'host_steward_units_exit':host_units.returncode,'host':os.uname().nodename,'installed_roots':counts,'retired_verbs':sorted(verbs),'matches':matches,'errors':errors,'btrfs_timer':unit_meta('btrfs-autosnapshot.timer',True)},indent=2))
