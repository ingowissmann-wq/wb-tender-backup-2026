import crypto from "node:crypto";
import { safeExternalHttpsUrl } from "./tender-link-evidence.mjs";

export const PORTAL_EVIDENCE_ROLES = Object.freeze([
  "NOTICE",
  "PROCUREMENT_DOCUMENT",
  "PARTICIPATION",
  "SUBMISSION",
]);

const actionRoles = Object.freeze([
  "PROCUREMENT_DOCUMENT",
  "PARTICIPATION",
  "SUBMISSION",
]);
const roleToAssignment = Object.freeze({
  PROCUREMENT_DOCUMENT: "DOCUMENT_PORTAL",
  PARTICIPATION: "BIDDER_PORTAL",
  SUBMISSION: "SUBMISSION_PORTAL",
});
const canonicalJson = (value) => JSON.stringify(value && typeof value === "object"
  ? Array.isArray(value) ? value.map((item) => JSON.parse(canonicalJson(item)))
    : Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(canonicalJson(value[key]))]))
  : (value ?? null));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const host = (url) => new URL(url).hostname.toLowerCase();

export function classifyAuthoritativePortalLink({ url, path = "", role = null, sourceUrl = null } = {}) {
  const safe = safeExternalHttpsUrl(url);
  if (!safe) return null;
  if (role && PORTAL_EVIDENCE_ROLES.includes(role)) return { url: safe, role, path: String(path || "EXPLICIT_ROLE") };
  const source = safeExternalHttpsUrl(sourceUrl);
  if (source && host(source) === host(safe) && /(?:ted\.europa\.eu|oeffentlichevergabe\.de)$/i.test(host(safe)))
    return { url: safe, role: "NOTICE", path: String(path || "SOURCE_URL") };
  const location = String(path || "");
  if (/TenderRecipientParty|TenderSubmission|SubmissionMethod|SubmissionURL|submission[_-]?url/i.test(location))
    return { url: safe, role: "SUBMISSION", path: location };
  if (/ParticipationRequest|TendererQualification|QualificationRequest|participation[_-]?url/i.test(location))
    return { url: safe, role: "PARTICIPATION", path: location };
  if (/CallForTendersDocumentReference|AdditionalDocumentReference|ContractDocument|ProcurementDocument|tender\.documents/i.test(location))
    return { url: safe, role: "PROCUREMENT_DOCUMENT", path: location };
  return null;
}

const portalHosts = (portal) => [
  portal.canonical_domain,
  ...(portal.allowed_subdomains || []),
  ...(portal.authentication_domains || []),
  ...(portal.download_domains || []),
].map((value) => String(value || "").toLowerCase()).filter(Boolean);

export function resolveAuthoritativePortalEvidence(links = [], portals = []) {
  const deduplicated = new Map();
  for (const raw of links) {
    const link = classifyAuthoritativePortalLink(raw);
    if (link) deduplicated.set(`${link.role}:${link.url}`, link);
  }
  const evidence = [...deduplicated.values()].map((link) => {
    const exactHost = host(link.url);
    const matches = portals.filter((portal) => portalHosts(portal).includes(exactHost));
    return { ...link, exactHost, matches };
  });
  const resolutions = [];
  for (const role of PORTAL_EVIDENCE_ROLES) {
    const roleEvidence = evidence.filter((item) => item.role === role);
    const matchedPortals = new Map();
    for (const item of roleEvidence) for (const portal of item.matches)
      matchedPortals.set(String(portal.id), portal);
    const uniquePortal = matchedPortals.size === 1 ? [...matchedPortals.values()][0] : null;
    const status = roleEvidence.length === 0 || matchedPortals.size === 0
      ? "NOT_FOUND"
      : matchedPortals.size === 1 ? "UNIQUE_EVIDENCE" : "REVIEW_REQUIRED";
    const chosen = uniquePortal
      ? roleEvidence.find((item) => item.matches.some((portal) => String(portal.id) === String(uniquePortal.id)))
      : roleEvidence[0] || null;
    const proof = {
      role,
      status,
      portalId: uniquePortal?.id || null,
      exactHost: uniquePortal?.canonical_domain || chosen?.exactHost || null,
      urls: roleEvidence.map((item) => item.url).sort(),
      paths: roleEvidence.map((item) => item.path).sort(),
      candidatePortalIds: [...matchedPortals.keys()].sort(),
      resolverVersion: "authoritative-portal-resolution/1.0.0",
      externalWrite: false,
      transmitted: false,
    };
    resolutions.push({
      role,
      status,
      portalId: uniquePortal?.id || null,
      exactHost: uniquePortal?.canonical_domain || chosen?.exactHost || null,
      evidenceUrl: chosen?.url || null,
      evidencePriority: role === "NOTICE" ? 10 : 100,
      evidence: proof,
      evidenceSha256: sha256(canonicalJson(proof)),
    });
  }
  return { links: evidence, resolutions };
}

