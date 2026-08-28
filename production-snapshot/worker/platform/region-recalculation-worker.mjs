import os from "node:os";
import crypto from "node:crypto";
import {runInboxPipeline} from "./inbox-pipeline.mjs";

const workerId=`region-worker:${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;

async function claim(pool){
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const job=(await client.query(`SELECT job.* FROM tender.region_recalculation_jobs job
      JOIN tender.configuration_scopes scope ON scope.tenant_id=job.tenant_id AND scope.company_id=job.company_id
       AND scope.canonical_service=job.canonical_service AND scope.profile_id=job.profile_id
      WHERE (job.status='QUEUED' OR (job.status='RUNNING' AND job.lease_until<now()))
        AND scope.active_region_version_id=job.region_profile_version_id
      ORDER BY job.created_at FOR UPDATE OF job SKIP LOCKED LIMIT 1`)).rows[0];
    if(!job){await client.query("COMMIT");return null}
    const claimed=(await client.query(`UPDATE tender.region_recalculation_jobs SET status='RUNNING',lease_owner=$2,
      lease_until=now()+interval '2 minutes',started_at=coalesce(started_at,now()),updated_at=now(),error_code=NULL
      WHERE id=$1 RETURNING *`,[job.id,workerId])).rows[0];
    await client.query("COMMIT");
    return claimed;
  }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
}

async function tenderIds(pool,job){
  return (await pool.query(`SELECT DISTINCT relevance.tender_id
    FROM tender.service_relevance_evaluations relevance JOIN tender.tenders tender ON tender.id=relevance.tender_id
    WHERE relevance.company_id=$1
      AND (CASE relevance.service_line WHEN 'facility-management' THEN 'facility_management' WHEN 'emergency-services' THEN 'emergency_services' ELSE relevance.service_line END)=$2
      AND relevance.primary_company=true AND relevance.relevance_status='RELEVANT' AND relevance.service_scope_gate='PASSED'
      AND tender.data_class='PUBLIC_REAL' AND tender.source_lifecycle_status='ACTIVE' AND tender.participation_status IN('ELIGIBLE','PARTIALLY_ELIGIBLE')
      AND EXISTS(SELECT 1 FROM tender.current_participation_eligible_lots eligible WHERE eligible.tender_id=tender.id AND (relevance.lot_key IS NULL OR eligible.lot_key=relevance.lot_key))
      AND NOT EXISTS(SELECT 1 FROM tender.service_relevance_evaluations newer WHERE newer.tender_id=relevance.tender_id
        AND newer.company_id=relevance.company_id AND newer.lot_key IS NOT DISTINCT FROM relevance.lot_key
        AND newer.evaluation_version>relevance.evaluation_version)
    ORDER BY relevance.tender_id`,[job.company_id,job.canonical_service])).rows.map(row=>row.tender_id);
}

export async function processRegionRecalculationJob(pool,job,{batchSize=100}={}){
  const ids=await tenderIds(pool,job);
  await pool.query("UPDATE tender.region_recalculation_jobs SET total_count=$2,updated_at=now(),lease_until=now()+interval '2 minutes' WHERE id=$1 AND lease_owner=$3",[job.id,ids.length,workerId]);
  try{
    const result=ids.length?await runInboxPipeline(pool,{
      tenderIds:ids,runKind:"REGION_CONFIGURATION",batchSize,
      scope:{tenantId:job.tenant_id,companyId:job.company_id,canonicalService:job.canonical_service,profileId:job.profile_id},
      onProgress:({processed})=>pool.query("UPDATE tender.region_recalculation_jobs SET processed_count=$2,updated_at=now(),lease_until=now()+interval '2 minutes' WHERE id=$1 AND lease_owner=$3",[job.id,processed,workerId]),
    }):{passed:true,checked:0,regionCreated:0,inboxCreated:0};
    await pool.query(`UPDATE tender.region_recalculation_jobs SET status='SUCCESS',processed_count=total_count,
      lease_owner=NULL,lease_until=NULL,finished_at=now(),updated_at=now() WHERE id=$1 AND lease_owner=$2`,[job.id,workerId]);
    return result;
  }catch(error){
    const leaseBusy=error?.code==="INBOX_PIPELINE_LEASE_HELD";
    await pool.query(`UPDATE tender.region_recalculation_jobs SET status=$2,lease_owner=NULL,lease_until=NULL,
      error_code=$3,finished_at=CASE WHEN $2='FAILED' THEN now() ELSE finished_at END,updated_at=now() WHERE id=$1 AND lease_owner=$4`,
      [job.id,leaseBusy?"QUEUED":"FAILED",String(error?.code||"REGION_RECALCULATION_FAILED").slice(0,80),workerId]);
    if(!leaseBusy)throw error;
    return {passed:false,retry:true,errorCode:error.code};
  }
}

export function startRegionRecalculationWorker(pool,{logger=console,intervalMs=10_000,batchSize=100}={}){
  let stopped=false,running=false;
  const tick=async()=>{
    if(stopped||running)return;
    running=true;
    try{const job=await claim(pool);if(job)await processRegionRecalculationJob(pool,job,{batchSize})}
    catch(error){logger.error?.({errorCode:error?.code||"REGION_RECALCULATION_FAILED"},"region recalculation job failed")}
    finally{running=false}
  };
  const timer=setInterval(tick,Math.max(1_000,Number(intervalMs)||10_000));
  timer.unref?.();
  void tick();
  return {stop(){stopped=true;clearInterval(timer)},tick};
}
