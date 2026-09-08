import {submissionRuntimePolicy} from './submission-runtime-policy.mjs';
import {assertFrozenDispatch,requireDispatch,dispatchError} from './submission-dispatch-core.mjs';
import {dispatchSource,compareDispatchSource,loadDispatchCredential} from './submission-dispatch-sources.mjs';
import {loadReleasedSubmissionAdapter} from './submission-browser-adapter.mjs';

// One connection owns the session advisory lock for the entire browser operation.
// No replay of a final request is permitted after a durable commit intent.
export async function executeDispatch(claim,{storage,credentialFiles,source=dispatchSource,credentials=loadDispatchCredential,adapterFactory=loadReleasedSubmissionAdapter,operationalGate,heartbeatMs=20000}={}){
 let adapter,timer,heartbeatError,heartbeat=Promise.resolve(),stopped=false,profileHash;
 const fence=async options=>{if(stopped||heartbeatError)throw dispatchError('submission_lease_lost');await claim.fence(options);const hash=await operationalGate(claim.db,claim.row);if(profileHash)requireDispatch(profileHash===hash,'submission_portal_changed');else profileHash=hash;};
 const current=async()=>compareDispatchSource(claim.row,await source(claim.db,{id:claim.row.tenant_id,actorUserId:claim.row.released_by},claim.row,storage));
 try{
  assertFrozenDispatch(claim.row);await fence();
  timer=setInterval(()=>{heartbeat=heartbeat.then(()=>claim.heartbeat()).catch(error=>{heartbeatError=error;adapter?.close().catch(()=>{});});},heartbeatMs);timer.unref?.();
  const frozen=await current();
  const credential=await credentials(claim.db,claim.row,credentialFiles);
  adapter=await adapterFactory(claim.db,claim.row);
  await claim.submitting();
  await claim.evidence('CREDENTIAL_RESOLVED',{credentialId:credential.credentialId,revision:credential.revision});
  await adapter.prepare({credential:credential.secret,documents:frozen.documents,fence,onEvidence:(event,evidence)=>claim.evidence(event,evidence)});
  const receipt=await adapter.submit({beforeCommit:()=>claim.commitIntent(async()=>{await fence();await current();const latest=await credentials(claim.db,claim.row,credentialFiles);requireDispatch(latest.credentialId===credential.credentialId&&latest.revision===credential.revision,'submission_credentials_required');}),fence:()=>fence({allowCommitted:true})});
  clearInterval(timer);await heartbeat;
  return await claim.complete(receipt);
 }catch(error){
  clearInterval(timer);await heartbeat;
  // A response lost after finalization may still have left a verifiable receipt in this page.
  // This method performs only reads; it never clicks or repeats finalization.
  if(claim.row.commit_started_at&&adapter?.reconcileCurrentPage){
   try{const receipt=await adapter.reconcileCurrentPage();return await claim.complete(receipt)}catch{}
  }
  // Closing the browser precedes releasing its database fence.
  await adapter?.close().catch(()=>{});
  return await claim.fail(error);
 }finally{stopped=true;clearInterval(timer);await adapter?.close().catch(()=>{});await claim.close();}
}

export async function productionDispatchGate(db,row,{env=process.env}={}){
 requireDispatch(submissionRuntimePolicy(env).enabled,'submission_gate_disabled');
 const settings=(await db.query('SELECT external_submission_enabled,allow_external_submission,global_kill_switch FROM tender.submission_runtime_settings WHERE singleton')).rows[0];
 requireDispatch(settings?.external_submission_enabled&&settings.allow_external_submission&&!settings.global_kill_switch,'submission_gate_disabled');
 const release=(await db.query('SELECT enabled,validation_status,profile_sha256 FROM tender.submission_adapter_releases WHERE portal_id=$1',[row.portal_id])).rows[0];
 requireDispatch(release?.enabled&&release.validation_status==='PRODUCTION_VALIDATED','submission_adapter_not_validated');
 const company=(await db.query('SELECT kill_switch FROM tender.submission_company_switches WHERE tenant_id=$1 AND company_id=$2',[row.tenant_id,row.company_id])).rows[0];
 requireDispatch(!company?.kill_switch,'submission_gate_disabled');
 return release.profile_sha256;
}

export async function deliverDispatchNotification(pool,email){
 const db=await pool.connect();let notification;
 try{
  notification=(await db.query('SELECT * FROM tender.claim_submission_notification()')).rows[0];if(!notification)return false;
  requireDispatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notification.email)&&!/[\r\n]/.test(notification.email),'submission_notification_recipient_invalid');
  const result=await email.transport.sendMail({from:email.from,to:notification.email,messageId:`<submission-${notification.id}@wb-tender.com>`,subject:'WB-Tender: Status Ihrer freigegebenen Abgabe',text:`Der Status Ihres Abgabevorgangs lautet: ${notification.state}.\nVorgang: ${notification.dispatch_id}\nDetails und erforderliche Schritte finden Sie im WB-Tender-Management-Dashboard.\n${email.verificationBaseUrl}/saas/app/management`});
  requireDispatch(result.accepted?.length>0,'submission_notification_rejected');
  await db.query('SELECT tender.finish_submission_notification($1,$2,true)',[notification.id,notification.token]);return true;
 }catch{if(notification)await db.query('SELECT tender.finish_submission_notification($1,$2,false)',[notification.id,notification.token]).catch(()=>{});return false;}
 finally{db.release();}
}
