"""CT190 journal metadata only; no log bodies retained."""
import argparse,collections,datetime,hashlib,json,re,subprocess
p=argparse.ArgumentParser();p.add_argument('--since',required=True);p.add_argument('--until',required=True);p.add_argument('--gem',action='store_true');a=p.parse_args()
user=['aico-web.service','aico-jobs.service','tether@default.service','aico-state-snapshot.service']
system=['host-steward-heartbeat.service']
if a.gem:system=['aico-pve-sender.service','aico-pve-trim.service','nightshift-boot-mark.service','summitflow-cpu-epp.service','nightshift-nightwatch.service','nightshift-nightwatch-web.service']
out={'since':a.since,'until':a.until,'scopes':[]}
groups=[('user',['runuser','-u','kasadis','--','env','XDG_RUNTIME_DIR=/run/user/1000','DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus','journalctl','--user'],user),('system',['journalctl'],system)]
if a.gem:groups=groups[1:]
for name,base,units in groups:
 cmd=base+['--since',a.since,'--until',a.until,'--no-pager','-o','json']+[v for u in units for v in ('-u',u)]
 rows=collections.Counter();alerts=[]
 for line in subprocess.check_output(cmd,text=True).splitlines():
  x=json.loads(line);m=x.get('MESSAGE','');u=x.get('USER_UNIT') or x.get('_SYSTEMD_USER_UNIT') or x.get('UNIT') or x.get('_SYSTEMD_UNIT') or 'unknown';rows[u]+=1
  if not isinstance(m,str):continue
  cats=[c for c,pat in [('connection_refused',r'connection refused'),('traceback',r'Traceback \(most recent call last\)'),('exception',r'\b\w*(?:Error|Exception):'),('error_word',r'\b(?:error|failed)\b')] if re.search(pat,m,re.I)]
  if int(x.get('PRIORITY',6))<=3 or cats:alerts.append({'unit':u,'priority':x.get('PRIORITY'),'categories':cats,'digest':hashlib.sha256(m.encode()).hexdigest()[:12]})
 out['scopes'].append({'scope':name,'units':units,'events':dict(rows),'alerts':alerts})
print(json.dumps(out,indent=2))
