import crypto from 'node:crypto';
import {validTenantId} from './tenant-context.mjs';
const fail=()=>Object.assign(new Error('portal_session_integrity_failed'),{statusCode:409});
function aad(scope){
 if(!['id','tenant_id','company_id','portal_id','credential_id'].every(key=>validTenantId(scope[key]))||!Number.isSafeInteger(scope.credential_revision)||scope.credential_revision<1||!/^[A-Za-z0-9_-]{1,64}$/.test(scope.key_version))throw fail();
 return Buffer.from(JSON.stringify(['WB_TENDER_PORTAL_SESSION_V1',scope.id,scope.tenant_id,scope.company_id,scope.portal_id,scope.credential_id,scope.credential_revision,scope.key_version]));
}
export function sealPortalSession(keyring,scope,session){
 const key=keyring.keys.get(scope.key_version);if(!key)throw fail();
 const bytes=Buffer.from(JSON.stringify(session));try{if(bytes.length>1048500)throw fail();const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad(scope));const encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),encrypted]);}finally{bytes.fill(0);}
}
export function openPortalSession(keyring,scope,envelope){
 let bytes;try{if(!Buffer.isBuffer(envelope)||envelope.length<30||envelope.length>1048576)throw fail();const key=keyring.keys.get(scope.key_version);if(!key)throw fail();const decipher=crypto.createDecipheriv('aes-256-gcm',key,envelope.subarray(0,12));decipher.setAAD(aad(scope));decipher.setAuthTag(envelope.subarray(12,28));bytes=Buffer.concat([decipher.update(envelope.subarray(28)),decipher.final()]);return JSON.parse(bytes.toString('utf8'));}catch{throw fail()}finally{bytes?.fill(0)}
}
