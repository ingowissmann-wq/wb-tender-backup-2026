import { runReconciliationJob } from "./submission-orchestrator.mjs";

const safeText=value=>String(value||"Unbekannter lesender Portalfehler")
  .replace(/(?:password|token|cookie|authorization|secret)\s*[:=]\s*\S+/gi,"[MASKED]")
  .replace(/[\u0000-\u001f\u007f]+/g," ").replace(/\s+/g," ").trim().slice(0,240);

export async function releaseExpiredReconciliationLeases(pool,{now=new Date()}={}){
  const result=await pool.query(`UPDATE tender.submission_reconciliation_jobs
    SET status=CASE WHEN attempt>=max_attempts THEN 'DEAD_LETTER' ELSE 'RETRY_WAIT' END,
        lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=$1,updated_at=$1,
        last_error_class='WORKER_LEASE_EXPIRED',last_error_safe='Der lesende Worker hat seine Lease nicht rechtzeitig erneuert.'
    WHERE status='RUNNING' AND lease_expires_at<=$1`,[now]);
  return Number(result.rowCount||0);
}

export async function claimReconciliationJob(pool,{workerId,now=new Date(),leaseMs=60_000}={}){
  if(!workerId||String(workerId).length>120)throw Object.assign(new Error("RECONCILIATION_WORKER_ID_INVALID"),{code:"RECONCILIATION_WORKER_ID_INVALID"});
  if(!Number.isSafeInteger(leaseMs)||leaseMs<5_000||leaseMs>300_000)throw Object.assign(new Error("RECONCILIATION_LEASE_INVALID"),{code:"RECONCILIATION_LEASE_INVALID"});
  const leaseExpiresAt=new Date(now.getTime()+leaseMs);
  const result=await pool.query(`WITH candidate AS (
      SELECT job.id,context.tender_id,context.company_id,context.lot_key,context.portal_id,context.credential_id,tender.offer_deadline
      FROM tender.submission_reconciliation_jobs job
      JOIN tender.submission_contexts context ON context.id=job.submission_context_id
      JOIN tender.tenders tender ON tender.id=context.tender_id
      WHERE job.status IN('QUEUED','RETRY_WAIT') AND job.next_attempt_at<=$1 AND job.attempt<job.max_attempts
      ORDER BY job.next_attempt_at,job.created_at FOR UPDATE OF job SKIP LOCKED LIMIT 1
    )
    UPDATE tender.submission_reconciliation_jobs job
    SET status='RUNNING',attempt=job.attempt+1,lease_owner=$2,lease_expires_at=$3,updated_at=$1
    FROM candidate WHERE job.id=candidate.id
    RETURNING job.id,job.submission_context_id,job.job_kind,job.attempt,job.max_attempts,job.lease_owner,job.lease_expires_at,
      candidate.tender_id,candidate.company_id,candidate.lot_key,candidate.portal_id,candidate.credential_id,candidate.offer_deadline`,[now,String(workerId),leaseExpiresAt]);
  if(!result.rows[0])return null;
  const job=result.rows[0];
  return {...job,jobKind:job.job_kind,maxAttempts:Number(job.max_attempts),attempt:Number(job.attempt),deadline:job.offer_deadline,scope:{tenderId:job.tender_id,companyId:job.company_id,lotKey:job.lot_key,portalId:job.portal_id,credentialId:job.credential_id}};
}

export async function persistReconciliationResult(pool,job,result,{now=new Date()}={}){
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const owned=(await client.query(`SELECT id FROM tender.submission_reconciliation_jobs
      WHERE id=$1 AND status='RUNNING' AND lease_owner=$2 FOR UPDATE`,[job.id,job.lease_owner])).rows[0];
    if(!owned)throw Object.assign(new Error("RECONCILIATION_LEASE_LOST"),{code:"RECONCILIATION_LEASE_LOST"});
    let inserted=0;
    for(const event of result.events||[]){
      const expected=job.scope||{},actual=event.scope||{};
      if(event.externalWrite===true||event.transmitted===true||["tenderId","companyId","lotKey","portalId","credentialId"].some(key=>(expected[key]??null)!==(actual[key]??null)))throw Object.assign(new Error("RECONCILIATION_EVENT_SCOPE_MISMATCH"),{code:"SCOPE_MISMATCH"});
      const saved=await client.query(`INSERT INTO tender.portal_inbound_events(
        submission_context_id,tender_id,company_id,lot_key,portal_id,credential_id,event_type,external_event_id,source_mode,payload,event_sha256,idempotency_key,observed_at,received_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'READ_ONLY_POLL',$9::jsonb,$10,$11,$12,$13)
      ON CONFLICT(idempotency_key) DO NOTHING`,[job.submission_context_id,event.scope.tenderId,event.scope.companyId,event.scope.lotKey,event.scope.portalId,event.scope.credentialId,event.type,event.externalEventId,JSON.stringify(event.payload),event.eventSha256,event.idempotencyKey,event.observedAt,event.receivedAt]);
      inserted+=Number(saved.rowCount||0);
    }
    if(result.status==="SUCCEEDED")await client.query(`UPDATE tender.submission_reconciliation_jobs SET status='SUCCEEDED',lease_owner=NULL,lease_expires_at=NULL,last_error_class=NULL,last_error_safe=NULL,updated_at=$2 WHERE id=$1`,[job.id,now]);
    else await client.query(`UPDATE tender.submission_reconciliation_jobs SET status=$2,lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=coalesce($3,next_attempt_at),last_error_class=$4,last_error_safe=$5,updated_at=$6 WHERE id=$1`,[job.id,result.status,result.retry?.retryAt||null,result.errorClass,safeText(result.errorMessage||result.errorClass),now]);
    await client.query("COMMIT");
    return {jobId:job.id,status:result.status,observed:Number((result.events||[]).length),inserted,duplicates:Number((result.events||[]).length)-inserted,externalWrite:false,transmitted:false};
  }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
}

export async function processReconciliationJob(pool,job,{poll,now=()=>new Date()}={}){
  const result=await runReconciliationJob(job,{poll,now});
  return persistReconciliationResult(pool,job,{...result,errorMessage:result.errorClass},{now:now()});
}
