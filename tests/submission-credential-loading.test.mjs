import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadDispatchCredential} from '../platform/submission-dispatch-sources.mjs';
import {encryptSecret} from '../platform/portal-credentials.mjs';

test('legacy adapter credential enforces expiry, host and scoped recovery lookup',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'submission-credential-'));
 const key=crypto.randomBytes(32),file=join(directory,'key');writeFileSync(file,key.toString('base64'),{mode:0o600});
 const row={origin:'LEGACY',tenant_id:crypto.randomUUID(),company_id:crypto.randomUUID(),portal_id:crypto.randomUUID(),binding:{credentialId:crypto.randomUUID(),portalHost:'sandbox.invalid'}};
 const secret={username:'fixture',password:crypto.randomBytes(24).toString('hex')};
 const stored={id:crypto.randomUUID(),version:2,...encryptSecret(secret,key),bound_host:'sandbox.invalid',valid_until:new Date(Date.now()+3600000).toISOString()};
 const db={query:async(sql,args)=>{assert.deepEqual(args,[row.company_id,row.binding.credentialId,row.portal_id,row.tenant_id]);assert.match(sql,/r\.tenant_id=\$4 AND r\.company_id=\$1 AND r\.portal_id=\$3/);return{rows:[stored]}}};
 try{
  assert.deepEqual((await loadDispatchCredential(db,row,{legacyKeyFile:file})).secret,secret);
  stored.valid_until=new Date(Date.now()-1000).toISOString();
  await assert.rejects(loadDispatchCredential(db,row,{legacyKeyFile:file}),/submission_credentials_required/);
  stored.valid_until=null;stored.bound_host='other.invalid';
  await assert.rejects(loadDispatchCredential(db,row,{legacyKeyFile:file}),/submission_credential_host_mismatch/);
  stored.bound_host='sandbox.invalid';stored.ciphertext=crypto.randomBytes(50);
  await assert.rejects(loadDispatchCredential(db,row,{legacyKeyFile:file}),/submission_credentials_required/);
 }finally{rmSync(directory,{recursive:true,force:true})}
});
