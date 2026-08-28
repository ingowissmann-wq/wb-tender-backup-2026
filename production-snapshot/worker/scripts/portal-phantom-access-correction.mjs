import fs from "node:fs";
import pg from "pg";

const targetCompanies = ["WB-Facilitys GmbH", "WB-Emergency Service GmbH"],
  apply = process.argv.includes("--apply"),
  confirmation = "QUARANTINE_EXACT_FACILITYS_EMERGENCY_PORTAL_MAPPINGS",
  databaseUrlFile = process.env.DATABASE_URL_FILE || "/run/secrets/database_url";
if (apply && process.env.PORTAL_PHANTOM_CORRECTION_CONFIRM !== confirmation)
  throw new Error(`Apply requires PORTAL_PHANTOM_CORRECTION_CONFIRM=${confirmation}`);
const pool = new pg.Pool({ connectionString:fs.readFileSync(databaseUrlFile,"utf8").trim(),max:1,options:"-c statement_timeout=55000" });

const selectTargets = async client => (await client.query(
  `SELECT scope.credential_id,scope.company_id,company.legal_name,credential.portal_id,
          portal.display_name portal_name,portal.canonical_domain,credential.version,
          credential.created_at,credential.created_by
   FROM tender.portal_credential_companies scope
   JOIN tender.portal_credential_secrets credential ON credential.id=scope.credential_id
   JOIN tender.portal_registry portal ON portal.id=credential.portal_id
   JOIN tender.enterprise_company_links company ON company.company_id=scope.company_id
   WHERE scope.active=true AND credential.status='ACTIVE' AND company.legal_name=ANY($1::text[])
   ORDER BY company.legal_name,portal.display_name,credential.version`,[targetCompanies])).rows;

try {
  const client = await pool.connect();
  try {
    if (apply) await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const targets = await selectTargets(client), credentialIds = [...new Set(targets.map(row=>row.credential_id))], companyIds = [...new Set(targets.map(row=>row.company_id))];
    const refs = credentialIds.length ? (await client.query(
      `SELECT
        (SELECT count(*)::int FROM tender.portal_credential_companies scope WHERE scope.active AND scope.credential_id=ANY($1::uuid[]) AND NOT(scope.company_id=ANY($2::uuid[]))) preserved_mappings,
        (SELECT count(*)::int FROM tender.portal_read_sessions session WHERE session.credential_id=ANY($1::uuid[]) AND session.company_id=ANY($2::uuid[]) AND tender.portal_session_effective_status(session.status,session.expires_at,session.revoked_at,session.verification_status)='ACTIVE') active_sessions,
        (SELECT count(*)::int FROM tender.portal_login_continuations continuation WHERE continuation.credential_id=ANY($1::uuid[]) AND continuation.company_id=ANY($2::uuid[]) AND continuation.status IN('LOGIN_STARTED','WAITING_FOR_USER','MFA_REQUIRED','LOGIN_SUCCESSFUL')) active_continuations,
        (SELECT count(*)::int FROM tender.portal_submission_access_grants grant_row WHERE grant_row.credential_id=ANY($1::uuid[]) AND grant_row.company_id=ANY($2::uuid[]) AND grant_row.status='ACTIVE') active_grants,
        (SELECT count(*)::int FROM tender.autopilot_queue job WHERE job.credential_id=ANY($1::uuid[]) AND job.company_id=ANY($2::uuid[]) AND job.status IN('PENDING','QUEUED','CLAIMED','RUNNING','RETRY')) active_jobs`,[credentialIds,companyIds])).rows[0] : {preserved_mappings:0,active_sessions:0,active_continuations:0,active_grants:0,active_jobs:0};
    const report = {mode:apply?"apply":"dry-run",targetCompanies,targetMappings:targets.length,targets:targets.map(row=>({credentialId:row.credential_id,companyId:row.company_id,company:row.legal_name,portalId:row.portal_id,portal:row.portal_name,host:row.canonical_domain,credentialVersion:row.version,createdAt:row.created_at,createdBy:row.created_by})),refs,planned:["deactivate exact company mapping","revoke exact active session","expire exact continuation","revoke exact submission grant","retain credential, encrypted payload, versions and audit history"]};
    if (!apply) {
      console.log(JSON.stringify(report,null,2));
    } else {
    if (targets.length !== 12 || new Set(targets.map(row=>row.legal_name)).size !== 2 || Number(refs.active_jobs)!==0)
      throw new Error(`fail-closed precondition: mappings=${targets.length}, companies=${new Set(targets.map(row=>row.legal_name)).size}, activeJobs=${refs.active_jobs}`);
    await client.query(`UPDATE tender.portal_read_sessions session SET status='REVOKED',revoked_at=coalesce(revoked_at,now()),verification_status='COMPANY_MAPPING_QUARANTINED' WHERE session.credential_id=ANY($1::uuid[]) AND session.company_id=ANY($2::uuid[]) AND tender.portal_session_effective_status(session.status,session.expires_at,session.revoked_at,session.verification_status)='ACTIVE'`,[credentialIds,companyIds]);
    await client.query(`UPDATE tender.portal_login_continuations continuation SET status='SESSION_EXPIRED' WHERE continuation.credential_id=ANY($1::uuid[]) AND continuation.company_id=ANY($2::uuid[]) AND continuation.status IN('LOGIN_STARTED','WAITING_FOR_USER','MFA_REQUIRED','LOGIN_SUCCESSFUL')`,[credentialIds,companyIds]);
    await client.query(`UPDATE tender.portal_submission_access_grants grant_row SET status='REVOKED',revoked_at=coalesce(revoked_at,now()) WHERE grant_row.credential_id=ANY($1::uuid[]) AND grant_row.company_id=ANY($2::uuid[]) AND grant_row.status='ACTIVE'`,[credentialIds,companyIds]);
    for (const row of targets) {
      const changed = await client.query(`UPDATE tender.portal_credential_companies SET active=false,replaced_at=coalesce(replaced_at,now()) WHERE credential_id=$1 AND company_id=$2 AND active=true`,[row.credential_id,row.company_id]);
      if (changed.rowCount!==1) throw new Error("mapping changed concurrently");
      await client.query(`INSERT INTO tender.audit_events(action,metadata) VALUES('PORTAL_CREDENTIAL_COMPANY_MAPPING_QUARANTINED',$1::jsonb)`,[JSON.stringify({credentialId:row.credential_id,portalId:row.portal_id,companyId:row.company_id,reason:"AUTHORITATIVE_USER_CONFIRMATION_NO_ACCESS_EVER_CREATED",correction:"MAPPING_DEACTIVATED_CREDENTIAL_RETAINED",externalWrite:false,transmitted:false})]);
    }
    const remaining = await selectTargets(client);
    if (remaining.length) throw new Error(`postcondition failed: ${remaining.length} target mappings remain`);
    await client.query("COMMIT");
    console.log(JSON.stringify({...report,applied:true,remainingTargetMappings:0},null,2));
    }
  } catch (error) {
    if (apply) await client.query("ROLLBACK").catch(()=>{});
    throw error;
  } finally { client.release(); }
} finally { await pool.end(); }
