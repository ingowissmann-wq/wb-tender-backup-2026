import crypto from 'node:crypto';
import QRCode from 'qrcode';
import {withTenantContext,validTenantId} from './tenant-context.mjs';
import {hashTenderPassword,randomTotpSecret,encryptTotpSecret,decryptTotpSecret,validTotpCounter} from './admin-auth.mjs';
const fail=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode});
export class NativeInvitations {
 constructor(pool,{invitationPepper,fieldEncryptionKey}){this.pool=pool;this.pepper=invitationPepper;this.key=fieldEncryptionKey;}
 hash(value){if(!this.pepper||this.pepper.length<32)throw fail('invitation_delivery_not_configured',503);return crypto.createHmac('sha256',this.pepper).update(value).digest('hex');}
 context(input){if(!validTenantId(input.tenantId))throw fail('invitation_invalid',400);return {tenantId:input.tenantId};}
 token(value){if(!/^[A-Za-z0-9_-]{32,128}$/.test(String(value||'')))throw fail('invitation_invalid',400);return this.hash(value);}
 async begin(input){
  const context=this.context(input),tokenHash=this.token(input.token),email=String(input.email||'').trim().toLowerCase(),password=String(input.password||'');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)throw fail('email_invalid',400);
  if(password.length<12||password.length>128||password!==input.passwordConfirmation)throw fail('password_invalid',400);
  const secret=randomTotpSecret(),passwordHash=await hashTenderPassword(password),encrypted=encryptTotpSecret(secret,this.key),nonce=crypto.randomBytes(32).toString('base64url');
  await withTenantContext(this.pool,context,async db=>{
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended('saas-plan:'||$1::text,0))",[context.tenantId]);
   const invite=(await db.query("SELECT i.* FROM saas.tenant_invitations i JOIN saas.tenants t ON t.id=i.tenant_id JOIN saas.subscriptions s ON s.tenant_id=t.id WHERE i.tenant_id=$1 AND i.token_hash=$2 AND i.status='PENDING' AND i.expires_at>now() AND t.status='ACTIVE' AND ((s.status='TRIAL_ACTIVE' AND s.trial_ends_at>now()) OR (s.status='ACTIVE' AND (s.current_period_ends_at IS NULL OR s.current_period_ends_at>now()))) FOR UPDATE OF i",[context.tenantId,tokenHash])).rows[0];
   if(!invite||invite.email.toLowerCase()!==email)throw fail('invitation_not_eligible');
   if(!(await db.query("SELECT 1 FROM saas.tenant_memberships WHERE tenant_id=$1 AND user_id=$2 AND status='ACTIVE' AND role IN('OWNER','ADMIN')",[context.tenantId,invite.invited_by])).rowCount)throw fail('invitation_issuer_inactive');
   if((await db.query('SELECT 1 FROM iam.users WHERE lower(email)=$1',[email])).rowCount)throw fail('existing_account_login_required');
   const result=await db.query(`INSERT INTO saas.invitation_enrollments(id,tenant_id,invitation_id,email,nonce_hash,password_hash,mfa_secret_encrypted,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,least($8::timestamptz,now()+interval '15 minutes')) ON CONFLICT(tenant_id,invitation_id) DO UPDATE SET nonce_hash=excluded.nonce_hash,password_hash=excluded.password_hash,mfa_secret_encrypted=excluded.mfa_secret_encrypted,expires_at=excluded.expires_at,attempt_count=0,updated_at=now() WHERE invitation_enrollments.status='PENDING' RETURNING id`,[crypto.randomUUID(),context.tenantId,invite.id,email,this.hash('enrollment:'+nonce),passwordHash,encrypted,invite.expires_at]);
   if(!result.rowCount)throw fail('invitation_not_eligible');
  });
  const uri=`otpauth://totp/${encodeURIComponent('WB-Tender:'+email)}?secret=${secret}&issuer=WB-Tender&algorithm=SHA1&digits=6&period=30`;
  return {nonce,mfaSecret:secret,mfaQrCode:await QRCode.toDataURL(uri,{errorCorrectionLevel:'M',margin:2,width:220}),productionAccessGranted:false};
 }
 async finish(input){
  const context=this.context(input);this.token(input.nonce);const hash=this.hash('enrollment:'+input.nonce);
  const result=await withTenantContext(this.pool,context,async db=>{
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended('saas-plan:'||$1::text,0))",[context.tenantId]);
   const row=(await db.query('SELECT * FROM saas.invitation_enrollments WHERE tenant_id=$1 AND nonce_hash=$2 FOR UPDATE',[context.tenantId,hash])).rows[0];
   if(!row)throw fail('invitation_enrollment_invalid');
   if(row.status==='ACTIVATED')return {ok:true,idempotent:true};
   if(new Date(row.expires_at)<=new Date()||row.attempt_count>=8)throw fail('invitation_enrollment_expired');
   if(validTotpCounter(decryptTotpSecret(row.mfa_secret_encrypted,this.key),String(input.mfaCode||''),Date.now())==null){
    await db.query('UPDATE saas.invitation_enrollments SET attempt_count=attempt_count+1,updated_at=now() WHERE tenant_id=$1 AND id=$2',[context.tenantId,row.id]);
    return {error:'mfa_code_invalid'}; // Commit failed-attempt accounting before replying.
   }
   await db.query("UPDATE saas.invitation_enrollments SET status='VERIFIED',verified_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2",[context.tenantId,row.id]);
   await db.query('SELECT saas.activate_invited_native_identity($1,$2)',[context.tenantId,row.id]);
   return {ok:true,idempotent:false};
  });
  if(result.error)throw fail(result.error,400);return {...result,loginUrl:'/saas/login'};
 }
 async accept(input,userId){const context={...this.context(input),actorUserId:userId},hash=this.token(input.token);if(!validTenantId(userId))throw fail('authentication_required',401);return withTenantContext(this.pool,context,async db=>({ok:true,tenantId:context.tenantId,role:(await db.query('SELECT saas.accept_existing_native_invitation($1,$2,$3) role',[context.tenantId,hash,userId])).rows[0].role}));}
}
export function invitationError(error,reply){
 const known=/^(invitation_[a-z_]+|mfa_code_invalid|email_invalid|password_invalid|existing_account_login_required|native_identity_already_exists|self_service_registration_already_pending|multi_tenant_identity_not_enabled|membership_already_exists|authentication_required)$/;
 if(error.message.includes('saas_plan_limit_exceeded'))return reply.code(409).send({error:'seat_limit_exceeded'});
 if(known.test(error.message))return reply.code(error.statusCode||409).send({error:error.message});throw error;
}
export const invitationJs=`const status=document.querySelector('#invitation-status'),form=document.querySelector('#enroll'),verify=document.querySelector('#verify'),params=new URLSearchParams(location.hash.slice(1)),tenantId=params.get('tenantId'),token=params.get('token');let nonce;history.replaceState(null,'',location.pathname);const csrf=()=>decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('wb_csrf='))?.split('=').slice(1).join('=')||'');async function send(path,body){const r=await fetch('/api/saas/invitations/'+path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-csrf-token':csrf()},body:JSON.stringify({tenantId,...body})});const data=await r.json();if(!r.ok)throw Error(data.error||'Einladung fehlgeschlagen');return data;}if(!tenantId||!token){form.hidden=true;status.textContent='Einladungslink unvollständig.';}form.addEventListener('submit',async e=>{e.preventDefault();const button=form.querySelector('button');button.disabled=true;try{const data=await send('enroll',{...Object.fromEntries(new FormData(form)),token});nonce=data.nonce;form.reset();form.hidden=true;verify.hidden=false;verify.querySelector('img').src=data.mfaQrCode;verify.querySelector('code').textContent=data.mfaSecret;status.textContent='Authenticator einrichten und Code bestätigen.';}catch(e){status.textContent=e.message;}finally{button.disabled=false;}});verify.addEventListener('submit',async e=>{e.preventDefault();try{await send('verify',{nonce,mfaCode:new FormData(verify).get('mfaCode')});verify.reset();verify.hidden=true;verify.querySelector('img').removeAttribute('src');verify.querySelector('code').textContent='';status.textContent='Konto aktiviert. Melden Sie sich mit Passwort und Authenticator an.';}catch(e){status.textContent=e.message;}});document.querySelector('#accept-existing').addEventListener('click',async()=>{try{await send('accept',{token});status.textContent='Einladung angenommen. Portal über die Anmeldung öffnen.';}catch(e){status.textContent=e.message;}});`;
export const invitationHtml=`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Einladung annehmen</title><link rel="stylesheet" href="/saas/assets/commercial.css"><script src="/saas/assets/invitation.js" defer></script></head><body><main class="panel"><h1>Einladung annehmen</h1><p>Die Einladung bestätigt Ihre E-Mail-Adresse. Ihr Zugang gehört zum gebuchten Paket Ihres Unternehmens. Es entsteht keine eigene Paketbuchung.</p><form id="enroll"><label>Eingeladene E-Mail<input type="email" name="email" required autocomplete="email"></label><label>Neues Passwort<input type="password" name="password" minlength="12" maxlength="128" required autocomplete="new-password"></label><label>Passwort wiederholen<input type="password" name="passwordConfirmation" minlength="12" maxlength="128" required autocomplete="new-password"></label><button>Konto und Authenticator einrichten</button></form><form id="verify" hidden><h2>Authenticator einrichten</h2><img alt="QR-Code für Authenticator" width="220" height="220"><p>Manueller Schlüssel: <code></code></p><label>Sechsstelliger Code<input name="mfaCode" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" required></label><button>Konto aktivieren</button></form><p>Bereits ein Konto? <a href="/saas/login" target="_blank" rel="noopener">In einem neuen Tab anmelden</a>, danach hier bestätigen.</p><button id="accept-existing">Mit angemeldetem Konto annehmen</button><p id="invitation-status" role="status" aria-live="polite"></p><a href="/saas/login">Zur Anmeldung</a></main></body></html>`;
