import { loadTenderLinkEvidence } from "./tender-link-evidence.mjs";
import { tenderCredentialPortalEligibility } from "./portal-credentials.mjs";

export const PORTAL_NAVIGATION_RELEASE = "portal-management-20260827.2-generic-credential-verification";

export const validPortalNavigationUuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || ""),
  );

export const safePortalReturnTo = (
  value,
  uiBase = "/admin/ausschreibungen",
) => {
  const fallback = uiBase;
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//"))
    return fallback;
  try {
    const target = new URL(value, "https://internal.invalid");
    if (target.origin !== "https://internal.invalid") return fallback;
    if (!(target.pathname === uiBase || target.pathname.startsWith(`${uiBase}/`)))
      return fallback;
    const allowed = new Set(["tender", "tenderId", "ausschreibung", "company", "companyId", "lot", "lotId", "view", "service", "serviceLine", "version", "enrichment", "notice", "title", "query", "previous"]);
    if ([...target.searchParams.keys()].some((key) => !allowed.has(key)))
      return fallback;
    return `${target.pathname}${target.search}`;
  } catch {
    return fallback;
  }
};

export const portalNavigationHref = ({
  uiBase = "/admin/ausschreibungen",
  tenderId,
  companyId,
  portalId = null,
  service = null,
  version = null,
  lot = null,
  returnTo = uiBase,
}) => {
  if (!validPortalNavigationUuid(tenderId) || !validPortalNavigationUuid(companyId))
    return null;
  const target = new URL(
    portalId ? `${uiBase}/portalzugaenge/bearbeiten` : `${uiBase}/portalzugaenge`,
    "https://internal.invalid",
  );
  if (portalId) {
    if (!validPortalNavigationUuid(portalId)) return null;
    target.searchParams.set("portalId", portalId);
  }
  target.searchParams.set("companyId", companyId);
  target.searchParams.set("tenderId", tenderId);
  if (service) target.searchParams.set("service", String(service));
  if (version) target.searchParams.set("version", String(version));
  if (lot) target.searchParams.set("lotId", String(lot));
  if (!portalId) target.searchParams.set("mode", "search");
  target.searchParams.set("returnTo", safePortalReturnTo(returnTo, uiBase));
  return `${target.pathname}${target.search}`;
};

const confirmedPortalMappings = async (pool, rows) => {
  const scopes = rows
    .map((row) => ({
      tenderId: String(row.tender_id || row.id || ""),
      companyId: String(row.portal_navigation_company_id || row.company_id || ""),
    }))
    .filter(({ tenderId, companyId }) =>
      validPortalNavigationUuid(tenderId) && validPortalNavigationUuid(companyId));
  if (!scopes.length) return new Map();
  const tenderIds = [...new Set(scopes.map(({ tenderId }) => tenderId))];
  const result = await pool.query(
    `SELECT DISTINCT ON(event.tender_id,event.metadata->>'companyId')
       event.tender_id,event.metadata->>'companyId' company_id,event.metadata->>'portalId' portal_id,
       portal.display_name,portal.canonical_domain,portal.adapter_id,portal.adapter_enabled,
       portal.adapter_validation_status,portal.capabilities
     FROM tender.audit_events event
     JOIN tender.portal_registry portal ON portal.id::text=event.metadata->>'portalId'
     WHERE event.action='tender_portal_mapping_confirmed'
       AND event.tender_id=ANY($1::uuid[])
     ORDER BY event.tender_id,event.metadata->>'companyId',event.id DESC`,
    [tenderIds],
  );
  return new Map(
    result.rows.filter((row)=>tenderCredentialPortalEligibility(row).eligible).map((row) => [
      `${row.tender_id}:${row.company_id}`,
      String(row.portal_id),
    ]),
  );
};

