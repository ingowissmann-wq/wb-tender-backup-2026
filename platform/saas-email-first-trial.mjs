import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { bookingContract, createBoundCheckout, BOOKING_TERMS_VERSION } from './saas-booking.mjs';
import { customerIdentityHash, hashVerificationToken, verificationToken } from './saas-adapters.mjs';
import { decryptTotpSecret, encryptTotpSecret, hashTenderPassword, randomTotpSecret, validTotpCounter } from './admin-auth.mjs';

const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CHECKOUT=/^cs_[A-Za-z0-9_]+$/;
const digest=(value)=>crypto.createHash('sha256').update(String(value||'')).digest('hex');

function fail(message,statusCode=400){throw Object.assign(new Error(message),{statusCode});}
function normalizedEmail(value){
  const email=String(value||'').trim().toLowerCase();
  if(!EMAIL.test(email)||email.length>254)fail('email_invalid');
  return email;
}

async function assertTrialEligible(client,email,identityHash,{ignoreIntentId=null,now=new Date()}={}){
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('trial-email-first:'||$1::text,0))",[identityHash]);
  await client.query(`UPDATE saas.trial_onboarding_intents
    SET status='EXPIRED',updated_at=$2
    WHERE customer_identity_hash=$1 AND status='EMAIL_VERIFICATION_PENDING'
      AND verification_expires_at IS NOT NULL AND verification_expires_at<=$2`,[identityHash,now]);
  if((await client.query('SELECT 1 FROM iam.users WHERE lower(email)=$1 LIMIT 1',[email])).rowCount)fail('trial_not_eligible',409);
  if((await client.query('SELECT 1 FROM saas.trial_claims WHERE customer_identity_hash=$1 LIMIT 1',[identityHash])).rowCount)fail('trial_not_eligible',409);
  if((await client.query("SELECT 1 FROM saas.pending_registrations WHERE lower(email)=$1 AND status<>'EXPIRED' LIMIT 1",[email])).rowCount)fail('trial_not_eligible',409);
  if((await client.query(`SELECT 1 FROM saas.trial_onboarding_intents
      WHERE customer_identity_hash=$1
        AND status IN('EMAIL_VERIFICATION_PENDING','EMAIL_VERIFIED','CHECKOUT_CREATED','ACCOUNT_SETUP_PENDING','MFA_SETUP_PENDING')
        AND ($2::uuid IS NULL OR id<>$2::uuid)
      LIMIT 1`,[identityHash,ignoreIntentId])).rowCount)fail('trial_onboarding_already_started',409);
}

export async function beginEmailFirstTrial(pool,{email,requestIp='',userAgent='',verificationPepper,now=new Date()}){
  email=normalizedEmail(email);
  const identityHash=customerIdentityHash(email,verificationPepper);
  const token=verificationToken();
  const tokenHash=hashVerificationToken(token,verificationPepper);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await assertTrialEligible(client,email,identityHash,{now});
    const row=(await client.query(`INSERT INTO saas.trial_onboarding_intents
      (email,customer_identity_hash,verification_token_hash,verification_expires_at,request_ip_hash,request_user_agent_hash)
      VALUES($1,$2,$3,$4,$5,$6)
      RETURNING id,email,booking_id`,[
        email,identityHash,tokenHash,new Date(now.getTime()+24*60*60*1000),digest(requestIp),digest(userAgent)
      ])).rows[0];
    await client.query('COMMIT');
    return {...row,token};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();}
}

