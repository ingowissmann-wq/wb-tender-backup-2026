import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const assess=records=>JSON.parse(execFileSync('python3',['-B','-c',"import importlib.util,json,sys; s=importlib.util.spec_from_file_location('monitor','deployment/production-monitor.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.container_failures(json.load(sys.stdin))))"],{input:JSON.stringify(records),encoding:'utf8'}));
const healthy=()=>Object.fromEntries(['api','worker','scheduler','db'].map(service=>[service,{project:'wb-tender-production',image:'sha256:'+ 'a'.repeat(64),health:'healthy',restarts:0,flags:{EXTERNAL_SUBMISSION_ENABLED:'false',WB_TENDER_ALLOW_EXTERNAL_SUBMISSION:'false'}}]));
test('dedicated submission monitoring requires the worker and matching release while credential waits remain business states',()=>{
 const script=`import importlib.util,copy
s=importlib.util.spec_from_file_location('monitor','deployment/production-monitor.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
records={name:{'project':m.PROJECT,'image':'sha256:'+'a'*64,'health':'healthy','restarts':0,'executionMode':'DEDICATED_VALIDATED_WORKER','flags':{'EXTERNAL_SUBMISSION_ENABLED':'true','WB_TENDER_ALLOW_EXTERNAL_SUBMISSION':'true'}} for name in (*m.SERVICES,'submission-worker')}
assert m.container_failures(records,True)==[]
assert m.container_failures(records)
missing=copy.deepcopy(records);del missing['submission-worker'];assert m.container_failures(missing,True)
mixed=copy.deepcopy(records);mixed['submission-worker']['image']='sha256:'+'b'*64;assert 'release_images_differ' in m.container_failures(mixed,True)
wrong=copy.deepcopy(records);wrong['scheduler']['executionMode']='IMMEDIATE';assert 'scheduler:submission_execution_mode' in m.container_failures(wrong,True)
metrics={k:0 for k in ('duplicateAttempts24h','queued','urgentDeadlines','portalErrors','abandonedUploads','missingReceipts','pendingNotifications','staleWorkers')}
response={'status':'ok','component':'submission-worker','sourceCommit':'a'*40,'externalSubmissionEnabled':True,'lastError':None,'metrics':metrics}
assert m.submission_worker_failures(response,'a'*40)==[]
assert 'submission-worker:release_binding' in m.submission_worker_failures(response,'b'*40)
assert m.submission_worker_failures(dict(response,metrics={}), 'a'*40)
metrics['portalErrors']=14;assert m.submission_worker_failures(response,'a'*40)==[]
metrics['staleWorkers']=1;assert 'submission-worker:heartbeat_stale' in m.submission_worker_failures(response,'a'*40)
print('PASS')`;
 assert.equal(execFileSync('python3',['-B','-c',script],{encoding:'utf8'}).trim(),'PASS');
});
test('monitor fails on a foreign project, divergent images, restarts and submission flags',()=>{
 assert.deepEqual(assess(healthy()),[]);
 const foreign=healthy();foreign.api.project='another-project';assert.ok(assess(foreign).includes('api:project_binding'));
 const mixed=healthy();mixed.worker.image='sha256:'+'b'.repeat(64);assert.ok(assess(mixed).includes('release_images_differ'));
 const restarted=healthy();restarted.scheduler.restarts=1;assert.ok(assess(restarted).includes('scheduler:unexpected_restart'));
 const unsafe=healthy();unsafe.api.flags.EXTERNAL_SUBMISSION_ENABLED='true';assert.ok(assess(unsafe).includes('api:external_submission'));
 assert.ok(assess({}).length>0);
});

test('backup checksum selection binds to the manifest filename in a combined checksum file',()=>{
 const script=`import importlib.util,tempfile,pathlib,hashlib
s=importlib.util.spec_from_file_location('monitor','deployment/production-monitor.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
with tempfile.TemporaryDirectory() as directory:
 p=pathlib.Path(directory)/'database.dump.gpg.manifest';p.write_text('synthetic manifest\\n')
 checksum=pathlib.Path(str(p)+'.sha256'); digest=hashlib.sha256(p.read_bytes()).hexdigest()
 checksum.write_text('0'*64+'  '+str(p.parent/'database.dump.gpg')+'\\n'+digest+'  '+str(p)+'\\n')
 assert m.manifest_checksum_verified(p)
 p.write_text('changed manifest');assert not m.manifest_checksum_verified(p)
print('PASS')`;
 assert.equal(execFileSync('python3',['-B','-c',script],{encoding:'utf8'}).trim(),'PASS');
});

