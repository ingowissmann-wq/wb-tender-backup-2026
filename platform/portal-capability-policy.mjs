const text = (value) => String(value ?? "").trim();
const hostOf = (portal) => text(portal?.canonical_domain || portal?.domain).toLowerCase().replace(/\.$/, "");

export const PORTAL_CAPABILITIES = Object.freeze([
  "NOTICE_SEARCH",
  "NOTICE_VIEW",
  "SAVED_SEARCHES",
  "ALERTS",
  "PUBLIC_DOCUMENT_ACCESS",
  "AUTHENTICATED_DOCUMENT_ACCESS",
  "NOTICE_PUBLICATION",
  "BUYER_ACCOUNT",
  "BIDDER_REGISTRATION",
  "BIDDER_LOGIN",
  "TENDER_DOCUMENT_DOWNLOAD",
  "BID_SUBMISSION",
  "SUBMISSION_STATUS",
  "RECEIPT_DOWNLOAD",
]);

export const PORTAL_ACCOUNT_TYPES = Object.freeze([
  "DISCOVERY_ACCOUNT",
  "NOTICE_ACCOUNT",
  "BUYER_PUBLICATION_ACCOUNT",
  "BIDDER_PORTAL_ACCOUNT",
  "DOCUMENT_ACCESS_ACCOUNT",
  "SUBMISSION_ACCOUNT",
]);

const ACCOUNT_CAPABILITIES = Object.freeze({
  DISCOVERY_ACCOUNT: new Set(["NOTICE_SEARCH", "NOTICE_VIEW", "SAVED_SEARCHES", "ALERTS", "PUBLIC_DOCUMENT_ACCESS"]),
  NOTICE_ACCOUNT: new Set(["NOTICE_SEARCH", "NOTICE_VIEW", "SAVED_SEARCHES", "ALERTS", "PUBLIC_DOCUMENT_ACCESS"]),
  BUYER_PUBLICATION_ACCOUNT: new Set(["NOTICE_PUBLICATION", "BUYER_ACCOUNT", "SUBMISSION_STATUS", "RECEIPT_DOWNLOAD"]),
  BIDDER_PORTAL_ACCOUNT: new Set(["BIDDER_REGISTRATION", "BIDDER_LOGIN", "AUTHENTICATED_DOCUMENT_ACCESS", "TENDER_DOCUMENT_DOWNLOAD", "SUBMISSION_STATUS", "RECEIPT_DOWNLOAD"]),
  DOCUMENT_ACCESS_ACCOUNT: new Set(["BIDDER_LOGIN", "AUTHENTICATED_DOCUMENT_ACCESS", "TENDER_DOCUMENT_DOWNLOAD"]),
  SUBMISSION_ACCOUNT: new Set(["BIDDER_REGISTRATION", "BIDDER_LOGIN", "AUTHENTICATED_DOCUMENT_ACCESS", "TENDER_DOCUMENT_DOWNLOAD", "BID_SUBMISSION", "SUBMISSION_STATUS", "RECEIPT_DOWNLOAD"]),
});

