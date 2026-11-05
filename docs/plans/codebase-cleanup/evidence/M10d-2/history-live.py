# Synthetic transcript, only its own shell session is ended.
import http.client,socket,json,uuid,pathlib,datetime,time
class C(http.client.HTTPConnection):
 def connect(self):
  self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.connect('/run/user/1000/tether/default/control.sock')
def req(method,path,body=None):
 c=C('localhost');c.request(method,path,body=None if body is None else json.dumps(body),headers={'Content-Type':'application/json'});r=c.getresponse();data=json.load(r);c.close()
 assert r.status<300,(r.status,path,data)
 return data
u=str(uuid.uuid4());now=datetime.datetime.now(datetime.timezone.utc);folder=pathlib.Path.home()/'.codex/sessions'/now.strftime('%Y/%m/%d');folder.mkdir(parents=True,exist_ok=True)
p=folder/f'rollout-TEST-M10d2-{u}.jsonl';session=None;ended=False
try:
 session=req('POST','/v1/sessions',{'tool':'shell','origin':'cli','projectId':'aico','projectRoot':'/srv/workspaces/projects/aico','name':'TEST M10d2 history closure','size':{'cols':80,'rows':24}})
 if 'session' in session:session=session['session']
 sid=session['id'];generation=session['generation']
 assert req('PUT','/v1/history/owner',{'session':sid,'tool':'codex','nativeId':u})['kept']
 rows=[{'timestamp':now.isoformat(),'type':'session_meta','payload':{'id':u,'cwd':'/srv/scratch/TEST-M10d2-history'}},{'timestamp':now.isoformat(),'type':'event_msg','payload':{'type':'task_started'}}]
 p.write_text(''.join(json.dumps(x)+'\n' for x in rows))
 req('POST',f'/v1/sessions/{sid}/end',{'generation':generation});ended=True
 for _ in range(40):
  rows=req('GET','/v1/history?tool=codex&limit=500')['items']
  own=next((x for x in rows if x.get('id')=='codex:'+u),None)
  if own and own.get('outcome')=='aborted':
   print(json.dumps({'synthetic':True,'session_ended':True,'native_id':u,'history_id':own['id'],'outcome':own['outcome'],'delayed_scan_closed':True}));break
  time.sleep(1)
 else:raise RuntimeError('synthetic history did not settle as aborted')
finally:
 if session and not ended:req('POST',f'/v1/sessions/{session["id"]}/end',{'generation':session['generation']})
 p.unlink(missing_ok=True)
