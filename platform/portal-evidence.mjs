import crypto from "node:crypto";

const SENSITIVE_PARAMETER = /^(?:access_?token|auth(?:entication|orization)?|bearer|code|credential|id_?token|jwt|key|password|refresh_?token|secret|session(?:id)?|sid|ticket|token)$/i;
const SOURCE_HOSTS = new Set(["ted.europa.eu", "api.ted.europa.eu", "oeffentlichevergabe.de", "www.oeffentlichevergabe.de"]);

export const normalizeHost = (value) => String(value || "").trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");

export function safeEvidenceUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (/;jsessionid=/i.test(url.pathname)) return null;
    for (const key of url.searchParams.keys()) if (SENSITIVE_PARAMETER.test(key)) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

const roleForPath = (path) => {
  const key = path.toLowerCase();
  if (/(?:submission|submit|electronic.?offer|tendering.?procedure)/.test(key)) return { role: "SUBMISSION", priority: 1 };
  if (/(?:participat|procurement.?url|tender.?url|buyer.?profile|communication)/.test(key)) return { role: "PARTICIPATION", priority: 2 };
  if (/(?:documents?|attachments?|download|specification)/.test(key)) return { role: "PROCUREMENT_DOCUMENT", priority: 3 };
  if (/(?:registration|register)/.test(key)) return { role: "REGISTRATION", priority: 4 };
  if (/(?:login|sign.?in|authentication)/.test(key)) return { role: "LOGIN", priority: 4 };
  if (/(?:notice|publication|source.?url|\buri\b)/.test(key)) return { role: "NOTICE", priority: 6 };
  return { role: "UNKNOWN_REVIEW_REQUIRED", priority: 5 };
};

export function extractStructuredUrlEvidence(value, path = "$") {
  const found = [];
  const visit = (item, itemPath) => {
    if (typeof item === "string") {
      const url = safeEvidenceUrl(item);
      if (url) found.push({ url, path: itemPath, ...roleForPath(itemPath) });
      return;
    }
    if (Array.isArray(item)) return item.forEach((entry, index) => visit(entry, `${itemPath}[${index}]`));
    if (item && typeof item === "object") for (const [key, entry] of Object.entries(item)) visit(entry, `${itemPath}.${key}`);
  };
  visit(value, path);
  const unique = new Map();
  for (const item of found) {
    const current = unique.get(item.url);
    if (!current || item.priority < current.priority) unique.set(item.url, item);
  }
  return [...unique.values()];
}

export function portalDomains(portal) {
  return [portal.canonical_domain, ...(portal.allowed_subdomains || []), ...(portal.authentication_domains || []), ...(portal.download_domains || [])]
    .map(normalizeHost).filter(Boolean);
}

export function portalForHost(host, portals = []) {
  const normalized = normalizeHost(host), matches = portals.filter((portal) => portalDomains(portal).includes(normalized));
  return matches.length === 1 ? matches[0] : null;
}

export function resolvePortalEvidence({ sourceCode, sourceUrl, normalizedData, portals = [], persistedLinks = [] }) {
  const sourceHost = (() => { try { return normalizeHost(new URL(sourceUrl).hostname); } catch { return null; } })();
  const extracted = extractStructuredUrlEvidence(normalizedData);
  const links = [...extracted, ...persistedLinks.map((link) => ({
    url: safeEvidenceUrl(link.original_url || link.url), role: link.role || "UNKNOWN_REVIEW_REQUIRED",
    priority: ["SUBMISSION"].includes(link.role) ? 1 : ["PARTICIPATION", "BUYER_COMMUNICATION"].includes(link.role) ? 2 : ["PUBLIC_DOCUMENT", "PROCUREMENT_DOCUMENT"].includes(link.role) ? 3 : 5,
    path: link.evidence?.xmlPath || "$.persistedEvidence",
  }))].filter((link) => link.url && link.role !== "UNKNOWN_REVIEW_REQUIRED" && link.priority <= 4);
  const candidates = [];
  for (const link of links) {
    const host = normalizeHost(new URL(link.url).hostname);
    if (SOURCE_HOSTS.has(host) || host === sourceHost) continue;
    const portal = portalForHost(host, portals);
    if (portal) candidates.push({ ...link, host, portal });
  }
  const bestPriority = candidates.length ? Math.min(...candidates.map((item) => item.priority)) : null,
    best = candidates.filter((item) => item.priority === bestPriority),
    portalIds = [...new Set(best.map((item) => String(item.portal.id)))],
    chosen = portalIds.length === 1 ? best.find((item) => String(item.portal.id) === portalIds[0]) : null,
    status = chosen ? "UNIQUE_EVIDENCE" : portalIds.length > 1 ? "REVIEW_REQUIRED" : "NOT_FOUND";
  const manifest = links.map(({ url, role, priority, path: evidencePath }) => ({ url, role, priority, evidencePath })).sort((a,b)=>a.url.localeCompare(b.url));
  const evidenceSha256 = crypto.createHash("sha256").update(JSON.stringify({ sourceCode, sourceUrl, manifest, status, portalIds })).digest("hex");
  return { status, portal: chosen?.portal || null, portalLink: chosen || null, candidates: best, links: manifest, evidenceSha256 };
}
