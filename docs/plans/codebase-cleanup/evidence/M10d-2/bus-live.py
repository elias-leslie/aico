# A temporary job record against a real transient user unit, no deploy is forged.
import os,pathlib,tempfile,json,secrets,subprocess,shutil
jid='aico-'+secrets.token_hex(6);unit='aico-deploy-'+jid+'.service'
d=pathlib.Path(tempfile.mkdtemp(prefix='aico-m10d2-bus-',dir='/srv/scratch'))
bus={**os.environ,'XDG_RUNTIME_DIR':'/run/user/1000','DBUS_SESSION_BUS_ADDRESS':'unix:path=/run/user/1000/bus'}
try:
 subprocess.run(['systemd-run','--user','--no-ask-password','--quiet','--collect','--unit='+unit,'--','/usr/bin/sleep','60'],env=bus,check=True)
 (d/(jid+'.json')).write_text(json.dumps({'id':jid,'state':'running','sha':'0'*40}))
 stripped={k:v for k,v in os.environ.items() if k not in ('XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS')};stripped['AICO_DEPLOY_JOBS_DIR']=str(d)
 p=subprocess.run(['aico','deploy','result',jid],env=stripped,capture_output=True,text=True)
 state=json.loads((d/(jid+'.json')).read_text())['state']
 active=subprocess.run(['systemctl','--user','is-active',unit],env=bus,capture_output=True,text=True).stdout.strip()
 assert state=='running' and active=='active',(state,active,p.stdout,p.stderr)
 print(json.dumps({'synthetic_job':True,'real_user_unit':active,'bus_env':'both variables absent from CLI','result_state':state,'preserved_running':True}))
finally:
 subprocess.run(['systemctl','--user','--no-ask-password','stop',unit],env=bus,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 shutil.rmtree(d)
