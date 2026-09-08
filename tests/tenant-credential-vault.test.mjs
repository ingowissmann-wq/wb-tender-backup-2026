import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadCredentialKeyring,sealPortalCredential,openPortalCredential} from '../platform/tenant-credential-vault.mjs';
const scope=()=>({id:crypto.randomUUID(),tenant_id:crypto.randomUUID(),company_id:crypto.randomUUID(),portal_id:crypto.randomUUID(),revision:1,key_version:'v1'});
const keyring=()=>({active:'v1',keys:new Map([['v1',crypto.randomBytes(32)],['v2',crypto.randomBytes(32)]])});
const secret={username:'synthetic@example.invalid',password:'synthetic-only-password'};
test('vault encrypts both credentials and rejects each changed binding and corrupted envelope',()=>{
 const keys=keyring(),binding=scope(),sealed=sealPortalCredential(keys,binding,secret);
 assert.deepEqual(openPortalCredential(keys,binding,sealed),secret);
 assert.equal(sealed.includes(Buffer.from(secret.password)),false);
 assert.equal(sealed.includes(Buffer.from(secret.username)),false);
 assert.notDeepEqual(sealPortalCredential(keys,binding,secret),sealed);
 for(const field of ['id','tenant_id','company_id','portal_id']) assert.throws(()=>openPortalCredential(keys,{...binding,[field]:crypto.randomUUID()},sealed),/integrity_failed/);
 assert.throws(()=>openPortalCredential(keys,{...binding,revision:2},sealed),/integrity_failed/);
 assert.throws(()=>openPortalCredential(keys,{...binding,key_version:'v2'},sealed),/integrity_failed/);
 for(const index of [0,12,28,sealed.length-1]){const corrupt=Buffer.from(sealed);corrupt[index]^=1;assert.throws(()=>openPortalCredential(keys,binding,corrupt),/integrity_failed/)}
});
test('key rotation preserves the exact credential and old version remains decryptable until deliberately retired',()=>{
 const keys=keyring(),binding=scope(),old=sealPortalCredential(keys,binding,secret),next={...binding,revision:2,key_version:'v2'};
 const rotated=sealPortalCredential(keys,next,openPortalCredential(keys,binding,old));
 assert.deepEqual(openPortalCredential(keys,next,rotated),secret);
 keys.keys.delete('v1');
 assert.throws(()=>openPortalCredential(keys,binding,old),/integrity_failed/);
 assert.deepEqual(openPortalCredential(keys,next,rotated),secret);
});
test('keyring is file-only, mode 0600, refuses symlinks and malformed keys without disclosing contents',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-vault-test-')),file=path.join(dir,'keyring'),link=path.join(dir,'link');
 try{
  const encoded=crypto.randomBytes(32).toString('base64');
  fs.writeFileSync(file,JSON.stringify({active:'v1',keys:{v1:encoded}}),{mode:0o600});
  assert.equal(loadCredentialKeyring(file).keys.get('v1').toString('base64'),encoded);
  fs.symlinkSync(file,link);assert.throws(()=>loadCredentialKeyring(link),/keyring_invalid/);
  fs.chmodSync(file,0o644);assert.throws(()=>loadCredentialKeyring(file),/keyring_invalid/);
  fs.chmodSync(file,0o600);fs.writeFileSync(file,'secret malformed data');
  assert.throws(()=>loadCredentialKeyring(file),error=>error.message==='portal_credential_keyring_invalid');
  assert.throws(()=>loadCredentialKeyring(''),/unconfigured/);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('vault refuses missing credentials and invalid scope instead of inventing defaults',()=>{
 const keys=keyring(),binding=scope();
 for(const invalid of [{},{username:'',password:'x'},{username:'a',password:''},{username:'a',password:'x'.repeat(4097)}])assert.throws(()=>sealPortalCredential(keys,binding,invalid),/input_invalid/);
 assert.throws(()=>sealPortalCredential(keys,{...binding,revision:0},secret),/scope_invalid/);
});
