import crypto from 'node:crypto';
import {canonicalJson,liveSubmissionHash} from './submission-live-core.mjs';
import {approvedDispatchBinding,dispatchScopeKey,requireDispatch,assertFrozenDispatch,verifyDispatchReceipt,dispatchFailure} from './submission-dispatch-core.mjs';

export async function enqueueApprovedDispatch(db,input){
 const binding=approvedDispatchBinding(input),scope=dispatchScopeKey(binding);
 await db.query("SELECT pg_advisory_xact_lock(hashtextextended('submission-release:'||$1,0))",[scope]);
 const prior=(await db.query('SELECT * FROM tender.submission_dispatches WHERE tenant_id=$1 AND scope_key=$2 FOR UPDATE',[binding.tenantId,scope])).rows[0];
 if(prior){
  const withoutActor=({releasedAt,releasedBy,...rest})=>rest;
  requireDispatch(canonicalJson(withoutActor(prior.binding))===canonicalJson(withoutActor(binding)),'submission_scope_already_reserved');
  await db.query('INSERT INTO tender.submission_duplicate_attempts(tenant_id,dispatch_id,actor_id,request_sha256) VALUES($1,$2,$3,$4)',[binding.tenantId,prior.id,binding.releasedBy,liveSubmissionHash(binding)]);
  return {id:prior.id,status:prior.status,idempotent:true,packageSha256:prior.package_sha256};
 }
 const row=(await db.query(`INSERT INTO tender.submission_dispatches(tenant_id,company_id,tender_id,lot_key,portal_id,origin,source_id,released_by,released_at,deadline_at,package_sha256,binding,binding_json,binding_sha256,scope_key)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,[binding.tenantId,binding.companyId,binding.tenderId,binding.lotKey,binding.portalId,binding.origin,binding.sourceId,binding.releasedBy,binding.releasedAt,binding.deadlineAt,binding.packageSha256,binding,canonicalJson(binding),liveSubmissionHash(binding),scope])).rows[0];
 for(const status of ['READY_FOR_MANAGEMENT','MANAGEMENT_APPROVED_FOR_SUBMISSION','SUBMISSION_QUEUED'])await db.query('UPDATE tender.submission_dispatches SET status=$2,updated_at=now() WHERE id=$1',[row.id,status]);
 return {id:row.id,status:'SUBMISSION_QUEUED',idempotent:false,packageSha256:binding.packageSha256};
}

export class PostgresDispatchStore{
 constructor(pool,{workerId='submission-'+crypto.randomUUID()}={}){this.pool=pool;this.workerId=workerId;}
 async claim(){
  const db=await this.pool.connect();let claim;
  try{
   claim=(await db.query('SELECT * FROM tender.claim_submission_dispatch($1)',[this.workerId])).rows[0];
   if(!claim){db.release();return null;}
   await db.query("SELECT set_config('app.tenant_id',$1,false),set_config('app.actor_user_id','',false)",[claim.tenant_id]);
   const row=(await db.query('SELECT * FROM tender.submission_dispatches WHERE tenant_id=$1 AND id=$2',[claim.tenant_id,claim.dispatch_id])).rows[0];
   requireDispatch(row&&row.lease_token===claim.lease_token,'submission_lease_lost');
   await db.query("SELECT set_config('app.company_ids',$1,false),set_config('app.tenant_ids',$2,false),set_config('app.configuration_tenant_id',$2,false)",[row.company_id,row.tenant_id]);
   return new ClaimedDispatch(db,claim,row);
  }catch(error){if(claim)await db.query('SELECT pg_advisory_unlock($1::bigint)',[claim.lock_key]).catch(()=>{});db.release(true);throw error;}
 }
}
export class ClaimedDispatch{
 constructor(db,lease,row){this.db=db;this.lease=lease;this.row=row;this.released=false;}
 async transaction(fn){
  await this.db.query('BEGIN');try{const value=await fn(this.db);await this.db.query('COMMIT');return value;}catch(error){await this.db.query('ROLLBACK').catch(()=>{});throw error;}
 }
 async fence({allowCommitted=false}={}){
  const row=(await this.db.query('SELECT * FROM tender.submission_dispatches WHERE tenant_id=$1 AND id=$2',[this.lease.tenant_id,this.lease.dispatch_id])).rows[0];
  requireDispatch(row&&row.lease_token===this.lease.lease_token&&Date.parse(row.lease_expires_at)>Date.now(),'submission_lease_lost');
  requireDispatch(Date.parse(row.deadline_at)>Date.now(),'submission_deadline_expired');
  requireDispatch(!row.commit_started_at||allowCommitted,'submission_commit_already_started');
  requireDispatch(['SUBMISSION_QUEUED','RETRY_REQUIRED','SUBMITTING'].includes(row.status),'submission_state_changed');
  assertFrozenDispatch(row);this.row=row;return row;
 }
 async heartbeat(){
  const result=await this.db.query("UPDATE tender.submission_dispatches SET lease_expires_at=now()+interval '90 seconds' WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND status IN('SUBMISSION_QUEUED','RETRY_REQUIRED','SUBMITTING') AND lease_expires_at>now()",[this.lease.tenant_id,this.lease.dispatch_id,this.lease.lease_token]);
  requireDispatch(result.rowCount===1,'submission_lease_lost');
 }
 async submitting(){await this.fence();await this.db.query("UPDATE tender.submission_dispatches SET status='SUBMITTING',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_token=$3",[this.lease.tenant_id,this.lease.dispatch_id,this.lease.lease_token]);this.row.status='SUBMITTING';}
 async commitIntent(validateCurrent){
  await this.transaction(async()=>{
   await this.db.query('SELECT id FROM tender.submission_dispatches WHERE id=$1 FOR UPDATE',[this.row.id]);await this.fence();await validateCurrent(this.db,this.row);
   const result=await this.db.query("UPDATE tender.submission_dispatches SET commit_started_at=clock_timestamp(),updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND status='SUBMITTING' AND commit_started_at IS NULL AND deadline_at>clock_timestamp() RETURNING commit_started_at",[this.lease.tenant_id,this.row.id,this.lease.lease_token]);
   requireDispatch(result.rowCount===1,'submission_commit_not_permitted');this.row.commit_started_at=result.rows[0].commit_started_at;
  });
 }
 async evidence(event,evidence){await this.db.query('SELECT tender.record_submission_operation($1,$2,$3,$4)',[this.row.id,this.lease.lease_token,event,evidence]);}
 async complete(result){
  const receipt=verifyDispatchReceipt(assertFrozenDispatch(this.row),result);
  await this.transaction(async()=>{
   await this.db.query('SELECT id FROM tender.submission_dispatches WHERE id=$1 FOR UPDATE',[this.row.id]);
   const current=(await this.db.query('SELECT * FROM tender.submission_dispatches WHERE id=$1',[this.row.id])).rows[0];
   requireDispatch(current.lease_token===this.lease.lease_token&&current.commit_started_at,'submission_receipt_lease_lost');
   await this.db.query(`INSERT INTO tender.submission_dispatch_receipts(dispatch_id,tenant_id,portal_reference,submitted_at,media_type,receipt_bytes,receipt_sha256,package_sha256,documents,binding_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[this.row.id,this.row.tenant_id,receipt.reference,receipt.submittedAt,receipt.mediaType,receipt.bytes,receipt.sha256,this.row.package_sha256,JSON.stringify(receipt.documents),this.row.binding_sha256]);
   await this.db.query("UPDATE tender.submission_dispatches SET status='SUBMITTED',last_error=NULL,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",[this.row.id]);
  });
  this.row.status='SUBMITTED';return {status:'SUBMITTED',receiptSha256:receipt.sha256};
 }
 async fail(error){
  const result=dispatchFailure(error,{commitStarted:Boolean(this.row.commit_started_at),deadlineAt:this.row.deadline_at,attempt:this.row.attempt});
  // The error text is never stored; result.code is a bounded allowlisted code.
  await this.db.query('UPDATE tender.submission_dispatches SET status=$4,last_error=$5,next_attempt_at=coalesce($6::timestamptz,next_attempt_at),lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_token=$3',[this.row.tenant_id,this.row.id,this.lease.lease_token,result.status,result.code,result.retryAt||null]);
  return result;
 }
 async close(){
  if(this.released)return;this.released=true;
  try{await this.db.query('SELECT pg_advisory_unlock($1::bigint)',[this.lease.lock_key]);await this.db.query("RESET app.tenant_id; RESET app.actor_user_id; RESET app.company_ids; RESET app.tenant_ids; RESET app.configuration_tenant_id");this.db.release();}
  catch{this.db.release(true);}
 }
}