export async function decoratePortalNavigation(
  pool,
  rows,
  { uiBase = "/admin/ausschreibungen", returnTo = uiBase } = {},
) {
  if (!rows.length) return rows;
  const tenderIds = [...new Set(rows.map((row) => row.tender_id || row.id).filter(validPortalNavigationUuid))];
  const [evidence, confirmed] = await Promise.all([
    loadTenderLinkEvidence(pool, tenderIds),
    confirmedPortalMappings(pool, rows),
  ]);
  const detectedIds=[...new Set([...evidence.values()].filter((item)=>item?.portalMapping?.status==="EINDEUTIG_ZUGEORDNET").map((item)=>item.portalMapping.portalId).filter(validPortalNavigationUuid))];
  const eligibleDetected=new Set(detectedIds.length?(await pool.query("SELECT * FROM tender.portal_registry WHERE id=ANY($1::uuid[])",[detectedIds])).rows.filter((portal)=>tenderCredentialPortalEligibility(portal).eligible).map((portal)=>String(portal.id)):[]);

  const resolvedPortals = new Map();
  for (const row of rows) {
    const tenderId = String(row.tender_id || row.id || "");
    const companyId = String(row.portal_navigation_company_id || row.company_id || "");
    const linkEvidence = evidence.get(tenderId);
    const confirmedPortalId = confirmed.get(`${tenderId}:${companyId}`);
    const detectedPortalId =
      linkEvidence?.portalMapping?.status === "EINDEUTIG_ZUGEORDNET" &&
      eligibleDetected.has(String(linkEvidence.portalMapping.portalId))
        ? String(linkEvidence.portalMapping.portalId)
        : null;
    const portalId = confirmedPortalId || detectedPortalId || null;
    if (portalId && validPortalNavigationUuid(companyId))
      resolvedPortals.set(`${tenderId}:${companyId}`, String(portalId));
  }

  const portalIds = [...new Set(resolvedPortals.values())];
  const companyIds = [...new Set(
    rows
      .map((row) => String(row.portal_navigation_company_id || row.company_id || ""))
      .filter(validPortalNavigationUuid)
  )];
  const activeBindings = new Set();

  if (portalIds.length && companyIds.length) {
    const bindingResult = await pool.query(
      `SELECT credential.portal_id, scope.company_id
         FROM tender.portal_credential_secrets credential
         JOIN tender.portal_credential_companies scope
           ON scope.credential_id=credential.id AND scope.active=true
         JOIN tender.enterprise_company_links company
           ON company.company_id=scope.company_id AND company.active=true
         JOIN tender.portal_registry portal
           ON portal.id=credential.portal_id
        WHERE credential.portal_id=ANY($1::uuid[])
          AND scope.company_id=ANY($2::uuid[])
          AND credential.status='ACTIVE'
          AND credential.revoked_at IS NULL
          AND (credential.valid_until IS NULL OR credential.valid_until>now())
          AND (
            credential.account_type IS NULL OR (
              credential.bound_host=lower(portal.canonical_domain)
              AND 'BID_SUBMISSION'=ANY(
                coalesce(credential.authorized_capabilities,'{}'::text[])
              )
            )
          )
        GROUP BY credential.portal_id,scope.company_id
        HAVING count(DISTINCT credential.id)=1`,
      [portalIds, companyIds],
    );
    for (const binding of bindingResult.rows)
      activeBindings.add(`${binding.portal_id}:${binding.company_id}`);
  }

  return rows.map((row) => {
    const tenderId = String(row.tender_id || row.id || ""),
      companyId = String(row.portal_navigation_company_id || row.company_id || ""),
      portalId = resolvedPortals.get(`${tenderId}:${companyId}`) || null;
    return {
      ...row,
      portal_access_connected: Boolean(
        row.portal_access_connected ||
        (portalId && activeBindings.has(`${portalId}:${companyId}`))
      ),
      portal_navigation_href: portalNavigationHref({
        uiBase,
        tenderId,
        companyId,
        portalId,
        service: row.service_line || row.service_scope || null,
        version: row.tender_version_id || row.version_id || null,
        lot: row.lot_id || row.lot_key || null,
        returnTo,
      }),
      portal_navigation_mode: portalId ? "edit" : "search",
    };
  });
}