export async function persistAuthoritativePortalEvidence(client, {
  tenderId,
  tenderVersionId,
  sourceUrl,
  linkEvidence = [],
} = {}) {
  const portals = (await client.query(`SELECT id,canonical_domain,allowed_subdomains,
    authentication_domains,download_domains,capabilities,adapter_validation_status
    FROM tender.portal_registry`)).rows;
  const resolved = resolveAuthoritativePortalEvidence([
    { url: sourceUrl, role: "NOTICE", path: "TENDER_SOURCE_URL" },
    ...linkEvidence,
  ], portals);
  for (const link of resolved.links) {
    const matchedPortals = portals.filter((portal) => portalHosts(portal).includes(link.exactHost));
    const publicAccess = link.role === "PROCUREMENT_DOCUMENT" && matchedPortals.length === 1
      && matchedPortals[0].adapter_validation_status === "PRODUCTION_VALIDATED"
      && (matchedPortals[0].capabilities || []).includes("PUBLIC_DOCUMENTS_POSSIBLE");
    const proof = {
      role: link.role,
      path: link.path,
      originalHost: link.exactHost,
      resolverVersion: "authoritative-portal-resolution/1.0.0",
      externalWrite: false,
      transmitted: false,
    };
    const persistedProof = {
      ...proof,
      publicAccessSource: publicAccess
        ? "AUTHORITATIVE_SOURCE_AND_PRODUCTION_VALIDATED_PORTAL_CAPABILITY"
        : null,
    };
    await client.query(`INSERT INTO tender.tender_external_links(
        tender_id,tender_version_id,role,original_url,original_host,public_access,
        verification_status,evidence,evidence_sha256)
      VALUES($1,$2,$3,$4,$5,$6,'DISCOVERED',$7::jsonb,$8)
      ON CONFLICT DO NOTHING`, [
      tenderId,
      tenderVersionId,
      link.role,
      link.url,
      link.exactHost,
      publicAccess,
      JSON.stringify(persistedProof),
      sha256(canonicalJson(persistedProof)),
    ]);
  }
  for (const resolution of resolved.resolutions) {
    await client.query(`INSERT INTO tender.tender_portal_resolutions(
        tender_id,tender_version_id,portal_id,exact_host,evidence_url,evidence_role,
        evidence_priority,resolution_status,evidence,evidence_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
      ON CONFLICT(tender_version_id,(coalesce(evidence_role,''))) DO UPDATE SET
        portal_id=excluded.portal_id,exact_host=excluded.exact_host,
        evidence_url=excluded.evidence_url,evidence_priority=excluded.evidence_priority,
        resolution_status=excluded.resolution_status,evidence=excluded.evidence,
        evidence_sha256=excluded.evidence_sha256,updated_at=now()
      WHERE coalesce(tender.tender_portal_resolutions.evidence_priority,0)<=excluded.evidence_priority
        AND CASE tender.tender_portal_resolutions.resolution_status
          WHEN 'UNIQUE_EVIDENCE' THEN 3 WHEN 'REVIEW_REQUIRED' THEN 2 ELSE 1 END
          <= CASE excluded.resolution_status
          WHEN 'UNIQUE_EVIDENCE' THEN 3 WHEN 'REVIEW_REQUIRED' THEN 2 ELSE 1 END`, [
      tenderId,
      tenderVersionId,
      resolution.portalId,
      resolution.exactHost,
      resolution.evidenceUrl,
      resolution.role,
      resolution.evidencePriority,
      resolution.status,
      JSON.stringify(resolution.evidence),
      resolution.evidenceSha256,
    ]);
  }
  return resolved;
}