export async function verifyEmailAndCreateCheckout(pool,{token,verificationPepper,billingAdapter,now=new Date()}){
  const tokenHash=hashVerificationToken(String(token||''),verificationPepper);
  const client=await pool.connect();
  let intent;
  let contract;
  try{
    await client.query('BEGIN');
    intent=(await client.query('SELECT * FROM saas.trial_onboarding_intents WHERE verification_token_hash=$1 FOR UPDATE',[tokenHash])).rows[0];
    if(!intent||!intent.verification_expires_at||new Date(intent.verification_expires_at)<=now)fail('verification_token_invalid_or_expired');
    if(intent.status==='CHECKOUT_CREATED'&&intent.checkout_ref)fail('checkout_already_created',409);
    if(intent.status!=='EMAIL_VERIFICATION_PENDING')fail('onboarding_state_invalid',409);
    await assertTrialEligible(client,intent.email,intent.customer_identity_hash,{ignoreIntentId:intent.id,now});
    if(!billingAdapter?.configured)fail('payment_provider_not_configured',503);

    contract=bookingContract({
      purchaseKind:'TRIAL',plan:'TRIAL',billingPath:'AUTO_CARD',
      consentVersion:BOOKING_TERMS_VERSION,bookingConfirmed:true
    });
    const tenantId=crypto.randomUUID();
    const slug=`account-${tenantId.slice(0,12)}`;
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
    await client.query(`INSERT INTO saas.tenants(id,slug,display_name,customer_identity_hash)
      VALUES($1,$2,$3,$4)`,[tenantId,slug,'Konto wird eingerichtet',intent.customer_identity_hash]);
    await client.query(`INSERT INTO saas.pending_registrations
      (tenant_id,email,requested_plan_code,verification_token_hash,verification_expires_at,email_verified_at,status,
       request_ip_hash,request_user_agent_hash,password_hash,mfa_secret_encrypted,billing_path,purchase_kind,booking_id,consent_version,consented_at)
      VALUES($1,$2,$3,NULL,NULL,$4,'PAYMENT_PENDING',$5,$6,NULL,NULL,'AUTO_CARD','TRIAL',$7,$8,$4)`,[
        tenantId,intent.email,contract.dbPlan,now,intent.request_ip_hash,intent.request_user_agent_hash,
        intent.booking_id,BOOKING_TERMS_VERSION
      ]);
    await client.query("INSERT INTO saas.subscriptions(tenant_id,plan_code,status) VALUES($1,$2,'PENDING_PAYMENT')",[tenantId,contract.dbPlan]);
    await client.query(`UPDATE saas.trial_onboarding_intents
      SET tenant_id=$2,email_verified_at=$3,status='EMAIL_VERIFIED',verification_token_hash=NULL,updated_at=$3
      WHERE id=$1`,[intent.id,tenantId,now]);
    await client.query('COMMIT');
    intent={...intent,tenant_id:tenantId};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();}

  const checkout=await createBoundCheckout(pool,billingAdapter,intent.tenant_id,contract,intent.booking_id);
  await pool.query(`UPDATE saas.trial_onboarding_intents
    SET checkout_provider=$2,checkout_ref=$3,status='CHECKOUT_CREATED',updated_at=now()
    WHERE id=$1 AND tenant_id=$4 AND status='EMAIL_VERIFIED'`,[intent.id,billingAdapter.provider,checkout.id,intent.tenant_id]);
  return {checkoutUrl:checkout.url,tenantId:intent.tenant_id};
}

export async function markEmailFirstPaymentPendingSetup(client,tenantId,checkoutRef,now=new Date()){
  const result=await client.query(`UPDATE saas.trial_onboarding_intents
    SET status='ACCOUNT_SETUP_PENDING',payment_confirmed_at=coalesce(payment_confirmed_at,$3),updated_at=$3
    WHERE tenant_id=$1 AND checkout_ref=$2
      AND status IN('CHECKOUT_CREATED','ACCOUNT_SETUP_PENDING')
    RETURNING id`,[tenantId,checkoutRef,now]);
  if(!result.rowCount)return false;
  // pending_registrations deliberately stays PAYMENT_PENDING here. Its production
  // CHECK constraint has no account/MFA setup states. IAM_PROVISIONING_PENDING is
  // entered only after payment, password and MFA have all been verified.
  return true;
}

