import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {sealPortalSession,openPortalSession} from '../platform/tenant-portal-session-crypto.mjs';
const scope={id:crypto.randomUUID(),tenant_id:crypto.randomUUID(),company_id:crypto.randomUUID(),portal_id:crypto.randomUUID(),credential_id:crypto.randomUUID(),credential_revision:2,key_version:'v1'};
const keyring={active:'v1',keys:new Map([['v1',crypto.randomBytes(32)]])};
test('portal session encryption binds tenant, company, portal, credential revision and session identifier',()=>{
 const session={storageState:{cookies:[{name:'session',value:'SYNTHETIC-COOKIE',domain:'portal.example',path:'/'}]},targetUrl:'https://portal.example/account'};
 const encrypted=sealPortalSession(keyring,scope,session);assert.equal(encrypted.includes(Buffer.from('SYNTHETIC-COOKIE')),false);assert.deepEqual(openPortalSession(keyring,scope,encrypted),session);
 for(const key of ['id','tenant_id','company_id','portal_id','credential_id'])assert.throws(()=>openPortalSession(keyring,{...scope,[key]:crypto.randomUUID()},encrypted),/integrity_failed/);
 assert.throws(()=>openPortalSession(keyring,{...scope,credential_revision:3},encrypted),/integrity_failed/);
 const changed=Buffer.from(encrypted);changed[30]^=1;assert.throws(()=>openPortalSession(keyring,scope,changed),/integrity_failed/);
});