export const TED_SERVICE_CATALOG = Object.freeze([
  {
    host: "ted.europa.eu",
    officialName: "TED – Tenders Electronic Daily",
    operator: "Amt für Veröffentlichungen der Europäischen Union",
    purpose: "Bekanntmachungssuche, Bekanntmachungsansicht sowie persönliche Such- und Hinweisfunktionen",
    openUrl: "https://ted.europa.eu/",
    noticeSearchUrl: "https://ted.europa.eu/en/search/result",
    loginAvailable: true,
    registrationAvailable: true,
    capabilities: ["NOTICE_SEARCH", "NOTICE_VIEW", "SAVED_SEARCHES", "ALERTS", "PUBLIC_DOCUMENT_ACCESS"],
    roles: ["PUBLIC_USER", "REGISTERED_NOTICE_USER"],
    accountTypes: ["DISCOVERY_ACCOUNT", "NOTICE_ACCOUNT"],
    validationStatus: "OFFICIAL_DOCUMENTED",
  },
  {
    host: "enotices2.ted.europa.eu",
    officialName: "eNotices2",
    operator: "Amt für Veröffentlichungen der Europäischen Union",
    purpose: "Erstellen, verwalten und übermitteln von eForms-Bekanntmachungen zur Veröffentlichung",
    openUrl: "https://enotices2.ted.europa.eu/",
    loginAvailable: true,
    registrationAvailable: true,
    capabilities: ["NOTICE_PUBLICATION", "BUYER_ACCOUNT", "SUBMISSION_STATUS"],
    roles: ["BUYER", "ESENDER"],
    accountTypes: ["BUYER_PUBLICATION_ACCOUNT"],
    validationStatus: "OFFICIAL_DOCUMENTED",
  },
  {
    host: "docs.ted.europa.eu",
    officialName: "TED Developer Docs",
    operator: "Amt für Veröffentlichungen der Europäischen Union",
    purpose: "Öffentliche technische Dokumentation für TED Apps, APIs, eForms und Open Data",
    openUrl: "https://docs.ted.europa.eu/",
    loginAvailable: false,
    registrationAvailable: false,
    capabilities: [],
    roles: ["PUBLIC_USER", "DEVELOPER"],
    accountTypes: [],
    validationStatus: "OFFICIAL_DOCUMENTED",
  },
  {
    host: "developer.ted.europa.eu",
    officialName: "TED Developer Portal",
    operator: "Amt für Veröffentlichungen der Europäischen Union",
    purpose: "Entwicklerprofil und Verwaltung von TED-API-Schlüsseln über EU Login",
    openUrl: "https://developer.ted.europa.eu/",
    loginAvailable: true,
    registrationAvailable: true,
    capabilities: ["NOTICE_SEARCH", "NOTICE_PUBLICATION"],
    roles: ["DEVELOPER", "ESENDER"],
    accountTypes: [],
    validationStatus: "OFFICIAL_DOCUMENTED",
  },
  {
    host: "api.ted.europa.eu",
    officialName: "TED API Gateway",
    operator: "Amt für Veröffentlichungen der Europäischen Union",
    purpose: "Programmierschnittstellen für Suche, Abruf, Validierung und Bekanntmachungsübermittlung",
    openUrl: "https://api.ted.europa.eu/swagger",
    loginAvailable: false,
    registrationAvailable: false,
    capabilities: ["NOTICE_SEARCH", "NOTICE_VIEW", "PUBLIC_DOCUMENT_ACCESS", "NOTICE_PUBLICATION"],
    roles: ["PUBLIC_DATA_REUSER", "DEVELOPER", "ESENDER"],
    accountTypes: [],
    validationStatus: "OFFICIAL_DOCUMENTED",
  },
]);

const knownTedByHost = new Map(TED_SERVICE_CATALOG.map((service) => [service.host, service]));
export const isTedHost = (value) => {
  const host = text(typeof value === "string" ? value : hostOf(value)).toLowerCase().replace(/\.$/, "");
  return host === "ted.europa.eu" || host.endsWith(".ted.europa.eu");
};
export const tedServiceForHost = (value) => knownTedByHost.get(text(typeof value === "string" ? value : hostOf(value)).toLowerCase().replace(/\.$/, "")) || null;

export function portalCapabilitySet(portal = {}) {
  const service = tedServiceForHost(portal), values = new Set();
  for (const capability of [...(Array.isArray(portal.capabilities) ? portal.capabilities : []), ...(service?.capabilities || [])]) {
    const normalized = text(capability).toUpperCase();
    if (PORTAL_CAPABILITIES.includes(normalized)) values.add(normalized);
  }
  const features = portal.capability_features || portal.capabilityProfile?.features || {};
  const legacy = { DISCOVERY:"NOTICE_SEARCH", NOTICES:"NOTICE_VIEW", DOCUMENT_DOWNLOAD:"TENDER_DOCUMENT_DOWNLOAD", LOGIN:"BIDDER_LOGIN", SUBMISSION:"BID_SUBMISSION" };
  for (const [key, capability] of Object.entries(legacy))
    if (features[key]?.portalSupport === "SUPPORTED") values.add(capability);
  return values;
}

