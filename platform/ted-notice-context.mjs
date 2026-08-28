import crypto from "node:crypto";

const safeHttps = (value) => {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
};

const unique = (items) => [...new Map(items.filter((item) => item?.url).map((item) => [`${item.role}:${item.url}`, item])).values()];

export const canonicalTedNoticeId = (value) => {
  const id = String(value || "").trim();
  return /^\d{6}-\d{4}$/.test(id) ? id : null;
};

export function officialTedLinks(noticeId, language = "de") {
  const id = canonicalTedNoticeId(noticeId);
  if (!id) return [];
  const base = `https://ted.europa.eu/${language}/notice/${id}`;
  return [
    { url: `${base}/xml`, role: "NOTICE", format: "XML", publicAccess: true },
    { url: `${base}/pdf`, role: "PUBLIC_DOCUMENT", format: "PDF", publicAccess: true },
    { url: `${base}/html`, role: "NOTICE", format: "HTML", publicAccess: true },
    { url: `https://ted.europa.eu/${language}/notice/-/detail/${id}`, role: "NOTICE_VIEW", format: "HTML_VIEW", publicAccess: true },
  ];
}

export function classifyTedUriEvidence(entries = [], { publicationHost = "ted.europa.eu" } = {}) {
  return unique(entries.map((entry) => {
    const url = safeHttps(entry?.url);
    if (!url) return null;
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""), path = String(entry?.path || "");
    let role = "UNKNOWN_REVIEW_REQUIRED";
    if (host === publicationHost && /\/notice\//i.test(new URL(url).pathname)) role = "NOTICE";
    else if (/CallForTendersDocumentReference|TenderingTerms.*DocumentReference/i.test(path)) role = "PROCUREMENT_DOCUMENT";
    else if (/ContractingParty|Buyer|Organization/i.test(path)) role = "BUYER_COMMUNICATION";
    return { url, role, sourcePath: path || null, publicAccess: role === "NOTICE" || role === "PROCUREMENT_DOCUMENT" };
  }));
}

export function tedAccountEvidence() {
  return {
    provider: "TED / EU Login",
    login: "https://ted.europa.eu/en/login",
    registration: "https://ecas.ec.europa.eu/cas/eim/external/register.cgi",
    help: "https://ted.europa.eu/en/help/ted-account",
    scope: ["SAVED_SEARCHES", "ALERTS", "ACCOUNT_PREFERENCES"],
    procurementSubmissionPortal: false,
  };
}

export const linkManifestSha256 = (links) => crypto.createHash("sha256").update(JSON.stringify(
  [...(links || [])].map(({ url, role, format, sourcePath, publicAccess }) => ({ url, role, format: format || null, sourcePath: sourcePath || null, publicAccess: Boolean(publicAccess) }))
    .sort((a, b) => `${a.role}:${a.url}`.localeCompare(`${b.role}:${b.url}`)),
)).digest("hex");

export function resolveLotChoice({ requestedLotKey = "", storedLotKey = "", eligibleLots = [] } = {}) {
  const eligible = eligibleLots.filter((lot) => lot?.participation_status === "ELIGIBLE" && lot?.lifecycle_status === "ACTIVE" && lot?.deadline_quality === "EXACT" && lot?.offer_deadline && new Date(lot.offer_deadline) > new Date());
  const requested = requestedLotKey && eligible.find((lot) => String(lot.lot_key) === String(requestedLotKey));
  if (requested) return { lot: requested, source: "EXPLICIT_SELECTION", selectionRequired: false };
  if (requestedLotKey) return { lot: null, source: "INVALID_REQUESTED_LOT", selectionRequired: true };
  const stored = storedLotKey && eligible.find((lot) => String(lot.lot_key) === String(storedLotKey));
  if (stored) return { lot: stored, source: "STORED_SELECTION", selectionRequired: false };
  if (eligible.length === 1) return { lot: eligible[0], source: "SINGLE_ELIGIBLE_LOT", selectionRequired: false };
  return { lot: null, source: eligible.length > 1 ? "MULTIPLE_ELIGIBLE_LOTS" : "NO_ELIGIBLE_LOT", selectionRequired: eligible.length > 1 };
}
