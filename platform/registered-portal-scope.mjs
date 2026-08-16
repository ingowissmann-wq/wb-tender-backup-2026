const notRegistered = Object.freeze({
  error: "registered_portal_scope_not_found",
  message: "Keine Ausschreibungen aus registrierten Portalen vorhanden",
  managePortalAccess: "/admin/ausschreibungen/autopilot/portal-access",
  externalSubmissionEnabled: false,
  transmitted: false,
});

export async function registeredTenderPortalScope(db, { tenderId, companyId }) {
  if (!tenderId || !companyId) return null;
  const result = await db.query(
    `SELECT scope.tender_id,scope.company_id,scope.portal_id,scope.credential_id,
            portal.display_name portal_name,portal.adapter_id,portal.canonical_domain
       FROM tender.current_registered_tender_company_portals scope
       JOIN tender.portal_registry portal ON portal.id=scope.portal_id
      WHERE scope.tender_id=$1 AND scope.company_id=$2
      LIMIT 2`,
    [tenderId, companyId],
  );
  return result.rows.length === 1 ? result.rows[0] : null;
}

export async function requireRegisteredTenderPortalScope(
  db,
  reply,
  { tenderId, companyId },
) {
  const scope = await registeredTenderPortalScope(db, { tenderId, companyId });
  if (scope) return scope;
  reply.code(404).send(notRegistered);
  return null;
}

export const registeredPortalScopeNotFound = notRegistered;
