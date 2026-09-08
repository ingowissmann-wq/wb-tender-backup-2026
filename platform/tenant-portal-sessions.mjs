import {withTenantContext,validTenantId} from './tenant-context.mjs';
import {loadCredentialKeyring,openPortalCredential} from './tenant-credential-vault.mjs';
import {sealPortalSession,openPortalSession} from './tenant-portal-session-crypto.mjs';
import {authenticatePortalWithBrowser,restorePortalSessionWithBrowser} from './semantic-browser-auth.mjs';
import {portalAuthenticationHosts,portalAuthenticationRequestAllowed} from './portal-auth-boundary.mjs';
import {snapshotHash} from './canonical-truth.mjs';
const fail=(code,statusCode=409)=>Object.assign(new Error(code),{statusCode});
const codes=new Set(['LOGIN_ERFOLGREICH','LOGIN_FORMULAR_GEAENDERT','LOGIN_FORMULAR_UNSICHER','LOGIN_REDIRECT_UNERWARTET','MFA_BESTÄTIGUNG_ERFORDERLICH','BENUTZERNAME_ODER_PASSWORT_FALSCH','PORTAL_NICHT_ERREICHBAR','SESSION_COOKIE_FEHLT','SESSION_RESTORE_FAILED','TECHNISCHER_CONNECTORFEHLER']);
const metadata=row=>Object.fromEntries(['id','company_id','portal_id','credential_id','credential_revision','status','result_code','expires_at','revoked_at','created_at','verified_at'].map(key=>[key,row[key]]));
export class TenantPortalSessions{
 constructor({pool,keyringFile,authenticate=authenticatePortalWithBrowser,restore=restorePortalSessionWithBrowser}){this.pool=pool;this.keyringFile=keyringFile;this.authenticate=authenticate;this.restore=restore;}
 async credential(db,context,companyId,id){
  const row=(await db.query("SELECT v.*,to_jsonb(p) portal FROM tenant_portal.credential_vault v JOIN saas.tenant_companies c ON c.tenant_id=v.tenant_id AND c.id=v.company_id AND c.status='ACTIVE' JOIN tender.portal_registry p ON p.id=v.portal_id WHERE v.tenant_id=$1 AND v.company_id=$2 AND v.id=$3",[context.id,companyId,id])).rows[0];if(!row)throw fail('portal_session_credential_not_found',404);return row;
 }
 async list(context,companyId,credentialId){
  if(![companyId,credentialId].every(validTenantId))throw fail('portal_session_credential_not_found',404);
  return withTenantContext(this.pool,context,async db=>{
   const credential=await this.credential(db,context,companyId,credentialId);
   return (await db.query('SELECT * FROM tenant_portal.portal_sessions WHERE tenant_id=$1 AND company_id=$2 AND credential_id=$3 ORDER BY created_at DESC,id DESC LIMIT 30',[context.id,companyId,credentialId])).rows.map(row=>({...metadata(row),usable:row.status==='VERIFIED'&&!row.revoked_at&&row.credential_revision===credential.revision&&new Date(row.expires_at)>new Date()}));
  });
 }
 async check(context,companyId,credentialId,input){
  if(![companyId,credentialId,input?.id].every(validTenantId)||!Number.isSafeInteger(input?.expectedRevision)||input.expectedRevision<1)throw fail('portal_session_input_invalid',400);
  const keyring=loadCredentialKeyring(this.keyringFile);
  const prepared=await withTenantContext(this.pool,context,async db=>{
   const credential=await this.credential(db,context,companyId,credentialId);
   if(credential.revision!==input.expectedRevision)throw fail('portal_session_credential_changed');
   const existing=(await db.query('SELECT * FROM tenant_portal.portal_sessions WHERE tenant_id=$1 AND id=$2',[context.id,input.id])).rows[0];
   if(existing){if(existing.company_id!==companyId||existing.credential_id!==credentialId||existing.credential_revision!==input.expectedRevision||existing.created_by!==context.actorUserId)throw fail('portal_session_request_conflict');return {existing};}
   if(!credential.portal.authentication_entry_url||!portalAuthenticationRequestAllowed({url:credential.portal.authentication_entry_url,allowedHosts:portalAuthenticationHosts(credential.portal)}))throw fail('portal_session_verified_login_target_required');
   const row=(await db.query("INSERT INTO tenant_portal.portal_sessions(id,tenant_id,company_id,portal_id,credential_id,credential_revision,status,result_code,key_version,created_by) VALUES($1,$2,$3,$4,$5,$6,'CHECKING','CHECKING',$7,$8) ON CONFLICT(id) DO NOTHING RETURNING *",[input.id,context.id,companyId,credential.portal_id,credentialId,credential.revision,keyring.active,context.actorUserId])).rows[0];if(!row)throw fail('portal_session_request_conflict');
   await this.audit(db,context,input.id,'PORTAL_SESSION_CHECK_STARTED');return {row,credential};
  });
  if(prepared.existing)return metadata(prepared.existing);
  let result,secret;
  try{
   secret=openPortalCredential(keyring,prepared.credential,prepared.credential.ciphertext);
   result=await this.authenticate({portal:prepared.credential.portal,credential:secret,timeoutMs:60000});
   if(result.resultCode==='LOGIN_ERFOLGREICH'){
    if(!result.session||!result.documentAccess||!portalAuthenticationRequestAllowed({url:result.authenticatedUrl,allowedHosts:portalAuthenticationHosts(prepared.credential.portal),credential:secret}))throw fail('portal_session_login_not_verified');
    const restored=await this.restore({portal:prepared.credential.portal,session:result.session,targetUrl:result.authenticatedUrl,timeoutMs:60000});
    result=restored.resultCode==='SESSION_VALID'?{resultCode:'LOGIN_ERFOLGREICH',session:restored.session,authenticatedUrl:restored.authenticatedUrl,sessionExpiresAt:restored.sessionExpiresAt}:{resultCode:'SESSION_RESTORE_FAILED'};
   }
  }catch{result={resultCode:'TECHNISCHER_CONNECTORFEHLER'};}finally{if(secret){secret.username='';secret.password='';}}
  return withTenantContext(this.pool,context,async db=>{
   await db.query('SELECT id FROM tenant_portal.credential_vault WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[context.id,credentialId]);
   const current=await this.credential(db,context,companyId,credentialId);
   const stale=current.revision!==prepared.row.credential_revision;
   let resultCode=stale?'CREDENTIAL_CHANGED':codes.has(result.resultCode)?result.resultCode:'TECHNISCHER_CONNECTORFEHLER';
   let ciphertext=null,expires=null,status=stale?'STALE':resultCode==='MFA_BESTÄTIGUNG_ERFORDERLICH'?'MFA_REQUIRED':'FAILED';
   if(resultCode==='LOGIN_ERFOLGREICH'){
    const expiry=Date.parse(result.sessionExpiresAt);
    if(Number.isFinite(expiry)&&expiry>Date.now()){expires=new Date(Math.min(expiry,Date.now()+3600000));ciphertext=sealPortalSession(keyring,prepared.row,{session:result.session,targetUrl:result.authenticatedUrl});status='VERIFIED';}else{resultCode='SESSION_EXPIRY_INVALID';}
   }
   const row=(await db.query('UPDATE tenant_portal.portal_sessions SET status=$3,result_code=$4,ciphertext=$5,expires_at=$6,verified_at=CASE WHEN $3=\'VERIFIED\' THEN now() ELSE NULL END WHERE tenant_id=$1 AND id=$2 RETURNING *',[context.id,input.id,status,resultCode,ciphertext,expires])).rows[0];
   if(ciphertext&&snapshotHash(openPortalSession(keyring,row,row.ciphertext))!==snapshotHash({session:result.session,targetUrl:result.authenticatedUrl}))throw fail('portal_session_readback_failed');
   await this.audit(db,context,input.id,'PORTAL_SESSION_'+status);return metadata(row);
  }).catch(async error=>{
   await withTenantContext(this.pool,context,async db=>{
    const changed=await db.query("UPDATE tenant_portal.portal_sessions SET status='FAILED',result_code='CHECK_INTERRUPTED' WHERE tenant_id=$1 AND id=$2 AND status='CHECKING'",[context.id,input.id]);
    if(changed.rowCount)await this.audit(db,context,input.id,'PORTAL_SESSION_CHECK_INTERRUPTED');
   });
   throw error;
  });
 }
 async restoreStored(context,companyId,credentialId,id){
  if(![companyId,credentialId,id].every(validTenantId))throw fail('portal_session_not_found',404);
  const keyring=loadCredentialKeyring(this.keyringFile);
  const prepared=await withTenantContext(this.pool,context,async db=>{
   const credential=await this.credential(db,context,companyId,credentialId);
   const row=(await db.query("SELECT * FROM tenant_portal.portal_sessions WHERE tenant_id=$1 AND company_id=$2 AND credential_id=$3 AND id=$4 AND status='VERIFIED' AND revoked_at IS NULL AND expires_at>now()",[context.id,companyId,credentialId,id])).rows[0];
   if(!row||row.credential_revision!==credential.revision)throw fail('portal_session_expired_or_changed');
   await this.audit(db,context,id,'PORTAL_SESSION_RESTORE_STARTED');return {row,portal:credential.portal,value:openPortalSession(keyring,row,row.ciphertext)};
  });
  let result;try{result=await this.restore({portal:prepared.portal,session:prepared.value.session,targetUrl:prepared.value.targetUrl,timeoutMs:60000});}catch{result={resultCode:'SESSION_RESTORE_FAILED'};}
  return withTenantContext(this.pool,context,async db=>{
   const current=await this.credential(db,context,companyId,credentialId);
   const valid=current.revision===prepared.row.credential_revision&&new Date(prepared.row.expires_at)>new Date()&&result.resultCode==='SESSION_VALID';
   if(!valid)await db.query('UPDATE tenant_portal.portal_sessions SET revoked_at=now() WHERE tenant_id=$1 AND id=$2 AND revoked_at IS NULL',[context.id,id]);
   await this.audit(db,context,id,valid?'PORTAL_SESSION_RESTORE_VERIFIED':'PORTAL_SESSION_RESTORE_FAILED');return {id,verified:valid,resultCode:valid?'SESSION_VALID':'SESSION_RESTORE_FAILED',externalTransmission:false};
  });
 }
 async audit(db,context,id,action){await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id) VALUES($1,$2,$3,'portal_session',$4)",[context.id,context.actorUserId,action,id]);}
}
