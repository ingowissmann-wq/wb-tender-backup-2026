const notRegistered = Object.freeze({
  error: "registered_portal_scope_not_found",
  message: "Keine Ausschreibungen aus registrierten Portalen vorhanden",
  managePortalAccess: "/admin/ausschreibungen/autopilot/portal-access",
  externalSubmissionEnabled: false,
  transmitted: false,
});

export async function registeredTenderPortalScope(db, { tenderId, companyId, lotKey=null,
  portalRole="SUBMISSION_PORTAL", requireCredential=true }) {
  if (!tenderId || !companyId) return null;
  if (lotKey == null && portalRole === "SUBMISSION_PORTAL") {
    const legacy = await db.query(
      `SELECT scope.tender_id,scope.company_id,scope.portal_id,scope.credential_id,
              portal.display_name portal_name,portal.adapter_id,portal.canonical_domain
         FROM tender.current_registered_tender_company_portals scope
         JOIN tender.portal_registry portal ON portal.id=scope.portal_id
        WHERE scope.tender_id=$1 AND scope.company_id=$2
        LIMIT 2`,
      [tenderId, companyId],
    );
    return legacy.rows.length === 1 ? legacy.rows[0] : null;
  }
  const result = await db.query(
    `SELECT scope.tender_id,scope.company_id,scope.lot_id,scope.source_lot_id,scope.portal_role,
            scope.portal_id,scope.credential_id,scope.tender_version_id,scope.assignment_id,
            portal.display_name portal_name,portal.adapter_id,portal.canonical_domain
       FROM tender.current_tender_company_portal_role_scopes scope
       JOIN tender.portal_registry portal ON portal.id=scope.portal_id
      WHERE scope.tender_id=$1 AND scope.company_id=$2 AND scope.portal_role=$3
        AND ($4::text IS NULL OR scope.source_lot_id=$4)
      LIMIT 2`,
    [tenderId, companyId, portalRole, lotKey],
  );
  return result.rows.length === 1 && (!requireCredential || result.rows[0].credential_id)
    ? result.rows[0]
    : null;
}

export async function requireRegisteredTenderPortalScope(
  db,
  reply,
  { tenderId, companyId, lotKey=null, portalRole="SUBMISSION_PORTAL" },
) {
  const scope = await registeredTenderPortalScope(db, { tenderId, companyId, lotKey, portalRole });
  if (scope) return scope;
  if (lotKey == null && portalRole === "SUBMISSION_PORTAL") {
    reply.code(404).send(notRegistered);
    return null;
  }
  const state=(await db.query(`SELECT count(*)::int assignments,
      count(*) FILTER(WHERE credential_id IS NOT NULL)::int credential_ready
    FROM tender.current_tender_company_portal_role_scopes
    WHERE tender_id=$1 AND company_id=$2 AND portal_role=$3
      AND ($4::text IS NULL OR source_lot_id=$4)`,[tenderId,companyId,portalRole,lotKey])).rows[0];
  const status=Number(state?.assignments||0)===0?"DATA_CONTEXT_REPAIR_REQUIRED":
    Number(state?.credential_ready||0)===0?"ACCOUNT_SETUP_REQUIRED":"DATA_CONTEXT_REPAIR_REQUIRED";
  reply.code(404).send({...notRegistered,status,portalRole,lotKey,
    repairAction:status==="ACCOUNT_SETUP_REQUIRED"?"PORTAL_CREDENTIAL_FOR_EXACT_COMPANY_AND_HOST_CONFIGURE":
      "DOCUMENT_OR_SUBMISSION_PORTAL_FOR_EXACT_COMPANY_TENDER_LOT_CONFIRM"});
  return null;
}

export const registeredPortalScopeNotFound = notRegistered;
