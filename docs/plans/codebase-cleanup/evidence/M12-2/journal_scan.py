"""Scan cutover dependants without emitting journal bodies or application data."""
import argparse, collections, hashlib, json, re, subprocess
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--since',required=True);parser.add_argument('--until');parser.add_argument('--out',required=True);args=parser.parse_args()
user_units=['nightshift-display-guard.service','nightshift-postboot.service','aico-web.service','aico-jobs.service','aico-tray.service','tether@default.service','tether-link@agent-work.service','agent-hub-backend.service','agent-hub-frontend.service','agent-hub-hatchet-agent-worker.service','agent-hub-hatchet-ops-worker.service','agent-hub-usage-collect.service','summitflow-backend.service','summitflow-frontend.service','summitflow-hatchet-worker.service']
scopes=[('user',['journalctl','--user'],user_units),('system',['sudo','journalctl'],['nightshift-input-watch.service','nightshift-boot-mark.service','nightshift-zswap.service','summitflow-dnsmasq.service','summitflow-stack.service','summitflow-host-monitor.service','host-steward-check.service','host-steward-rules.service'])]
result={'since':args.since,'until':args.until,'journals':[],'containers':[]}
def categories(message):
    names=[]
    for name,pattern in [('registry_refresh',r'project registry; refresh failed'),('context_import',r'context-import: failed'),('connection_refused',r'connection refused'),('traceback',r'Traceback \(most recent call last\)'),('exception',r'\b\w*(?:Error|Exception):'),('error_word',r'\b(?:error|failed)\b')]:
        if re.search(pattern,message,re.I):names.append(name)
    return names
for name,base,units in scopes:
    command=[*base,'--since',args.since,'--no-pager','-o','json']
    if args.until:command+=['--until',args.until]
    command += [item for unit in units for item in ('-u',unit)]
    proc=subprocess.run(command,text=True,capture_output=True,check=True)
    counts=collections.Counter();alerts=[]
    for line in proc.stdout.splitlines():
        event=json.loads(line);message=event.get('MESSAGE','');unit=event.get('USER_UNIT') or event.get('_SYSTEMD_USER_UNIT') or event.get('UNIT') or event.get('_SYSTEMD_UNIT') or 'unknown';counts[unit]+=1
        if not isinstance(message,str):continue
        cats=categories(message)
        # Standard unit descriptions can contain the words 'failed units'.
        benign_description=event.get('JOB_RESULT')=='done' or (message.startswith(('Starting ','Finished ')) and 'Nightshift post-boot check' in message)
        if int(event.get('PRIORITY',6))<=3 or (cats and not benign_description):
            alerts.append({'unit':unit,'priority':event.get('PRIORITY'),'categories':cats,'digest':hashlib.sha256(message.encode()).hexdigest()[:12]})
    result['journals'].append({'scope':name,'units':units,'events':dict(counts),'alerts':alerts})
for container in ['summitflow-stack-postgres-1','summitflow-stack-redis-1','summitflow-stack-hatchet-1']:
    command=['sudo','docker','logs','--since',args.since]
    if args.until:command+=['--until',args.until]
    command.append(container)
    proc=subprocess.run(command,text=True,capture_output=True,check=True)
    counts=collections.Counter();digest_counts=collections.Counter()
    for line in (proc.stdout+'\n'+proc.stderr).splitlines():
        if not line.strip():continue
        matches=categories(line)
        for category in matches:
            counts[category]+=1
        if matches:
            digest_counts[hashlib.sha256(line.encode()).hexdigest()[:12]]+=1
    result['containers'].append({'container':container,'error_categories':dict(counts),'error_digests':dict(digest_counts)})
Path(args.out).write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'journal_alerts':sum(len(x['alerts']) for x in result['journals']),'container_error_lines':sum(sum(x['error_digests'].values()) for x in result['containers'])}))
