import fs from "node:fs/promises";

import {
  deriveCleaningRoomBookFacts,
  selectLotAuthoritativeDocuments,
} from "../platform/cleaning-room-book.mjs";

const [documentsPath, fieldsPath, selectedEnrichmentLotId] = process.argv.slice(2);
if (!documentsPath || !fieldsPath || !selectedEnrichmentLotId)
  throw new Error("usage: isolated-blka-input-forensics.mjs DOCUMENTS_JSON FIELDS_JSON SELECTED_ENRICHMENT_LOT_ID");

const [documents, fields] = await Promise.all([
  fs.readFile(documentsPath, "utf8").then(JSON.parse),
  fs.readFile(fieldsPath, "utf8").then(JSON.parse),
]);

if (!Array.isArray(documents) || documents.length < 55)
  throw new Error(`verified BLKA document set is incomplete: ${documents?.length ?? "invalid"}`);
if (!Array.isArray(fields)) throw new Error("BLKA enrichment fields are invalid");
if (documents.some(document => document.procurement_verification_status !== "VERIFIED"))
  throw new Error("unverified document entered BLKA forensics");

const authoritative = selectLotAuthoritativeDocuments(
  documents,
  new Set([selectedEnrichmentLotId]),
  "LOT-0001",
);
if (!authoritative.length) throw new Error("no authoritative BLKA LOT-0001 documents");

const facts = deriveCleaningRoomBookFacts(authoritative, "LOT-0001");
const annualArea = facts.find(item => item.key === "annual_cleaning_area_occurrences");
const sourceArea = facts.find(item => item.key === "areas");
const contractDuration = facts.find(item => item.key === "contract_duration_months");
if (annualArea?.value !== 2589414.889362)
  throw new Error(`BLKA annual cleaning area mismatch: ${annualArea?.value ?? "missing"}`);
if (sourceArea?.value !== 29142.6877)
  throw new Error(`BLKA source area mismatch: ${sourceArea?.value ?? "missing"}`);
if (!annualArea.evidence?.length) throw new Error("BLKA annual-area provenance is missing");

const patterns = Object.freeze({
  performance: /(?:reinigungs(?:leistung|leistungswert)|leistungswert|leistungszahl|m(?:²|2)\s*(?:\/|pro)\s*(?:h|std\.?|stunde)|qm\s*(?:\/|pro)\s*(?:h|std\.?|stunde))/i,
  productiveHours: /(?:produktiv(?:e|en|er)?\s*stund|reinigungsstund|jahresstund|stundenansatz|leistungsstund)/i,
  duration: /(?:vertrags(?:laufzeit|dauer|beginn|ende)|leistungs(?:beginn|ende|zeitraum)|laufzeit\s+(?:des\s+)?vertrags)/i,
});

const compact = value => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
const cellText = cell => compact(cell?.displayed ?? cell?.result ?? cell?.value);
const candidates = Object.fromEntries(Object.keys(patterns).map(key => [key, []]));
const seen = new Set();
const add = (kind, document, location, text) => {
  const normalized = compact(text);
  if (!normalized || !patterns[kind].test(normalized)) return;
  const identity = `${kind}|${document.id}|${location}|${normalized}`;
  if (seen.has(identity) || candidates[kind].length >= 120) return;
  seen.add(identity);
  candidates[kind].push({
    documentId: document.id,
    filename: document.filename,
    sha256: document.payload_sha256,
    location,
    text: normalized.slice(0, 700),
  });
};

for (const document of authoritative) {
  for (const page of document.extracted_data?.pages || [])
    for (const kind of Object.keys(patterns))
      add(kind, document, `page:${page.pageNumber ?? "?"}`, page.text);

  for (const sheet of document.extracted_data?.worksheets || [])
    for (const row of sheet.rows || []) {
      const text = (row.cells || []).map(cellText).filter(Boolean).join(" | ");
      for (const kind of Object.keys(patterns))
        add(kind, document, `sheet:${sheet.name ?? "?"}:row:${row.rowNumber ?? "?"}`, text);
    }
}

const fieldCandidates = fields
  .filter(field => /(?:hour|stund|duration|contract|area|fläche|leistung)/i.test(
    `${field.field_key ?? ""} ${JSON.stringify(field.value ?? "")}`,
  ))
  .slice(0, 160)
  .map(field => ({
    id: field.id,
    fieldKey: field.field_key,
    value: field.value,
    qualityStatus: field.quality_status,
    parser: field.provenance?.parser ?? null,
    selectedLotId: field.provenance?.selectedLotId ?? null,
    sourceDocumentId: field.provenance?.documentId ?? field.provenance?.sourceDocumentId ?? null,
  }));

const result = {
  mode: "READ_ONLY_BLKA_INPUT_FORENSICS",
  scope: {
    externalId: "514707-2026",
    tenderId: "06e91129-00c0-4820-9fbe-087e3517ce80",
    companyId: "15c3c602-aa51-4dd4-adc1-3586dc82e523",
    lotKey: "LOT-0001",
    lotId: "50479867-5774-4db4-bdef-b93a7d0eb88f",
    enrichmentVersionId: "5e885f85-c63e-47c8-ac5e-ab6770f9d446",
  },
  evidence: {
    inputDocuments: documents.length,
    authoritativeDocuments: authoritative.length,
    annualCleaningArea: annualArea.value,
    annualCleaningAreaUnit: annualArea.unit,
    sourceArea: sourceArea.value,
    sourceAreaUnit: sourceArea.unit,
    annualAreaEvidence: annualArea.evidence,
    contractDuration: contractDuration?.value ?? null,
    contractDurationUnit: contractDuration?.unit ?? null,
    contractDurationEvidence: contractDuration?.evidence ?? [],
    performanceCandidates: candidates.performance,
    productiveHoursCandidates: candidates.productiveHours,
    durationCandidates: candidates.duration,
    fieldCandidates,
  },
  gate: {
    C22Persistence: "NONE",
    C23: 1670,
    C23Unit: "HOURS_PER_YEAR",
    C11: 0.5,
    C11Unit: "EUR_PER_HOUR",
    status: candidates.performance.length
      ? "C22_SOURCE_CANDIDATES_REQUIRE_EXACT_REVIEW"
      : "CALCULATION_BLOCKED_MISSING_INPUT_C22",
    calculationExecuted: false,
    externalWrite: false,
    externalTransmission: false,
  },
};

console.log(JSON.stringify(result));