export async function beginPaidAccountSetup(pool,{sessionId,company,password,passwordConfirmation,verificationPepper,fieldEncryptionKey,now=new Date()}){
  if(!CHECKOUT.test(String(sessionId||'')))fail('checkout_session_invalid');
  company=String(company||'').trim().slice(0,160);
  if(company.length<2)fail('company_name_invalid');
  password=String(password||'');
  if(password.length<12||password.length>128||password!==String(passwordConfirmation||''))fail('password_invalid');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const row=(await client.query(`SELECT i.*,c.status checkout_status,p.iam_provisioned_at,p.status pending_status
      FROM saas.trial_onboarding_intents i
      JOIN saas.checkout_sessions c ON c.tenant_id=i.tenant_id AND c.provider_checkout_ref=i.checkout_ref
      JOIN saas.pending_registrations p ON p.tenant_id=i.tenant_id
      WHERE i.checkout_ref=$1 FOR UPDATE OF i,p`,[sessionId])).rows[0];
    if(!row||row.checkout_status!=='PAYMENT_CONFIRMED'||!row.payment_confirmed_at)fail('payment_not_confirmed',409);
    if(row.iam_provisioned_at||row.status==='ACTIVATED')fail('account_already_activated',409);
    if(!['ACCOUNT_SETUP_PENDING','MFA_SETUP_PENDING'].includes(row.status))fail('onboarding_state_invalid',409);
    if(row.pending_status!=='PAYMENT_PENDING')fail('pending_registration_state_invalid',409);

    const mfaSecret=randomTotpSecret();
    const setupToken=verificationToken();
    const setupHash=hashVerificationToken(setupToken,verificationPepper);
    await client.query(`UPDATE saas.pending_registrations
      SET password_hash=$2,mfa_secret_encrypted=$3,updated_at=$4
      WHERE tenant_id=$1 AND status='PAYMENT_PENDING'`,[
        row.tenant_id,await hashTenderPassword(password),encryptTotpSecret(mfaSecret,fieldEncryptionKey),now
      ]);
    await client.query('UPDATE saas.tenants SET display_name=$2,updated_at=$3 WHERE id=$1',[row.tenant_id,company,now]);
    await client.query(`UPDATE saas.trial_onboarding_intents
      SET status='MFA_SETUP_PENDING',setup_token_hash=$2,setup_expires_at=$3,updated_at=$4
      WHERE id=$1`,[row.id,setupHash,new Date(now.getTime()+15*60*1000),now]);
    await client.query('COMMIT');

    const issuer=process.env.WB_TENDER_COMMERCIAL_BRAND||'WB Tender';
    const uri=`otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(row.email)}?${new URLSearchParams({secret:mfaSecret,issuer,algorithm:'SHA1',digits:'6',period:'30'})}`;
    return {
      setupToken,
      mfaManualKey:mfaSecret,
      mfaQrCode:await QRCode.toDataURL(uri,{errorCorrectionLevel:'M',margin:2,width:220})
    };
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();}
}

export async function finishPaidAccountSetup(pool,{setupToken,mfaCode,verificationPepper,fieldEncryptionKey,now=new Date()}){
  const setupHash=hashVerificationToken(String(setupToken||''),verificationPepper);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const row=(await client.query(`SELECT i.*,p.password_hash,p.mfa_secret_encrypted,p.iam_provisioned_at,p.status pending_status,
        t.display_name,c.status checkout_status
      FROM saas.trial_onboarding_intents i
      JOIN saas.pending_registrations p ON p.tenant_id=i.tenant_id
      JOIN saas.tenants t ON t.id=i.tenant_id
      JOIN saas.checkout_sessions c ON c.tenant_id=i.tenant_id AND c.provider_checkout_ref=i.checkout_ref
      WHERE i.setup_token_hash=$1 FOR UPDATE OF i,p,t`,[setupHash])).rows[0];
    if(!row||row.status!=='MFA_SETUP_PENDING'||!row.setup_expires_at||new Date(row.setup_expires_at)<=now)fail('setup_token_invalid_or_expired');
    if(row.checkout_status!=='PAYMENT_CONFIRMED'||!row.payment_confirmed_at)fail('payment_not_confirmed',409);
    if(row.iam_provisioned_at)fail('account_already_activated',409);
    if(row.pending_status!=='PAYMENT_PENDING'||!String(row.password_hash||'').startsWith('scrypt$'))fail('activation_prerequisites_missing',409);

    const secret=decryptTotpSecret(row.mfa_secret_encrypted,fieldEncryptionKey);
    if(validTotpCounter(secret,String(mfaCode||''),now.getTime())==null)fail('mfa_code_invalid');

    await client.query("SELECT set_config('app.tenant_id',$1,true)",[row.tenant_id]);
    await client.query(`UPDATE saas.pending_registrations
      SET status='IAM_PROVISIONING_PENDING',updated_at=$2
      WHERE tenant_id=$1 AND status='PAYMENT_PENDING'`,[row.tenant_id,now]);
    await client.query('SELECT tenant_portal.provision_empty_tenant($1,$2)',[row.tenant_id,row.display_name]);
    const userId=(await client.query('SELECT saas.provision_pending_native_identity($1) user_id',[row.tenant_id])).rows[0]?.user_id;
    if(!userId)throw new Error('activation_identity_missing');

    await client.query(`INSERT INTO saas.tenant_companies(id,tenant_id,display_name,status)
      SELECT id,id,display_name,'ACTIVE' FROM saas.tenants t WHERE id=$1
      AND NOT EXISTS(SELECT 1 FROM saas.tenant_companies c WHERE c.tenant_id=t.id AND c.id=t.id)`,[row.tenant_id]);
    await client.query("UPDATE saas.tenants SET status='ACTIVE',updated_at=$2 WHERE id=$1",[row.tenant_id,now]);
    await client.query(`UPDATE saas.trial_onboarding_intents
      SET status='ACTIVATED',activated_at=$2,setup_token_hash=NULL,setup_expires_at=NULL,updated_at=$2
      WHERE id=$1`,[row.id,now]);
    await client.query(`INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id,metadata)
      VALUES($1,$2,'EMAIL_FIRST_TRIAL_ACTIVATED','tenant',$1::uuid::text,$3)`,[
        row.tenant_id,userId,{productionAccessGranted:true,mfaVerified:true}
      ]);
    await client.query('COMMIT');
    return {status:'ACTIVATED',loginUrl:'/saas/login'};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();}
}

