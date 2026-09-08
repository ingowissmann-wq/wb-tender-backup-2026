import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {NativeInvitations} from '../platform/saas-invitations.mjs';
import {encryptTotpSecret,randomTotpSecret} from '../platform/admin-auth.mjs';
import {moduleAccess,technicalCapabilities} from '../platform/saas-catalog.mjs';
const tenantId=crypto.randomUUID(),key=crypto.randomBytes(32),pepper=crypto.randomBytes(32).toString('hex');
test('invited enrollment requires bounded opaque proof and a strong matching password',async()=>{
 const service=new NativeInvitations({connect(){throw Error('database_should_not_be_used');}},{invitationPepper:pepper,fieldEncryptionKey:key});
 await assert.rejects(()=>service.begin({tenantId,token:'short'}),/invitation_invalid/);
 await assert.rejects(()=>service.begin({tenantId,token:'a'.repeat(43),email:'test@example.invalid',password:'short',passwordConfirmation:'short'}),/password_invalid/);
 await assert.rejects(()=>service.accept({tenantId,token:'a'.repeat(43)},undefined),/authentication_required/);
});
test('failed invited MFA attempts commit their counter without activating an identity',async()=>{
 const calls=[],row={id:crypto.randomUUID(),status:'PENDING',attempt_count:0,expires_at:new Date(Date.now()+60000),mfa_secret_encrypted:encryptTotpSecret(randomTotpSecret(),key)};
 const pool={connect:async()=>({query:async(sql)=>{calls.push(sql);return {rows:sql.startsWith('SELECT * FROM saas.invitation_enrollments')?[row]:[],rowCount:1};},release(){}})};
 const service=new NativeInvitations(pool,{invitationPepper:pepper,fieldEncryptionKey:key});
 await assert.rejects(()=>service.finish({tenantId,nonce:'a'.repeat(43),mfaCode:'invalid'}),/mfa_code_invalid/);
 assert.ok(calls.some(x=>x.includes('attempt_count=attempt_count+1')));assert.ok(calls.includes('COMMIT'));assert.ok(!calls.some(x=>x.includes('activate_invited_native_identity')));
 row.attempt_count=8;calls.length=0;await assert.rejects(()=>service.finish({tenantId,nonce:'a'.repeat(43),mfaCode:'123456'}),/invitation_enrollment_expired/);assert.ok(calls.includes('ROLLBACK'));
});
test('billing-only users cannot use operational modules or their technical capabilities',()=>{
 const context={role:'BILLING',access:{allowed:true},modules:['people','control','tender_scout']};
 for(const module of context.modules)assert.equal(moduleAccess(context,module).reason,'billing_role_only');
 assert.deepEqual(technicalCapabilities(context),[]);
});
