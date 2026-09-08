import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
test('scheduled backup reserves both an uncompressed archive and full restore without deleting retention',()=>{
 const result=JSON.parse(execFileSync('python3',['-B','-c',`import importlib.util,json
s=importlib.util.spec_from_file_location('backup','deployment/scheduled-production-backup.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps({'required':m.required_capacity(36*1024**3),'floor':20*1024**3}))`],{encoding:'utf8'}));
 assert.ok(result.required>110*1024**3);assert.ok(result.required-36*1024**3>result.floor);
});
test('backup file reader rejects symlinks and group-readable secret files',()=>{
 const result=JSON.parse(execFileSync('python3',['-B','-c',`import importlib.util,json,tempfile,os,pathlib
s=importlib.util.spec_from_file_location('backup','deployment/scheduled-production-backup.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with tempfile.TemporaryDirectory(prefix='wb-backup-test-') as directory:
 p=pathlib.Path(directory)/'synthetic';p.write_text('synthetic-only');os.chmod(p,0o640)
 denied=[]
 try:m.protected_file(p)
 except ValueError:denied.append('permissions')
 os.chmod(p,0o600);assert m.protected_file(p)==b'synthetic-only'
 link=pathlib.Path(directory)/'link';link.symlink_to(p)
 try:m.protected_file(link)
 except OSError:denied.append('symlink')
 print(json.dumps(denied))`],{encoding:'utf8'}));assert.deepEqual(result,['permissions','symlink']);
});
test('monitor distinguishes an active backup timer from a verified backup or capacity block',()=>{
 const result=JSON.parse(execFileSync('python3',['-B','-c',`import importlib.util,json,datetime
s=importlib.util.spec_from_file_location('monitor','deployment/production-monitor.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
now=datetime.datetime.now(datetime.timezone.utc)
records=[None,{'status':'BLOCKED_CAPACITY'},{'status':'PREFLIGHT_PASS'},{'status':'BACKUP_PASS','checkedAt':now.isoformat(),'backupCreated':False},{'status':'BACKUP_PASS','checkedAt':now.isoformat(),'backupCreated':True}]
print(json.dumps([m.scheduled_backup_failures(r,now) for r in records]))`],{encoding:'utf8'}));
 assert.deepEqual(result.at(-1),[]);for(const errors of result.slice(0,-1))assert.ok(errors.length>0);
});