const startJs=`const f=document.querySelector('form'),s=document.querySelector('#status');f.addEventListener('submit',async e=>{e.preventDefault();const b=f.querySelector('button');b.disabled=true;s.textContent='E-Mail wird geprüft …';try{const r=await fetch('/api/saas/trial/email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:new FormData(f).get('email')})}),j=await r.json();if(!r.ok)throw Error(j.error==='trial_not_eligible'||j.error==='trial_onboarding_already_started'?'Für diese E-Mail ist kein neuer Testzugang verfügbar. Bitte melden Sie sich an oder kontaktieren Sie uns.':j.error||'Anfrage fehlgeschlagen');f.hidden=true;s.textContent='Bitte bestätigen Sie jetzt die E-Mail in Ihrem Postfach.'}catch(x){s.textContent=x.message;b.disabled=false}});`;
const verifyJs=`const s=document.querySelector('#status'),token=location.hash.slice(1);history.replaceState(null,'',location.pathname);if(!token)s.textContent='Bestätigungslink unvollständig.';else(async()=>{s.textContent='E-Mail wird bestätigt und die sichere Zahlung vorbereitet …';const r=await fetch('/api/saas/trial/verify-email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})}),j=await r.json();if(!r.ok){s.textContent=j.error||'Bestätigung fehlgeschlagen';return}location.assign(j.checkoutUrl)})().catch(()=>s.textContent='Bestätigung fehlgeschlagen.');`;
const setupJs=`const f=document.querySelector('#account'),m=document.querySelector('#mfa'),s=document.querySelector('#status'),sid=new URLSearchParams(location.search).get('session_id')||'';let setup='';f.addEventListener('submit',async e=>{e.preventDefault();const b=f.querySelector('button');b.disabled=true;const d=Object.fromEntries(new FormData(f));d.sessionId=sid;const r=await fetch('/api/saas/trial/setup/begin',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(d)}),j=await r.json();if(!r.ok){s.textContent=j.error||'Einrichtung fehlgeschlagen';b.disabled=false;return}setup=j.setupToken;document.querySelector('#qr').src=j.mfaQrCode;document.querySelector('#key').textContent=j.mfaManualKey;f.hidden=true;m.hidden=false;s.textContent='Authenticator scannen und aktuellen sechsstelligen Code eingeben.'});m.addEventListener('submit',async e=>{e.preventDefault();const r=await fetch('/api/saas/trial/setup/finish',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({setupToken:setup,mfaCode:new FormData(m).get('mfaCode')})}),j=await r.json();if(!r.ok){s.textContent=j.error||'MFA-Prüfung fehlgeschlagen';return}s.textContent='Konto aktiviert. Weiter zur Anmeldung …';location.assign(j.loginUrl)});`;

