import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('scheduled restore rejects corrupted/stale/path-escaping manifests and never owns production resources', () => {
 const result=spawnSync('python3',['-B','-c',String.raw`
import importlib.util, tempfile, pathlib, datetime, hashlib, json
spec=importlib.util.spec_from_file_location('restore','deployment/scheduled-production-restore.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
now=datetime.datetime(2026,9,8,12,tzinfo=datetime.timezone.utc)
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp);target=root/'good';target.mkdir()
 archive=target/'database.dump.gpg';archive.write_bytes(b'encrypted-fixture')
 manifest=target/'database.dump.gpg.manifest'
 text='created_utc=20260908T110000Z\narchive=database.dump.gpg\narchive_sha256='+hashlib.sha256(archive.read_bytes()).hexdigest()+'\npg_restore_list_verified=true\n'
 def seal(content):
  manifest.write_text(content);manifest.with_name(manifest.name+'.sha256').write_text(hashlib.sha256(manifest.read_bytes()).hexdigest()+'  '+str(manifest)+'\n')
 seal(text)
 assert m.choose_backup(root,now)['archive']==str(archive)
 manifest.write_text(text.replace('110000','100000'))
 try:m.choose_backup(root,now);raise AssertionError('corruption accepted')
 except ValueError:pass
 seal(text.replace('20260908','20260901'))
 try:m.choose_backup(root,now);raise AssertionError('stale accepted')
 except ValueError:pass
 seal(text.replace('archive=database.dump.gpg','archive=../../outside'))
 try:m.choose_backup(root,now);raise AssertionError('path escape accepted')
 except ValueError:pass
 seal(text);archive.unlink();archive.symlink_to('/etc/passwd')
 try:m.choose_backup(root,now);raise AssertionError('archive symlink accepted')
 except ValueError:pass
for invalid in [0,-1,'100']:
 try:m.required_capacity(invalid);raise AssertionError('invalid size accepted')
 except ValueError:pass
assert m.required_capacity(10*1024**3)==34*1024**3
assert not m.owned({'Name':'/wb-tender-production-db','Config':{'Labels':{'com.docker.compose.project':'wb-tender-production'}}},'wb-tender-production-db')
assert not m.owned({'Name':'wrong','Labels':{'wb-tender.purpose':m.PURPOSE}},'expected')
assert m.owned({'Name':'/wb-tender-restore-test','Config':{'Labels':{'wb-tender.purpose':m.PURPOSE}}},'wb-tender-restore-test')
print('restore-safety-pass')
`],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/restore-safety-pass/);
});