export function portalCatalogProfile(portal = {}) {
  const host = hostOf(portal), service = tedServiceForHost(host), capabilities = [...portalCapabilitySet(portal)];
  return {
    host,
    isTedService: isTedHost(host),
    knownTedService: Boolean(service),
    officialName: service?.officialName || text(portal.display_name || portal.portalName) || host,
    operator: service?.operator || text(portal.operator || portal.display_name || portal.portalName) || "Nicht belegt",
    purpose: service?.purpose || (isTedHost(host) ? "TED-Subdomain; Zweck muss separat geprüft werden" : text(portal.purpose || portal.portalType) || "Noch nicht klassifiziert"),
    capabilities,
    roles: service?.roles || [],
    accountTypes: service?.accountTypes || (isTedHost(host) ? [] : [...PORTAL_ACCOUNT_TYPES]),
    loginAvailable: service?.loginAvailable ?? Boolean(portal.authentication_entry_url || portal.loginEntryUrl),
    registrationAvailable: service?.registrationAvailable ?? Boolean(portal.registration_entry_url || portal.registrationEntryUrl),
    openUrl: service?.openUrl || (host ? `https://${host}/` : null),
    noticeSearchUrl: service?.noticeSearchUrl || null,
    validationStatus: service?.validationStatus || (isTedHost(host) ? "REVIEW_REQUIRED" : text(portal.adapter_validation_status || portal.adapterValidationStatus) || "REVIEW_REQUIRED"),
  };
}

export function withTedServiceCatalog(rows = []) {
  const byHost = new Map(rows.map((row) => [hostOf(row), row]));
  const enriched = rows.map((row) => ({ ...row, catalog_profile: portalCatalogProfile(row) }));
  for (const service of TED_SERVICE_CATALOG) {
    if (byHost.has(service.host)) continue;
    const virtual = {
      id: `ted-service:${service.host}`,
      display_name: service.officialName,
      canonical_domain: service.host,
      adapter_id: null,
      adapter_enabled: false,
      adapter_validation_status: "REVIEW_REQUIRED",
      allowed_subdomains: [], authentication_domains: [], download_domains: [],
      authentication_entry_url: null, registration_entry_url: null,
      capabilities: service.capabilities,
      catalog_virtual: true,
    };
    enriched.push({ ...virtual, catalog_profile: portalCatalogProfile(virtual) });
  }
  return enriched;
}

export function credentialAccountEligibility(portal = {}, accountType, requestedCapabilities = []) {
  const profile = portalCatalogProfile(portal), type = text(accountType).toUpperCase(), requested = [...new Set(requestedCapabilities.map((value) => text(value).toUpperCase()).filter(Boolean))];
  if (!PORTAL_ACCOUNT_TYPES.includes(type)) return { eligible:false, code:"CREDENTIAL_ACCOUNT_TYPE_INVALID" };
  if (!profile.accountTypes.includes(type)) return { eligible:false, code:"CREDENTIAL_ACCOUNT_TYPE_NOT_SUPPORTED" };
  const typeCapabilities = ACCOUNT_CAPABILITIES[type], portalCapabilities = new Set(profile.capabilities.length||profile.isTedService?profile.capabilities:[...typeCapabilities]);
  if (!requested.length || requested.some((capability) => !PORTAL_CAPABILITIES.includes(capability) || !typeCapabilities.has(capability) || !portalCapabilities.has(capability)))
    return { eligible:false, code:"CREDENTIAL_CAPABILITY_NOT_SUPPORTED" };
  return { eligible:true, code:null, accountType:type, capabilities:requested, boundHost:profile.host };
}

export function tenderPortalEligibility(portal = {}) {
  const profile = portalCatalogProfile(portal);
  if (profile.knownTedService && !profile.capabilities.includes("BID_SUBMISSION"))
    return { eligible:false, code:"PORTAL_DER_AUSSCHREIBUNG_NICHT_ERMITTELT" };
  if (profile.isTedService && !profile.knownTedService)
    return { eligible:false, code:"PORTAL_NICHT_VALIDIERT" };
  return null;
}

export function credentialJobEligibility(portal = {}, credential = {}, actionType) {
  const required = actionType === "TEST_DOCUMENT_FETCH" ? "TENDER_DOCUMENT_DOWNLOAD" : "BIDDER_LOGIN";
  const allowed = new Set(Array.isArray(credential.authorized_capabilities) ? credential.authorized_capabilities : []);
  if (credential.account_type && (!allowed.has(required) || credential.bound_host !== hostOf(portal)))
    return { eligible:false, code:"CREDENTIAL_CAPABILITY_NOT_AUTHORIZED" };
  const profile = portalCatalogProfile(portal);
  if (profile.knownTedService && !profile.capabilities.includes(required))
    return { eligible:false, code:"CREDENTIAL_CAPABILITY_NOT_AUTHORIZED" };
  return { eligible:true, code:null, requiredCapability:required };
}