export function registerEmailFirstTrialRoutes(app,{pool,guard,verificationPepper,fieldEncryptionKey,emailAdapter,billingAdapter}){
  app.get('/saas/assets/trial-email-first-start.js',{preHandler:guard},async(_,r)=>r.type('text/javascript').send(startJs));
  app.get('/saas/assets/trial-email-first-verify.js',{preHandler:guard},async(_,r)=>r.type('text/javascript').send(verifyJs));
  app.get('/saas/assets/trial-email-first-setup.js',{preHandler:guard},async(_,r)=>r.type('text/javascript').send(setupJs));
  app.get('/saas/trial/start',{preHandler:guard},async(_,r)=>r.type('text/html').send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>WB Tender testen</title><link rel="stylesheet" href="/saas/assets/commercial.css"><script src="/saas/assets/trial-email-first-start.js" defer></script></head><body><main class="panel"><h1>Testzugang starten</h1><p>Zuerst bestätigen wir nur Ihre geschäftliche E-Mail und prüfen, ob bereits ein Testzugang besteht. Erst danach gelangen Sie zur sicheren Stripe-Zahlung. Konto und MFA richten Sie nach erfolgreicher Zahlung ein.</p><form><label>Geschäftliche E-Mail<input type="email" name="email" required autocomplete="email"></label><button type="submit">E-Mail prüfen und bestätigen</button></form><p id="status" role="status" aria-live="polite"></p></main></body></html>`));
  app.post('/api/saas/trial/email',{preHandler:guard,config:{rateLimit:{max:8,timeWindow:'1 hour'}}},async(req,reply)=>{
    try{
      const created=await beginEmailFirstTrial(pool,{email:req.body?.email,requestIp:req.ip,userAgent:req.headers['user-agent'],verificationPepper});
      if(!emailAdapter?.configured)fail('email_provider_not_configured',503);
      await emailAdapter.sendVerification({email:created.email,token:created.token,tenantId:null,verificationPath:'/saas/trial/verify'});
      return reply.code(202).send({status:'EMAIL_VERIFICATION_PENDING'});
    }catch(error){return reply.code(error.statusCode||400).send({error:error.message});}
  });
  app.get('/saas/trial/verify',{preHandler:guard},async(_,r)=>r.type('text/html').send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>E-Mail bestätigen</title><link rel="stylesheet" href="/saas/assets/commercial.css"><script src="/saas/assets/trial-email-first-verify.js" defer></script></head><body><main class="panel"><h1>E-Mail bestätigen</h1><p id="status" role="status" aria-live="polite">Bestätigung wird geprüft …</p></main></body></html>`));
  app.post('/api/saas/trial/verify-email',{preHandler:guard},async(req,reply)=>{
    try{return {status:'PAYMENT_PENDING',productionAccessGranted:false,...await verifyEmailAndCreateCheckout(pool,{token:req.body?.token,verificationPepper,billingAdapter})};}
    catch(error){return reply.code(error.statusCode||400).send({error:error.message});}
  });
  app.get('/saas/trial/setup',{preHandler:guard},async(_,r)=>r.type('text/html').send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Konto einrichten</title><link rel="stylesheet" href="/saas/assets/commercial.css"><script src="/saas/assets/trial-email-first-setup.js" defer></script></head><body><main class="panel"><h1>Zahlung bestätigt – Konto einrichten</h1><form id="account"><label>Unternehmen<input name="company" required maxlength="160" autocomplete="organization"></label><label>Passwort (mindestens 12 Zeichen)<input type="password" name="password" minlength="12" maxlength="128" required autocomplete="new-password"></label><label>Passwort wiederholen<input type="password" name="passwordConfirmation" minlength="12" maxlength="128" required autocomplete="new-password"></label><button type="submit">Konto vorbereiten</button></form><form id="mfa" hidden><h2>Authenticator einrichten</h2><img id="qr" alt="QR-Code für Authenticator" width="220" height="220"><p>Manueller Schlüssel: <code id="key"></code></p><label>Aktueller Authenticator-Code<input name="mfaCode" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required></label><button type="submit">MFA bestätigen und Konto aktivieren</button></form><p id="status" role="status" aria-live="polite"></p></main></body></html>`));
  app.post('/api/saas/trial/setup/begin',{preHandler:guard},async(req,reply)=>{
    try{return await beginPaidAccountSetup(pool,{...req.body,verificationPepper,fieldEncryptionKey});}
    catch(error){return reply.code(error.statusCode||400).send({error:error.message});}
  });
  app.post('/api/saas/trial/setup/finish',{preHandler:guard},async(req,reply)=>{
    try{return await finishPaidAccountSetup(pool,{...req.body,verificationPepper,fieldEncryptionKey});}
    catch(error){return reply.code(error.statusCode||400).send({error:error.message});}
  });
}