export async function materializeAuthoritativePortalAssignments(pool, { tenderId, selected = [] } = {}) {
  if (!tenderId || !selected.length) return { inserted: 0, superseded: 0, reviewRequired: 0 };
  const client = await pool.connect();
  let inserted = 0, superseded = 0, reviewRequired = 0;
  try {
    await client.query("BEGIN");
    const version = (await client.query(`SELECT id FROM tender.tender_versions WHERE tender_id=$1
      ORDER BY version DESC,created_at DESC,id DESC LIMIT 1`, [tenderId])).rows[0];
    if (!version) throw Object.assign(new Error("current tender version missing"), { code: "TENDER_VERSION_MISSING" });
    for (const context of selected) {
      const companyId = context.company?.company_id;
      const service = context.relevance?.serviceLine || context.company?.canonical_service || context.company?.sector_slug;
      if (!companyId || !service) { reviewRequired++; continue; }
      const scope = (await client.query(`SELECT scope.tenant_id,scope.canonical_service
        FROM tender.configuration_scopes scope JOIN tender.enterprise_company_links company
          ON company.company_id=scope.company_id AND company.tender_profile_id=scope.profile_id
        WHERE scope.company_id=$1 AND scope.canonical_service=$2`, [companyId, service])).rows;
      if (scope.length !== 1) { reviewRequired++; continue; }
      let lot = null;
      if (context.lotKey) lot = (await client.query(`SELECT id,external_id FROM tender.lots
        WHERE tender_id=$1 AND external_id=$2`, [tenderId, context.lotKey])).rows[0] || null;
      else {
        const lots = (await client.query(`SELECT id,external_id FROM tender.lots WHERE tender_id=$1 ORDER BY external_id,id`, [tenderId])).rows;
        if (lots.length === 1) lot = lots[0];
      }
      if (!lot) { reviewRequired += actionRoles.length; continue; }
      for (const evidenceRole of actionRoles) {
        const resolution = (await client.query(`SELECT resolution.*,portal.canonical_domain,portal.adapter_id,
            capability.portal_type
          FROM tender.tender_portal_resolutions resolution
          JOIN tender.portal_registry portal ON portal.id=resolution.portal_id
            AND lower(portal.canonical_domain)=lower(resolution.exact_host)
          LEFT JOIN LATERAL(SELECT profile.portal_type
            FROM tender.portal_capability_profiles profile WHERE profile.portal_id=portal.id
            ORDER BY profile.profile_version DESC,profile.created_at DESC,profile.id DESC LIMIT 1) capability ON true
          WHERE resolution.tender_id=$1 AND resolution.tender_version_id=$2
            AND resolution.evidence_role=$3 AND resolution.resolution_status='UNIQUE_EVIDENCE'`,
        [tenderId, version.id, evidenceRole])).rows;
        if (resolution.length !== 1 || resolution[0].portal_type === "BEKANNTMACHUNGSPLATTFORM"
          || resolution[0].adapter_id === "ted-discovery") { reviewRequired++; continue; }
        const portalRole = roleToAssignment[evidenceRole];
        const conflictingManual = (await client.query(`SELECT 1
          FROM tender.tender_portal_assignments assignment
          WHERE assignment.tenant_id=$1 AND assignment.company_id=$2 AND assignment.tender_id=$3
            AND assignment.canonical_service=$4 AND coalesce(assignment.source_lot_id,'')=$5
            AND assignment.portal_role=$6 AND assignment.status='ACTIVE'
            AND assignment.assignment_source='MANUAL_AUDITED'
            AND (assignment.tender_version_id<>$7 OR assignment.portal_id<>$8
              OR lower(assignment.exact_host)<>lower($9)) LIMIT 1`, [
          scope[0].tenant_id, companyId, tenderId, scope[0].canonical_service,
          lot.external_id, portalRole, version.id, resolution[0].portal_id, resolution[0].exact_host,
        ])).rowCount;
        if (conflictingManual) { reviewRequired++; continue; }
        const old = await client.query(`UPDATE tender.tender_portal_assignments SET
            status='SUPERSEDED',superseded_at=coalesce(superseded_at,now())
          WHERE tenant_id=$1 AND company_id=$2 AND tender_id=$3 AND canonical_service=$4
            AND coalesce(source_lot_id,'')=$5 AND portal_role=$6 AND status='ACTIVE'
            AND assignment_source<>'MANUAL_AUDITED'
            AND (tender_version_id<>$7 OR portal_id<>$8 OR lower(exact_host)<>lower($9))`, [
          scope[0].tenant_id, companyId, tenderId, scope[0].canonical_service,
          lot.external_id, portalRole, version.id, resolution[0].portal_id, resolution[0].exact_host,
        ]);
        superseded += old.rowCount;
        const saved = await client.query(`INSERT INTO tender.tender_portal_assignments(
            tenant_id,company_id,tender_id,tender_version_id,lot_id,source_lot_id,
            canonical_service,portal_id,exact_host,assignment_source,status,evidence_sha256,portal_role)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,'UNIQUE_EVIDENCE','ACTIVE',$10,$11
          WHERE NOT EXISTS(SELECT 1 FROM tender.tender_portal_assignments assignment
            WHERE assignment.tenant_id=$1 AND assignment.company_id=$2 AND assignment.tender_id=$3
              AND assignment.tender_version_id=$4 AND assignment.lot_id=$5
              AND assignment.canonical_service=$7 AND assignment.portal_id=$8
              AND lower(assignment.exact_host)=lower($9) AND assignment.portal_role=$11
              AND assignment.status='ACTIVE')`, [
          scope[0].tenant_id, companyId, tenderId, version.id, lot.id, lot.external_id,
          scope[0].canonical_service, resolution[0].portal_id, resolution[0].exact_host,
          resolution[0].evidence_sha256, portalRole,
        ]);
        inserted += saved.rowCount;
      }
    }
    await client.query("COMMIT");
    return { inserted, superseded, reviewRequired };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
