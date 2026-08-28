const text = (value) => String(value ?? "");

export function normalizePortalSearch(value) {
  return text(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("de-DE")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]/g, "");
}

export function portalSearchText(portal) {
  return [
    portal.portalName,
    portal.operator,
    portal.domain,
    ...(portal.aliases || []),
    portal.adapterId,
    portal.adapterName,
    portal.portalType,
    portal.loginEntryUrl,
    portal.registrationEntryUrl,
    portal.portalId,
    portal.purpose,
    ...(portal.serviceCapabilities || []),
    ...(portal.serviceRoles || []),
    ...(portal.credentialAccountTypes || []),
  ].map(normalizePortalSearch).join(" ");
}

export function canonicalPortalAccessStatus({ configured, sessionEffectiveStatus, jobStatus, jobResultCode, mfaRequired }) {
  if (!configured) return "NO_ACCESS";
  if (["QUEUED", "PENDING", "CLAIMED", "RETRY", "RUNNING"].includes(jobStatus))
    return "CHECK_RUNNING";
  if (sessionEffectiveStatus === "ACTIVE") return "LOGGED_IN";
  if (mfaRequired || ["MFA_REQUIRED", "MFA_BESTÄTIGUNG_ERFORDERLICH"].includes(jobResultCode)) return "MFA_REQUIRED";
  if (["PORTAL_UNREACHABLE", "NETWORK_ERROR", "TIMEOUT"].includes(jobResultCode))
    return "PORTAL_UNREACHABLE";
  if (["INVALID_CREDENTIALS", "LOGIN_FAILED", "LOGIN_FORMULAR_GEAENDERT", "DEAD_LETTER"].includes(jobResultCode) || jobStatus === "DEAD_LETTER")
    return "LOGIN_FAILED";
  if (["EXPIRED", "REVOKED", "RELOGIN_REQUIRED_INACTIVE"].includes(sessionEffectiveStatus))
    return "RELOGIN_REQUIRED";
  if (!sessionEffectiveStatus) return "ACCESS_CONFIGURED";
  return "STATUS_UNKNOWN";
}

const booleanFilter = (value) => value === true || value === "true" || value === "1";

export function searchPortalResults(items, query = {}) {
  const needle = normalizePortalSearch(query.q),
    exactHost = text(query.exactHost).toLocaleLowerCase("de-DE"),
    wantedStatuses = new Set([].concat(query.status || []).filter(Boolean)),
    access = text(query.access),
    validated = text(query.validated),
    auth = text(query.authentication),
    download = text(query.documentDownload),
    portalRole = text(query.portalRole),
    pageSize = [25, 50].includes(Number(query.pageSize)) ? Number(query.pageSize) : 25,
    page = Math.max(1, Number(query.page) || 1);
  const filtered = items.filter((item) => {
    if (needle && !portalSearchText(item).includes(needle)) return false;
    if (access === "present" && !item.access?.configured) return false;
    if (access === "missing" && item.access?.configured) return false;
    if (wantedStatuses.size && !wantedStatuses.has(item.access?.status)) return false;
    if (validated === "true" && item.adapterValidationStatus !== "PRODUCTION_VALIDATED") return false;
    if (validated === "false" && item.adapterValidationStatus === "PRODUCTION_VALIDATED") return false;
    if (auth && booleanFilter(auth) !== Boolean(item.authenticationSupported)) return false;
    if (download && booleanFilter(download) !== Boolean(item.documentDownloadSupported)) return false;
    const capabilities=new Set(item.serviceCapabilities||[]);
    if(portalRole==="publication"&&!capabilities.has("NOTICE_PUBLICATION"))return false;
    if(portalRole==="notices"&&!capabilities.has("NOTICE_SEARCH")&&!capabilities.has("NOTICE_VIEW"))return false;
    if(portalRole==="documents"&&!["PUBLIC_DOCUMENT_ACCESS","AUTHENTICATED_DOCUMENT_ACCESS","TENDER_DOCUMENT_DOWNLOAD"].some(value=>capabilities.has(value)))return false;
    if(portalRole==="login"&&!item.loginAvailable&&!capabilities.has("BIDDER_LOGIN"))return false;
    if(portalRole==="submission"&&!capabilities.has("BID_SUBMISSION"))return false;
    if(portalRole==="ted"&&!item.isTedService)return false;
    return true;
  });
  filtered.sort((a, b) => {
    const rank = (item) => [
      exactHost && text(item.domain).toLocaleLowerCase("de-DE") === exactHost ? 0 : 1,
      needle && normalizePortalSearch(item.portalName) === needle ? 0 : 1,
      item.confirmedTenderMapping ? 0 : 1,
      item.access?.configured ? 0 : 1,
    ];
    const ar = rank(a), br = rank(b);
    for (let index = 0; index < ar.length; index++) {
      if (ar[index] !== br[index]) return ar[index] - br[index];
    }
    return text(a.portalName).localeCompare(text(b.portalName), "de") || text(a.domain).localeCompare(text(b.domain), "de");
  });
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize)), currentPage = Math.min(page, pages), start = (currentPage - 1) * pageSize;
  return { items: filtered.slice(start, start + pageSize), total: filtered.length, page: currentPage, pageSize, pages };
}