test('scanner monitor checks the loaded signatures, binding and daemon health',()=>{
 const script=`import importlib.util,datetime
s=importlib.util.spec_from_file_location('monitor','deployment/production-monitor.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
now=datetime.datetime(2026,9,8,6,0,tzinfo=datetime.timezone.utc)
r={'project':'wb-tender-malware','configuredImage':m.SCANNER_IMAGE,'health':'healthy','restarts':0,'ping':'PONG','version':'ClamAV 1.5.4/28116/Mon Sep  7 06:24:32 2026','portBindings':{'3310/tcp':[{'HostIp':'127.0.0.1','HostPort':'13310'}]}}
assert m.scanner_failures(r,now)==[]
for field,value in [('project','foreign'),('configuredImage','latest'),('health','unhealthy'),('restarts',1),('ping',''),('portBindings',{'3310/tcp':[{'HostIp':'0.0.0.0','HostPort':'13310'}]}),('version','invalid')]:
 bad=dict(r);bad[field]=value;assert m.scanner_failures(bad,now)
assert 'scanner:signatures_stale' in m.scanner_failures(r,now+datetime.timedelta(days=3))
assert 'scanner:signatures_stale' in m.scanner_failures(r,now-datetime.timedelta(days=3))
print('PASS')`;
 assert.equal(execFileSync('python3',['-B','-c',script],{encoding:'utf8'}).trim(),'PASS');
});

test('operational alerts deduplicate repeated failures and send one recovery notification',()=>{
 const script=`import importlib.util
s=importlib.util.spec_from_file_location('alert','deployment/production-monitor-alert.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
assert m.alert_decision({'errors':[]},{},1000) is None
fingerprint=m.alert_decision({'errors':['scanner:health','disk_space_low']},{},1000)
p={'fingerprint':fingerprint,'sentAt':1000,'hadErrors':True}
assert m.alert_decision({'errors':['disk_space_low','scanner:health']},p,1001) is None
assert m.alert_decision({'errors':['disk_space_low','scanner:health']},p,23000)==fingerprint
assert m.alert_decision({'errors':['disk_space_low']},p,1001)!=fingerprint
recovery=m.alert_decision({'errors':[]},p,1001)
assert recovery is not None
assert m.alert_decision({'errors':[]},{'fingerprint':recovery,'sentAt':1001,'hadErrors':False},1002) is None
print('PASS')`;
 assert.equal(execFileSync('python3',['-B','-c',script],{encoding:'utf8'}).trim(),'PASS');
});

test('operational SMTP alerts require TLS and preserve acceptance when QUIT fails',()=>{
 const script=`import importlib.util,tempfile,pathlib,json
s=importlib.util.spec_from_file_location('alert','deployment/production-monitor-alert.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
values={'smtp_host':'smtp.synthetic.invalid','smtp_port':'587','smtp_secure':'false','smtp_user':'own@synthetic.invalid','smtp_password':'synthetic-secret','smtp_from':'WB <own@synthetic.invalid>'}
m.secret=lambda key:values[key]
calls=[]
class Connection:
 def __init__(self,*args,**kwargs): calls.append('connect')
 def ehlo(self): calls.append('ehlo')
 def starttls(self,context): calls.append('tls')
 def login(self,user,password): assert 'tls' in calls;calls.append('login')
 def send_message(self,message):
  assert str(message['To'])==values['smtp_user'];assert 'synthetic-secret' not in str(message);calls.append('send');return {}
 def quit(self): raise OSError('synthetic quit failure')
 def close(self): calls.append('close')
m.smtplib.SMTP=Connection
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory);report={'checkedAt':'2026-09-08T00:00:00Z','errors':['scanner:health']}
 result=m.notify(report,root);assert result['delivery']=='SMTP_ACCEPTED';assert calls.count('send')==1
 assert 'synthetic-secret' not in (root/'last-alert.json').read_text();assert (root/'last-alert.json').stat().st_mode & 0o777==0o600
 assert m.notify(report,root)['delivery']=='NOT_DUE';assert calls.count('send')==1
 before=(root/'last-alert.json').read_bytes()
 def failed(self,message): raise OSError('synthetic failure')
 Connection.send_message=failed
 try: m.notify({'checkedAt':report['checkedAt'],'errors':['disk_space_low']},root);raise AssertionError('delivery failure accepted')
 except OSError: pass
 assert (root/'last-alert.json').read_bytes()==before
print('PASS')`;
 assert.equal(execFileSync('python3',['-B','-c',script],{encoding:'utf8'}).trim(),'PASS');
});

test('weekly restore monitoring requires a recent completed restore and verified cleanup',()=>{
 const script=`import importlib.util,datetime
s=importlib.util.spec_from_file_location('monitor','deployment/production-monitor.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
now=datetime.datetime(2026,9,8,12,tzinfo=datetime.timezone.utc)
r={'status':'RESTORE_PASS','checkedAt':now.isoformat(),'temporaryResourcesRemoved':True,'productionModified':False}
assert m.scheduled_restore_failures(r,now)==[]
assert m.scheduled_restore_failures(r,now+datetime.timedelta(days=9))==['scheduled_restore_state_stale']
assert m.scheduled_restore_failures(dict(r,temporaryResourcesRemoved=False),now)==['scheduled_restore_result_invalid']
assert m.scheduled_restore_failures(dict(r,productionModified=True),now)==['scheduled_restore_result_invalid']
assert m.scheduled_restore_failures(dict(r,status='PREFLIGHT_PASS'),now)
assert m.scheduled_restore_failures(dict(r,status='BLOCKED_CAPACITY'),now)
assert m.scheduled_restore_failures(dict(r,status='RESTORING'),now)==[]
assert m.scheduled_restore_failures(dict(r,status='RESTORING'),now+datetime.timedelta(hours=5))
print('PASS')`;
 assert.equal(execFileSync('python3',['-B','-c',script],{encoding:'utf8'}).trim(),'PASS');
});
