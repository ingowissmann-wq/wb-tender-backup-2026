import {officialTedLinks, tedAccountEvidence} from "./ted-notice-context.mjs";

const SENSITIVE_PARAMETER = /^(?:access_?token|auth(?:entication|orization)?|bearer|code|credential|id_?token|jwt|key|password|refresh_?token|secret|session(?:id)?|sid|ticket|token)$/i;

export const safeExternalHttpsUrl = (value) => {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (/;jsessionid=/i.test(url.pathname)) return null;
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_PARAMETER.test(key)) return null;
    }
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
};

const values = (value) => {
  if (Array.isArray(value)) return value.flatMap(values);
  if (value && typeof value === "object") return Object.values(value).flatMap(values);
  return value === null || value === undefined ? [] : [value];
};

const firstSafe = (...candidates) =>
  candidates.flatMap(values).map((value) => safeExternalHttpsUrl(value)).find(Boolean) || null;

const preferredLocalizedLink = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return firstSafe(value);
  return firstSafe(value.DEU, value.GER, value.ENG, value.EN, Object.values(value));
};

const isDoeTechnicalSource = (value) => {
  const safe = safeExternalHttpsUrl(value);
  if (!safe) return false;
  const url = new URL(safe);
  return /(^|\.)oeffentlichevergabe\.de$/i.test(url.hostname) &&
    (/\/api\/notices\//i.test(url.pathname) || url.searchParams.get("format")?.toLowerCase() === "ocds");
};

const uniqueLinks = (candidates) => {
  const links = new Map();
  for (const candidate of candidates) {
    const url = safeExternalHttpsUrl(candidate?.url);
    if (url && !links.has(url)) links.set(url, { ...candidate, url });
  }
  return [...links.values()];
};

const hostMatchesPortal = (url, portal) => {
  const host = new URL(url).hostname.toLowerCase(),
    domains = [portal.canonical_domain, ...(portal.allowed_subdomains || []), ...(portal.authentication_domains || []), ...(portal.download_domains || [])]
      .map((value) => String(value || "").toLowerCase().replace(/^www\./, ""))
      .filter(Boolean),
    normalizedHost = host.replace(/^www\./, "");
  return domains.some((domain) => normalizedHost === domain);
};

const sourceDocuments = (sourceCode, raw = {}) => {
  const result = [];
  if (sourceCode === "DOE") {
    for (const document of Array.isArray(raw?.tender?.documents) ? raw.tender.documents : []) {
      result.push({
        url: document.url,
        label: document.title || document.description || "Dokument der Bekanntmachung",
        source: "DOE_QUELLPAYLOAD",
      });
    }
  }
  if (sourceCode === "TED") {
    for (const url of values(raw?.links?.pdfs || raw?.links?.pdf)) {
      result.push({ url, label: "Offizielle TED-Bekanntmachung (PDF)", source: "TED_QUELLPAYLOAD" });
    }
  }
  return uniqueLinks(result);
};

const explicitSubmissionUrl = (raw = {}) =>
  firstSafe(
    raw?.tender?.submission_url,
    raw?.tender?.submissionUrl,
    raw?.tender?.submissionMethodDetails,
    raw?.submission_url,
    raw?.submissionUrl,
  );

const buyerProfileUrl = (raw = {}) =>
  firstSafe(
    raw?.buyer?.uri,
    raw?.buyer?.url,
    raw?.buyer_profile_url,
    raw?.buyerProfileUrl,
    (Array.isArray(raw?.parties) ? raw.parties : []).map((party) => party?.contactPoint?.url),
  );

const documentTruth = ({ sourceLinks, enrichmentDocuments, enrichmentId }) => {
  const documents = enrichmentDocuments || [],
    fetched = documents.filter((item) => /(?:SUCCEEDED|FETCHED|VORHANDEN)/i.test(String(item.fetch_status || item.resolution_status || ""))).length,
    failed = documents.filter((item) => /(?:FAILED|ERROR)/i.test(String(item.fetch_status || item.resolution_status || ""))).length,
    loginRequired = documents.filter((item) => /(?:PORTAL|LOGIN|AUTHENTICATION).*ERFORDERLICH|ACCESS_REQUIRED/i.test(String(item.fetch_status || item.resolution_status || ""))).length;
  if (fetched)
    return { code: "DOCUMENTS_FOUND", label: "Dokumente erfolgreich gefunden", reason: `${fetched} Dokumentabruf${fetched === 1 ? "" : "e"} erfolgreich.`, linksFound: sourceLinks.length, fetched, failed, loginRequired };
  if (loginRequired)
    return { code: "LOGIN_REQUIRED", label: "Portal verlangt Anmeldung", reason: "Mindestens ein belegter Dokumentlink erfordert einen Portalzugang.", linksFound: sourceLinks.length, fetched, failed, loginRequired };
  if (failed)
    return { code: "FETCH_FAILED", label: "Dokumentabruf fehlgeschlagen", reason: "Mindestens ein belegter Abrufversuch ist fehlgeschlagen.", linksFound: sourceLinks.length, fetched, failed, loginRequired };
  if (!enrichmentId)
    return { code: "FETCH_NOT_RUN", label: "Abruf noch nicht ausgeführt", reason: sourceLinks.length ? "Die Quelle enthält Dokumentlinks; ein Abruf wurde noch nicht ausgeführt." : "Für diese Ausschreibung wurde noch kein Dokumentabruf ausgeführt.", linksFound: sourceLinks.length, fetched: 0, failed: 0, loginRequired: 0 };
  if (sourceLinks.length && !documents.length)
    return { code: "LINKS_NOT_EXTRACTED", label: "Dokumentlinks noch nicht extrahiert", reason: "Die Quelle enthält Links, aber es liegen noch keine extrahierten Dokumentdatensätze vor.", linksFound: sourceLinks.length, fetched: 0, failed: 0, loginRequired: 0 };
  if (!sourceLinks.length && !documents.length)
    return { code: "SOURCE_HAS_NO_DOCUMENT_LINKS", label: "Quelle enthält keine Dokumentlinks", reason: "Im gespeicherten Quelldatensatz sind keine Dokumentlinks angegeben.", linksFound: 0, fetched: 0, failed: 0, loginRequired: 0 };
  return { code: "FETCH_NOT_RUN", label: "Abruf noch nicht ausgeführt", reason: "Dokumentlinks sind bekannt; ein erfolgreicher Abruf ist nicht belegt.", linksFound: sourceLinks.length, fetched: 0, failed: 0, loginRequired: 0 };
};

export const buildTenderLinkEvidence = (row, portals = []) => {
  const sourceCode = String(row.source_code || "").toUpperCase(),
    normalized = row.normalized_data || {},
    raw = normalized.raw || normalized.source || normalized,
    originalUrl = sourceCode === "TED"
      ? firstSafe(preferredLocalizedLink(raw?.links?.html), preferredLocalizedLink(raw?.links?.htmlDirect), !/\/xml(?:[?#]|$)/i.test(row.source_url || "") && row.source_url)
      : firstSafe(raw?.notice_url, raw?.noticeUrl, raw?.tender?.notice_url, raw?.tender?.noticeUrl),
    technicalSourceUrl = sourceCode === "DOE"
      ? firstSafe([raw?.uri, row.source_url].filter(isDoeTechnicalSource))
      : null,
    persistedLinks = Array.isArray(row.external_links) ? row.external_links.map((link) => ({
      url: link.original_url,
      role: link.role,
      label: link.role === "PROCUREMENT_DOCUMENT" ? "Offizielle Vergabeunterlagen" : "Offizieller Bekanntmachungslink",
      source: "VERIFIED_LINK_EVIDENCE",
      publicAccess: link.public_access,
      verificationStatus: link.verification_status,
      finalUrl: link.final_url,
    })) : [],
    tedOfficialLinks = sourceCode === "TED" ? officialTedLinks(row.external_id || row.notice_number).map((link) => ({...link,label:link.format === "PDF" ? "Offizielle TED-Bekanntmachung (PDF)" : `Offizielle TED-Bekanntmachung (${link.format})`,source:"TED_OFFICIAL_FORMAT"})) : [],
    payloadDocuments = uniqueLinks([...sourceDocuments(sourceCode, raw),...tedOfficialLinks,...persistedLinks.filter((link) => !["LOGIN","REGISTRATION"].includes(link.role))]),
    enrichmentDocuments = Array.isArray(row.enrichment_documents) ? row.enrichment_documents : [],
    enrichmentLinks = uniqueLinks(enrichmentDocuments.map((document) => ({
      url: document.source_url,
      label: document.filename || "Extrahiertes Dokument",
      source: "ENRICHMENT_DOCUMENT",
    }))),
    documents = uniqueLinks([...payloadDocuments, ...enrichmentLinks]),
    publicationHost = (() => { try { return new URL(safeExternalHttpsUrl(row.source_url)).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; } })(),
    externalPortalLinks = documents.filter((link) => new URL(link.url).hostname.toLowerCase().replace(/^www\./, "") !== publicationHost),
    legacyPortalMatches = externalPortalLinks.map((link) => {
      const host = new URL(link.url).hostname.toLowerCase().replace(/^www\./, "");
      if (host === publicationHost) return null;
      const matches = portals.filter((portal) => hostMatchesPortal(link.url, portal));
      return matches.length === 1 ? { link, portal: matches[0] } : null;
    }).filter(Boolean),
    authoritative = Array.isArray(row.authoritative_portal_resolutions)
      ? row.authoritative_portal_resolutions
      : null,
    actionResolutions = (authoritative || []).filter((resolution) =>
      ["SUBMISSION", "PARTICIPATION", "PROCUREMENT_DOCUMENT"].includes(resolution.evidence_role)),
    roleRank = { SUBMISSION: 0, PARTICIPATION: 1, PROCUREMENT_DOCUMENT: 2 },
    uniqueResolutions = actionResolutions
      .filter((resolution) => resolution.resolution_status === "UNIQUE_EVIDENCE" && resolution.portal_id)
      .sort((left, right) => roleRank[left.evidence_role] - roleRank[right.evidence_role]),
    authoritativeResolution = uniqueResolutions[0] || null,
    authoritativePortal = authoritativeResolution
      ? portals.find((candidate) => String(candidate.id) === String(authoritativeResolution.portal_id)) || null
      : null,
    authoritativeMatch = authoritativePortal && safeExternalHttpsUrl(authoritativeResolution.evidence_url)
      ? { link: { url: safeExternalHttpsUrl(authoritativeResolution.evidence_url), source: "AUTHORITATIVE_ROLE_RESOLUTION" }, portal: authoritativePortal }
      : null,
    legacyPortalIds = [...new Set(legacyPortalMatches.map(({ portal }) => String(portal.id || portal.canonical_domain)))],
    legacyPortalMatch = legacyPortalIds.length === 1 ? legacyPortalMatches[0] : null,
    portalMatch = authoritative === null ? legacyPortalMatch : authoritativeMatch,
    portalCandidate = portalMatch?.link || null,
    portal = portalMatch?.portal || null,
    registryVerified = Boolean((portal?.entry_links_verified_at || portal?.last_verified_at) && portal?.adapter_validation_status === "PRODUCTION_VALIDATED"),
    loginUrl = registryVerified ? safeExternalHttpsUrl(portal.authentication_entry_url) : null,
    registrationUrl = registryVerified ? safeExternalHttpsUrl(portal.registration_entry_url) : null,
    submissionUrl = explicitSubmissionUrl(raw),
    buyerUrl = buyerProfileUrl(raw),
    documentEvidence = documentTruth({ sourceLinks: documents, enrichmentDocuments, enrichmentId: row.enrichment_id }),
    ambiguousResolution = actionResolutions.some((resolution) => resolution.resolution_status === "REVIEW_REQUIRED"),
    unresolvedResolution = authoritative !== null && !portal && actionResolutions.length > 0,
    tedAccount = sourceCode === "TED" ? tedAccountEvidence() : null,
    portalMappingStatus = portal
      ? "EINDEUTIG_ZUGEORDNET"
      : ambiguousResolution || unresolvedResolution || legacyPortalIds.length > 1
        ? "PORTAL_ASSIGNMENT_REVIEW_REQUIRED"
        : "PORTAL_ASSIGNMENT_REVIEW_REQUIRED";
  return {
    source: { code: sourceCode || null, displayName: sourceCode === "DOE" ? "oeffentlichevergabe.de" : sourceCode === "TED" ? "TED (Tenders Electronic Daily)" : sourceCode || "Nicht ermittelt", externalId: row.external_id || row.notice_number || null },
    originalNotice: originalUrl ? { url: originalUrl, label: "Originalbekanntmachung öffnen", targetType: "ORIGINAL_NOTICE", provenanceLabel: sourceCode === "TED" ? "TED" : "offizielle Quelle" } : null,
    technicalSource: technicalSourceUrl ? { url: technicalSourceUrl, label: "OCDS-Quelldatensatz anzeigen", targetType: "TECHNICAL_SOURCE", provenanceLabel: "oeffentlichevergabe.de" } : null,
    account: tedAccount ? {provider:tedAccount.provider,scope:tedAccount.scope,submissionPortal:false,login:{url:tedAccount.login,label:"Bei TED / EU Login anmelden",targetType:"ACCOUNT_LOGIN",provenanceLabel:"allgemeine TED-Kontofunktion"},registration:{url:tedAccount.registration,label:"TED-Konto registrieren",targetType:"ACCOUNT_REGISTRATION",provenanceLabel:"allgemeine TED-Kontofunktion"}} : null,
    procurementPortal: portalCandidate ? { ...portalCandidate, source: undefined, label: "Vergabeportal öffnen", targetType: "PROCUREMENT_PORTAL", provenanceLabel: "offizieller Link im Quelldatensatz", portalId: portal?.id || null, portalName: portal?.display_name || portal?.canonical_domain || null, canonicalHost: portal?.canonical_domain || null } : null,
    documents: documents.filter((link) => link.url !== portalCandidate?.url).slice(0, 20).map((link) => ({ ...link, source: undefined, provenanceLabel: "offizieller Dokumentlink", label: "Dokumente öffnen", targetType: "DOCUMENTS" })),
    login: loginUrl ? { url: loginUrl, label: "Beim Vergabeportal anmelden", targetType: "LOGIN", provenanceLabel: "administrativ verifiziertes Portalregister", portalId: portal?.id || null, portalName: portal?.display_name || null } : null,
    registration: registrationUrl ? { url: registrationUrl, label: "Beim Vergabeportal registrieren", targetType: "REGISTRATION", provenanceLabel: "administrativ verifiziertes Portalregister", portalId: portal?.id || null, portalName: portal?.display_name || null } : null,
    electronicSubmission: submissionUrl ? { url: submissionUrl, label: "Elektronische Abgabe öffnen", targetType: "ELECTRONIC_SUBMISSION", provenanceLabel: "offizieller Quelldatensatz" } : null,
    buyerProfile: buyerUrl ? { url: buyerUrl, label: "Beschafferprofil öffnen", targetType: "BUYER_PROFILE", provenanceLabel: "offizieller Quelldatensatz" } : null,
    portalMapping: { status: portalMappingStatus, portalId: portal?.id || null, evidenceRole: authoritativeResolution?.evidence_role || null, reason: ambiguousResolution || legacyPortalIds.length > 1 ? "Mehrere mögliche Portalhosts" : portal ? null : unresolvedResolution ? "Autoritative Portalauflösung ist nicht eindeutig" : externalPortalLinks.length ? "Portalhost noch nicht in der Registry" : "Kein autoritatives Aktionsportal in der Quelle" },
    missingReasons: {
      originalNotice: originalUrl ? null : "Originalbekanntmachung in der Quelle nicht angegeben",
      procurementPortal: portalCandidate ? null : ambiguousResolution || legacyPortalIds.length > 1 ? "Mehrere mögliche Portalhosts – Portalzuordnung prüfen" : externalPortalLinks.length ? "Portalhost noch nicht eindeutig in der Registry zugeordnet" : "Kein autoritatives Vergabeportal ermittelt – Portalzuordnung prüfen",
      documents: documents.filter((link) => link.url !== portalCandidate?.url).length ? null : "Keine getrennten Dokumentlinks in der Quelle angegeben",
      login: loginUrl ? null : "Loginseite noch nicht verifiziert",
      registration: registrationUrl ? null : "Registrierungsseite noch nicht verifiziert",
      electronicSubmission: submissionUrl ? null : "Elektronische Abgabe-URL in der Quelle nicht angegeben",
    },
    documentEvidence,
  };
};

export const loadTenderLinkEvidence = async (pool, tenderIds) => {
  const ids = [...new Set((tenderIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const [evidenceResult, portalResult] = await Promise.all([
    pool.query(
      `SELECT t.id tender_id,t.source_code,t.source_url,t.external_id,t.notice_number,
        version.normalized_data,enrichment.id enrichment_id,enrichment.structured_data,
        coalesce(documents.items,'[]'::jsonb) enrichment_documents,
        coalesce(resolutions.items,'[]'::jsonb) authoritative_portal_resolutions
       FROM tender.tenders t
       LEFT JOIN LATERAL(SELECT v.normalized_data FROM tender.tender_versions v WHERE v.tender_id=t.id ORDER BY v.version DESC LIMIT 1)version ON true
       LEFT JOIN LATERAL(SELECT e.id,e.structured_data FROM tender.enrichment_versions e WHERE e.tender_id=t.id AND e.historical=false ORDER BY e.version DESC LIMIT 1)enrichment ON true
       LEFT JOIN LATERAL(SELECT jsonb_agg(jsonb_build_object('source_url',d.source_url,'filename',d.filename,'fetch_status',d.fetch_status,'resolution_status',d.resolution_status,'http_status',d.http_status) ORDER BY d.id) items FROM tender.enrichment_documents d WHERE d.enrichment_version_id=enrichment.id)documents ON true
       LEFT JOIN LATERAL(
         SELECT jsonb_agg(jsonb_build_object(
           'portal_id',resolution.portal_id,
           'exact_host',resolution.exact_host,
           'evidence_url',resolution.evidence_url,
           'evidence_role',resolution.evidence_role,
           'resolution_status',resolution.resolution_status,
           'evidence_priority',resolution.evidence_priority
         ) ORDER BY CASE resolution.evidence_role WHEN 'SUBMISSION' THEN 1 WHEN 'PARTICIPATION' THEN 2 WHEN 'PROCUREMENT_DOCUMENT' THEN 3 ELSE 4 END) items
         FROM tender.tender_portal_resolutions resolution
         JOIN LATERAL(SELECT candidate.id FROM tender.tender_versions candidate
           WHERE candidate.tender_id=t.id ORDER BY candidate.version DESC,candidate.created_at DESC,candidate.id DESC LIMIT 1) current_version
           ON current_version.id=resolution.tender_version_id
         WHERE resolution.tender_id=t.id
       ) resolutions ON true
       WHERE t.id=ANY($1::uuid[])`,
      [ids],
    ),
    pool.query("SELECT id,display_name,canonical_domain,allowed_subdomains,authentication_domains,download_domains,authentication_entry_url,registration_entry_url,adapter_validation_status,last_verified_at,entry_links_verified_at FROM tender.portal_registry"),
  ]);
  const portals = portalResult.rows || [];
  return new Map((evidenceResult.rows || []).map((row) => [String(row.tender_id), buildTenderLinkEvidence(row, portals)]));
};
