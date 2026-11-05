# Synthetic live pairing check; pairing material stays only in memory.
import base64,hashlib,json,secrets,time,urllib.request,urllib.error,subprocess
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes,serialization
B='http://127.0.0.1:3002'
def req(path,body=None,headers=None,method=None):
 data=None if body is None else json.dumps(body,separators=(',',':')).encode()
 r=urllib.request.Request(B+path,data=data,headers={'Content-Type':'application/json',**(headers or {})},method=method)
 try:
  with urllib.request.urlopen(r,timeout=20) as f:return f.status,json.load(f)
 except urllib.error.HTTPError as e:return e.code,json.load(e)
def b64(b):return base64.urlsafe_b64encode(b).decode().rstrip('=')
def code():
 status,p=req('/api/phone-pair',{})
 assert status==200,('pair issue refused',status)
 return json.loads(base64.urlsafe_b64decode(p['link'].split('?p=')[1].split('#')[0]+'==='))['code']
priv=ec.generate_private_key(ec.SECP256R1());enc=ec.generate_private_key(ec.SECP256R1())
def point(k):return b64(k.public_key().public_bytes(serialization.Encoding.X962,serialization.PublicFormat.UncompressedPoint))
def register(c):
 body={'sig_pub':point(priv),'enc_pub':point(enc),'auth':b64(secrets.token_bytes(16)),'fcm_token':'','model':'TEST M10d2 pairing record','app_version':'TEST','code':c}
 raw=json.dumps(body,separators=(',',':')).encode();ts=str(int(time.time()));path='/api/app/register'
 canonical=f'POST\n{path}\n{ts}\n{b64(hashlib.sha256(raw).digest())}'.encode()
 return req(path,body,{'x-nightshift-ts':ts,'x-nightshift-sig':b64(priv.sign(canonical,ec.ECDSA(hashes.SHA256())))})
status,before=req('/api/phone-app');assert status==200 and isinstance(before['phones'],list)
ids={p['id'] for p in before['phones']};test=None
try:
 c=code();status,r=register(c);assert status==200,('register',status);test=r['device_id']
 assert test not in ids
 status,r=register(c);assert status==401,('used code',status)
 status,r=register(code());assert status==200 and r['device_id']==test
 _,after=req('/api/phone-app');assert {p['id'] for p in after['phones']}==ids|{test}
 print(json.dumps({'register':'ok','used_code':401,'re_pair':'same record','original_phones':len(ids),'after_re_pair':len(after['phones']),'original_ids_preserved':True,'apk_published':before['published']}))
finally:
 if test:
  p=subprocess.run(['aico','phones','remove',test],capture_output=True,text=True)
  if p.returncode: raise RuntimeError('phone cleanup CLI failed: '+p.stderr[:300])
  _,after=req('/api/phone-app');assert {p['id'] for p in after['phones']}==ids
  print(json.dumps({'cleanup':'aico phones remove succeeded','phone_count_restored':len(ids)}))
