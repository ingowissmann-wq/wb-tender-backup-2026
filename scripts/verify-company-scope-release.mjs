import fs from "node:fs";
import pg from "pg";

const connectionString = process.env.DATABASE_URL || fs.readFileSync(
  process.env.DATABASE_URL_FILE || "/run/secrets/database_url",
  "utf8",
).trim();
const pool = new pg.Pool({ connectionString, max: 1 });

const scalar = async (sql) => Number((await pool.query(sql)).rows[0].count);
try {
  const checks = {
    activeSessionsWithoutCompany: await scalar(`SELECT count(*) FROM tender.portal_read_sessions WHERE status='ACTIVE' AND company_id IS NULL`),
    invalidSessionBindings: await scalar(`SELECT count(*) FROM tender.portal_read_sessions session LEFT JOIN tender.portal_credential_secrets credential ON credential.id=session.credential_id LEFT JOIN tender.portal_credential_companies scope ON scope.credential_id=session.credential_id AND scope.company_id=session.company_id WHERE session.status='ACTIVE' AND (credential.portal_id IS DISTINCT FROM session.portal_id OR scope.company_id IS NULL)`),
    liveContinuationsWithoutCompany: await scalar(`SELECT count(*) FROM tender.portal_login_continuations WHERE status IN('LOGIN_STARTED','WAITING_FOR_USER','MFA_REQUIRED','LOGIN_SUCCESSFUL') AND company_id IS NULL`),
    invalidContinuationBindings: await scalar(`SELECT count(*) FROM tender.portal_login_continuations continuation LEFT JOIN tender.portal_credential_secrets credential ON credential.id=continuation.credential_id LEFT JOIN tender.portal_credential_companies scope ON scope.credential_id=continuation.credential_id AND scope.company_id=continuation.company_id WHERE continuation.status IN('LOGIN_STARTED','WAITING_FOR_USER','MFA_REQUIRED','LOGIN_SUCCESSFUL') AND (credential.portal_id IS DISTINCT FROM continuation.portal_id OR scope.company_id IS NULL)`),
    invalidContinuationLots: await scalar(`SELECT count(*) FROM tender.portal_login_continuations continuation WHERE coalesce(continuation.lot_key,'')<>'' AND NOT EXISTS(SELECT 1 FROM tender.lots lot WHERE lot.tender_id=continuation.tender_id AND lot.external_id=continuation.lot_key UNION ALL SELECT 1 FROM tender.enrichment_lots lot JOIN tender.enrichment_versions version ON version.id=lot.enrichment_version_id WHERE version.tender_id=continuation.tender_id AND lot.lot_key=continuation.lot_key)`),
    crossVersionDocumentLots: await scalar(`SELECT count(*) FROM tender.enrichment_documents document JOIN tender.enrichment_lots lot ON lot.id=document.lot_id WHERE lot.enrichment_version_id<>document.enrichment_version_id`),
    duplicateEnrichmentLots: await scalar(`SELECT count(*) FROM (SELECT enrichment_version_id,lot_key FROM tender.enrichment_lots GROUP BY enrichment_version_id,lot_key HAVING count(*)>1) duplicate`),
    impossibleConfiguredCapabilities: await scalar(`SELECT count(*) FROM tender.portal_capability_features WHERE actively_configured AND NOT autopilot_supported`),
    impossibleProductionCapabilities: await scalar(`SELECT count(*) FROM tender.portal_capability_features WHERE production_tested AND NOT autopilot_supported`),
    impossibleBrowserCapabilities: await scalar(`SELECT count(*) FROM tender.portal_capability_features WHERE browser_acceptance_passed AND (NOT autopilot_supported OR NOT production_tested)`),
    staleSuccessErrors: await scalar(`SELECT count(*) FROM tender.autopilot_queue WHERE status IN('SUCCEEDED','DONE') AND error_code IS NULL AND (safe_error_code IS NOT NULL OR error_detail_safe IS NOT NULL)`),
  };
  const deutscheEvergabe = (
    await pool.query(`SELECT feature.feature_key,feature.portal_support,feature.autopilot_supported,feature.actively_configured,feature.production_tested,feature.browser_acceptance_passed FROM tender.portal_capability_features feature JOIN tender.portal_capability_profiles profile ON profile.id=feature.profile_id JOIN tender.portal_registry portal ON portal.id=profile.portal_id WHERE portal.adapter_id='deutsche-evergabe' ORDER BY feature.feature_key`)
  ).rows;
  const failed = Object.entries(checks).filter(([, count]) => count !== 0);
  const result = {
    passed: failed.length === 0,
    checks,
    deutscheEvergabe,
    externalSubmissionEnabled: false,
    transmitted: false,
  };
  console.log(JSON.stringify(result, null, 2));
  if (failed.length) process.exitCode = 1;
} finally {
  await pool.end();
}
