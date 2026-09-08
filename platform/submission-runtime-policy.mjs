export function submissionRuntimePolicy(env=process.env){
 const enabled=env.EXTERNAL_SUBMISSION_ENABLED,allowed=env.WB_TENDER_ALLOW_EXTERNAL_SUBMISSION;
 if(!['true','false'].includes(enabled)||enabled!==allowed)throw new Error('submission_runtime_configuration_inconsistent');
 if(enabled==='true'&&env.SUBMISSION_EXECUTION_MODE!=='DEDICATED_VALIDATED_WORKER')throw new Error('submission_dedicated_worker_configuration_required');
 return Object.freeze({enabled:enabled==='true',executionMode:enabled==='true'?'DEDICATED_VALIDATED_WORKER':'DISABLED'});
}

export async function assertSubmissionSchema(pool){
 const row=(await pool.query("SELECT to_regclass('tender.submission_dispatches') IS NOT NULL AND to_regclass('tender.submission_dispatch_legal_company_scope') IS NOT NULL AND to_regclass('tender.submission_duplicate_attempts') IS NOT NULL AND to_regclass('tender.submission_credential_recoveries') IS NOT NULL AND to_regprocedure('tender.claim_submission_dispatch(text)') IS NOT NULL ready")).rows[0];
 if(row?.ready!==true)throw new Error('submission_migration_required');
}
