import { loadTenderLinkEvidence } from "./tender-link-evidence.mjs";
import { tenderCredentialPortalEligibility } from "./portal-credentials.mjs";

export const PORTAL_NAVIGATION_RELEASE = "portal-management-20260820.4-ted-capabilities";

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
  return rows.map((row) => {
    const tenderId = String(row.tender_id || row.id || ""),
      companyId = String(row.portal_navigation_company_id || row.company_id || ""),
      linkEvidence = evidence.get(tenderId),
      confirmedPortalId = confirmed.get(`${tenderId}:${companyId}`),
      detectedPortalId =
        linkEvidence?.portalMapping?.status === "EINDEUTIG_ZUGEORDNET"
          && eligibleDetected.has(String(linkEvidence.portalMapping.portalId))
          ? linkEvidence.portalMapping.portalId
          : null,
      portalId = confirmedPortalId || detectedPortalId || null;
    return {
      ...row,
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
