export async function enqueueVerifiedSessionFanout(pool,sessionId,{client:providedClient=null}={}){
  const client=providedClient||await pool.connect(),ownsTransaction=!providedClient;
  try{
    if(ownsTransaction)await client.query("BEGIN");
    const session=(await client.query(`SELECT session.* FROM tender.portal_read_sessions session
      JOIN tender.portal_credential_secrets credential ON credential.id=session.credential_id
        AND credential.portal_id=session.portal_id AND credential.status='ACTIVE'
        AND (credential.valid_until IS NULL OR credential.valid_until>now())
      JOIN tender.portal_credential_companies binding ON binding.credential_id=credential.id
        AND binding.company_id=session.company_id AND binding.active=true
      WHERE session.id=$1
        AND tender.portal_session_effective_status(session.status,session.expires_at,session.revoked_at,session.verification_status)='ACTIVE'
        AND coalesce(session.cookie_count,0)>0 FOR UPDATE OF session`,[sessionId])).rows[0];
    if(!session){if(ownsTransaction)await client.query("ROLLBACK");return []}
    await client.query(`WITH affected_contexts AS(
      SELECT DISTINCT ON(relevance.tender_id,relevance.company_id,coalesce(relevance.lot_key,''))
        relevance.tender_id,relevance.company_id,coalesce(relevance.lot_key,'') lot_key,
        relevance.service_line service_scope,relevance.evaluation_version assessment_version_id,
        tender_version.id tender_version_id,enrichment.id enrichment_version_id,tender.notice_number notice_id
      FROM tender.current_service_relevance relevance
      JOIN tender.tenders tender ON tender.id=relevance.tender_id AND tender.data_class='PUBLIC_REAL'
        AND tender.source_lifecycle_status='ACTIVE' AND tender.participation_status IN('ELIGIBLE','PARTIALLY_ELIGIBLE')
        AND EXISTS(SELECT 1 FROM tender.current_participation_eligible_lots eligible WHERE eligible.tender_id=tender.id AND eligible.lot_key=coalesce(relevance.lot_key,''))
      JOIN LATERAL(SELECT version.id FROM tender.tender_versions version WHERE version.tender_id=tender.id ORDER BY version.version DESC LIMIT 1)tender_version ON true
      JOIN LATERAL(SELECT version.id FROM tender.enrichment_versions version WHERE version.tender_id=tender.id AND version.historical=false ORDER BY version.version DESC LIMIT 1)enrichment ON true
      WHERE relevance.company_id=$2 AND relevance.relevance_status='RELEVANT' AND relevance.service_scope_gate='PASSED'
        AND EXISTS(SELECT 1 FROM tender.current_registered_tender_company_portals registered
          WHERE registered.tender_id=relevance.tender_id
            AND registered.company_id=relevance.company_id
            AND registered.portal_id=$3
            AND registered.credential_id=$4)
        AND EXISTS(SELECT 1 FROM tender.enrichment_documents document
          LEFT JOIN tender.enrichment_lots document_lot ON document_lot.id=document.lot_id
          JOIN tender.portal_registry portal ON portal.id=$3
          WHERE document.enrichment_version_id=enrichment.id AND (
            document.provenance->>'portalId'=$3::text
            OR lower(coalesce(document.provenance->>'targetPortal',''))=portal.canonical_domain
            OR lower(coalesce(document.provenance->>'targetPortal',''))=ANY(portal.allowed_subdomains)
            OR lower(split_part(split_part(document.source_url,'://',2),'/',1))=portal.canonical_domain
            OR lower(split_part(split_part(document.source_url,'://',2),'/',1))=ANY(portal.allowed_subdomains)
            OR lower(split_part(split_part(document.source_url,'://',2),'/',1))=ANY(portal.authentication_domains)
            OR lower(split_part(split_part(document.source_url,'://',2),'/',1))=ANY(portal.download_domains))
          AND (document.lot_id IS NULL OR document_lot.lot_key=coalesce(relevance.lot_key,'')))
      ORDER BY relevance.tender_id,relevance.company_id,coalesce(relevance.lot_key,''),relevance.evaluation_version DESC
    ), dispatches AS(
      INSERT INTO tender.portal_session_context_dispatches(session_id,tender_id,company_id,lot_key,portal_id,credential_id)
      SELECT $1,context.tender_id,context.company_id,context.lot_key,$3,$4 FROM affected_contexts context
      ON CONFLICT(session_id,tender_id,company_id,lot_key,portal_id,credential_id)
        DO UPDATE SET session_id=excluded.session_id RETURNING *
    ), jobs AS(
      INSERT INTO tender.autopilot_queue(request_id,action_type,tender_id,tender_version_id,notice_id,lot_key,company_id,service_scope,portal_id,credential_id,enrichment_version_id,assessment_version_id,idempotency_key,reason,status,current_step,next_step,next_attempt_at)
      SELECT gen_random_uuid(),'RUN_FULL_PIPELINE',context.tender_id,context.tender_version_id,context.notice_id,
        nullif(context.lot_key,''),context.company_id,context.service_scope,$3,$4,context.enrichment_version_id,
        context.assessment_version_id,'VERIFIED_SESSION_FANOUT:'||$1||':'||context.tender_id||':'||context.company_id||':'||coalesce(nullif(context.lot_key,''),'_tender'),
        'Verifizierte, exakt gebundene Portalsitzung erkannt; Dokumentworkflow kontextisoliert fortsetzen.',
        'QUEUED','DOWNLOAD_LINK_RESOLUTION','DOCUMENT_DOWNLOAD',now()
      FROM dispatches dispatch JOIN affected_contexts context ON context.tender_id=dispatch.tender_id
        AND context.company_id=dispatch.company_id AND context.lot_key=dispatch.lot_key
      WHERE dispatch.job_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM tender.autopilot_queue active_job
          WHERE active_job.action_type='RUN_FULL_PIPELINE'
            AND active_job.tender_id=context.tender_id
            AND active_job.company_id=context.company_id
            AND coalesce(active_job.lot_key,'')=context.lot_key
            AND active_job.portal_id=$3 AND active_job.credential_id=$4
            AND active_job.enrichment_version_id=context.enrichment_version_id
            AND active_job.status IN('PENDING','CLAIMED','RETRY','QUEUED','RUNNING'))
      ON CONFLICT(idempotency_key) WHERE status IN('PENDING','CLAIMED','RETRY','QUEUED','RUNNING')
        DO UPDATE SET idempotency_key=excluded.idempotency_key RETURNING id,idempotency_key
    ) UPDATE tender.portal_session_context_dispatches dispatch
      SET job_id=job.id,dispatch_status='QUEUED',queued_at=coalesce(dispatch.queued_at,now()) FROM jobs job
      WHERE dispatch.session_id=$1 AND job.idempotency_key='VERIFIED_SESSION_FANOUT:'||$1||':'||dispatch.tender_id||':'||dispatch.company_id||':'||coalesce(nullif(dispatch.lot_key,''),'_tender')`,[session.id,session.company_id,session.portal_id,session.credential_id]);
    await client.query(`UPDATE tender.portal_session_context_dispatches dispatch
      SET job_id=job.id,dispatch_status='QUEUED',queued_at=coalesce(dispatch.queued_at,now())
      FROM tender.autopilot_queue job WHERE dispatch.session_id=$1
        AND job.idempotency_key='VERIFIED_SESSION_FANOUT:'||$1||':'||dispatch.tender_id||':'||dispatch.company_id||':'||coalesce(nullif(dispatch.lot_key,''),'_tender')`,[session.id]);
    await client.query(`WITH existing AS(
      SELECT DISTINCT ON(dispatch.id) dispatch.id dispatch_id,job.id job_id
      FROM tender.portal_session_context_dispatches dispatch
      JOIN tender.autopilot_queue job ON job.action_type='RUN_FULL_PIPELINE'
        AND job.tender_id=dispatch.tender_id AND job.company_id=dispatch.company_id
        AND coalesce(job.lot_key,'')=dispatch.lot_key
        AND job.portal_id=dispatch.portal_id AND job.credential_id=dispatch.credential_id
        AND job.status IN('PENDING','CLAIMED','RETRY','QUEUED','RUNNING')
      WHERE dispatch.session_id=$1 AND dispatch.job_id IS NULL
      ORDER BY dispatch.id,job.created_at DESC,job.id DESC
    ) UPDATE tender.portal_session_context_dispatches dispatch
      SET job_id=existing.job_id,dispatch_status='QUEUED',queued_at=coalesce(dispatch.queued_at,now())
      FROM existing WHERE dispatch.id=existing.dispatch_id`,[session.id]);
    await client.query(`UPDATE tender.portal_login_continuations continuation SET status='LOGIN_SUCCESSFUL',job_id=dispatch.job_id,completed_at=coalesce(continuation.completed_at,now())
      FROM tender.portal_session_context_dispatches dispatch WHERE dispatch.session_id=$1 AND dispatch.job_id IS NOT NULL
        AND continuation.portal_id=$2 AND continuation.credential_id=$3 AND continuation.company_id=$4
        AND continuation.tender_id=dispatch.tender_id AND coalesce(continuation.lot_key,'')=dispatch.lot_key
        AND continuation.status IN('LOGIN_STARTED','WAITING_FOR_USER','MFA_REQUIRED','SESSION_EXPIRED')`,[session.id,session.portal_id,session.credential_id,session.company_id]);
    const rows=(await client.query("SELECT * FROM tender.portal_session_context_dispatches WHERE session_id=$1 ORDER BY tender_id,lot_key",[session.id])).rows;
    if(ownsTransaction)await client.query("COMMIT");return rows;
  }catch(error){if(ownsTransaction)await client.query("ROLLBACK");throw error}finally{if(ownsTransaction)client.release()}
}
