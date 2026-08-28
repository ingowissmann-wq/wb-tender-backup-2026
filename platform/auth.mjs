import crypto from "node:crypto";

export const TENDER_PERMISSIONS = Object.freeze([
  "tender.view","tender.view_assigned","tender.edit","tender.evaluate","tender.assign",
  "tender.favorite","tender.deadline.manage","tender.task.manage","tender.note.manage",
  "tender.document.view","tender.document.upload","tender.export","tender.source.view",
  "tender.source.manage","tender.import.execute","tender.connector.view",
  "tender.connector.manage","tender.deadletter.view","tender.deadletter.process","tender.admin",
  "tender.import","tender.match.manage","tender.profile.manage","tender.region.manage",
  "tender.score.manage","tender.override","tender.document.analyze",
  "tender.requirement.manage","tender.calculation.create","tender.calculation.edit",
  "tender.price.approve","tender.offer.generate","tender.offer.approve",
  "tender.portal.manage","tender.secret.manage","tender.question.prepare",
  "tender.question.approve","tender.upload.prepare","tender.upload.approve",
  "tender.submission.prepare","tender.submission.approve","tender.submission.execute",
  "tender.submission.audit","tender.submission.kill_switch","tender.board.approve",
  "tender.log.view","tender.audit.view","tender.config.read","tender.config.draft.edit",
  "tender.config.services.edit","tender.config.regions.edit","tender.config.evidence.edit",
  "tender.config.costs.edit","tender.config.preview","tender.config.submit","tender.config.approve",
  "tender.config.activate","tender.config.rollback","tender.config.audit.read",
  "tender.config.self_approve_activate"
]);

export function hashSession(token, pepper) {
  if (!token || !pepper || pepper.length < 32) throw new Error("invalid_session_material");
  return crypto.createHmac("sha256", pepper).update(token).digest("hex");
}

export async function loadIdentity(pool, token, pepper) {
  if (!token) return null;
  const result = await pool.query(`
    SELECT s.id_hash,s.csrf_hash,s.user_id,s.mfa_verified_at,u.email,
      array_remove(array_agg(DISTINCT p.code),NULL) permissions,
      array_remove(array_agg(DISTINCT r.code),NULL) roles
    FROM iam.sessions s
    JOIN iam.users u ON u.id=s.user_id
    LEFT JOIN iam.user_roles ur ON ur.user_id=u.id
    LEFT JOIN iam.roles r ON r.id=ur.role_id
    LEFT JOIN iam.role_permissions rp ON rp.role_id=ur.role_id
    LEFT JOIN iam.permissions p ON p.id=rp.permission_id
    WHERE s.id_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active=true
    GROUP BY s.id_hash,s.csrf_hash,s.user_id,s.mfa_verified_at,u.email
  `,[hashSession(token,pepper)]);
  if (!result.rowCount || !result.rows[0].mfa_verified_at) return null;
  const scopes=await pool.query(`
    SELECT scope_type,scope_id
    FROM iam.tender_identity_scopes
    WHERE user_id=$1 AND active=true
  `,[result.rows[0].user_id]);
  const companyIds=scopes.rows.filter((row)=>row.scope_type==="company").map((row)=>row.scope_id);
  const companySectors=companyIds.length?(await pool.query(`
    SELECT DISTINCT sector_slug
    FROM tender.enterprise_company_links
    WHERE company_id=ANY($1::uuid[]) AND sector_slug IS NOT NULL
  `,[companyIds])).rows.map((row)=>row.sector_slug):[];
  return {
    userId: result.rows[0].user_id,
    email: result.rows[0].email,
    csrfHash: result.rows[0].csrf_hash,
    permissions: result.rows[0].permissions || [],
    roles: result.rows[0].roles || [],
    sectorIds: scopes.rows.filter((row)=>row.scope_type==="sector").map((row)=>row.scope_id),
    sectorSlugs: companySectors,
    companyIds
  };
}

export function mayView(identity, tender) {
  if (identity.permissions.includes("tender.admin") || identity.permissions.includes("tender.view")) return true;
  if (!identity.permissions.includes("tender.view_assigned")) return false;
  return Boolean(tender.assigned_user_id === identity.userId ||
    (tender.sector_id && identity.sectorIds.includes(tender.sector_id)) ||
    (tender.company_id && identity.companyIds.includes(tender.company_id)));
}
