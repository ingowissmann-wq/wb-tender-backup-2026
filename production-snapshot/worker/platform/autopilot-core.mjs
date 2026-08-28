import crypto from "node:crypto";

export const SERVICE_LINES = Object.freeze(["CLEANING","SECURITY","FACILITY","SECURITY_TECHNOLOGY","EMERGENCY_SERVICES"]);
export const CONNECTOR_MODES = Object.freeze(["DISABLED","TEST","REPLAY","CONTROLLED_READ","PRODUCTION_READ"]);
export const PORTAL_MODES = Object.freeze(["DISABLED","MOCK","TEST","CONTROLLED_READ","PRODUCTION_READ","PREPARE_WRITE","APPROVED_WRITE"]);
export const EXTERNAL_ACTIONS = Object.freeze(["BIDDER_QUESTION","PRICE_TRANSMISSION","DOCUMENT_UPLOAD","BID_SUBMISSION","ELECTRONIC_DECLARATION","SIGNATURE","CONTRACT_CONFIRMATION"]);
export const sha256 = (value) => {
  const serialized = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return crypto.createHash("sha256").update(serialized).digest("hex");
};

const words = (value) => String(value || "").toLocaleLowerCase("de-DE");
export function normalizeTender(source) {
  if (!source?.sourceCode || !source?.externalId || !source?.title || !source?.buyer || !source?.sourceUrl)
    throw new Error("source_fields_missing");
  return {
    sourceCode: String(source.sourceCode).toUpperCase(),
    externalId: String(source.externalId),
    title: String(source.title).trim(),
    buyer: String(source.buyer).trim(),
    description: String(source.description || ""),
    cpvCodes: [...new Set(source.cpvCodes || [])],
    regions: [...new Set(source.regions || [])],
    lots: source.lots || [],
    deadlines: source.deadlines || {},
    sourceUrl: String(source.sourceUrl),
    rawSha256: sha256(source.raw ?? source),
  };
}

export function detectChange(previous, current) {
  if (!previous) return {kind:"INITIAL",changed:["all"]};
  const fields = ["title","buyer","description","cpvCodes","regions","lots","deadlines"];
  const changed = fields.filter((field) => sha256(previous[field]) !== sha256(current[field]));
  const kind = changed.some((x) => x === "deadlines") ? "DEADLINE_CHANGE"
    : changed.some((x) => x === "lots") ? "LOT_CHANGE"
    : changed.length ? "CORRECTION" : "UNCHANGED";
  return {kind,changed};
}

export function matchTender(tender, rule) {
  const haystack = words(`${tender.title} ${tender.description} ${tender.buyer}`);
  const cpv = (tender.cpvCodes || []).some((code) => (rule.cpvCodes || []).some((prefix) => String(code).startsWith(prefix)));
  const keywordHits = (rule.keywords || []).filter((x) => haystack.includes(words(x)));
  const synonymHits = (rule.synonyms || []).filter((x) => haystack.includes(words(x)));
  const exclusions = (rule.exclusions || []).filter((x) => haystack.includes(words(x)));
  const ruleScore = exclusions.length ? 0 : Math.min(100, (cpv ? 55 : 0) + keywordHits.length * 15 + synonymHits.length * 8);
  return {serviceLine:rule.serviceLine,ruleScore,cpv,keywordHits,synonymHits,exclusions,explanation:{cpv,keywordHits,synonymHits,exclusions}};
}

export function evaluateGoNoGo(input, config) {
  const missing = (config.requiredFields || []).filter((key) => input[key] === undefined || input[key] === null || input[key] === "");
  const failedGates = (config.hardGates || []).filter((gate) => !gate.test(input)).map((gate) => gate.code);
  const weighted = Object.entries(config.weights || {}).reduce((sum,[key,weight]) => sum + Number(input.scores?.[key] || 0) * Number(weight),0);
  let recommendation = failedGates.length ? "NO_GO" : missing.length ? "NOT_ASSESSABLE"
    : weighted >= config.thresholds.go ? "GO"
    : weighted >= config.thresholds.conditional ? "GO_CONDITIONAL" : "NO_GO";
  return {recommendation,weightedScore:weighted,failedGates,missingInformation:missing,explanation:{weights:config.weights,thresholds:config.thresholds}};
}

export function boardBrief(tender,decision) {
  return {
    tenderId:tender.id,title:tender.title,buyer:tender.buyer,deadline:tender.offerDeadline,
    recommendation:decision.recommendation,score:decision.weightedScore,
    hardGates:decision.failedGates,missingInformation:decision.missingInformation,
    generatedAt:new Date().toISOString(),binding:false,
  };
}

export function validateConnectorConfig(config) {
  if (!CONNECTOR_MODES.includes(config.mode)) throw new Error("connector_mode_invalid");
  if (["CONTROLLED_READ","PRODUCTION_READ"].includes(config.mode) && !config.officialBaseUrl) throw new Error("official_url_required");
  if (config.writeEnabled) throw new Error("connector_write_forbidden");
  return {...config,writeEnabled:false};
}
