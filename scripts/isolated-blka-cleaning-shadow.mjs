import fs from "node:fs/promises";

import {
  declaredDocumentLotNumbers,
  deriveCleaningRoomBookFacts,
  priceSheetForSelectedLot,
  selectLotAuthoritativeDocuments,
} from "../platform/cleaning-room-book.mjs";

const [jsonPath, selectedEnrichmentLotId] = process.argv.slice(2);
if (!jsonPath || !selectedEnrichmentLotId)
  throw new Error("usage: isolated-blka-cleaning-shadow.mjs DOCUMENTS_JSON SELECTED_ENRICHMENT_LOT_ID");

const documents = JSON.parse(await fs.readFile(jsonPath, "utf8"));
if (!Array.isArray(documents) || documents.length < 2)
  throw new Error("BLKA verified price-sheet set is incomplete");

const authoritative = selectLotAuthoritativeDocuments(
  documents,
  new Set([selectedEnrichmentLotId]),
  "LOT-0001",
);
if (!authoritative.length)
  throw new Error("no exact LOT-0001 workbook survived authoritative selection");
if (authoritative.some(document => {
  const declared = declaredDocumentLotNumbers(document);
  return declared.length !== 1 || declared[0] !== 1;
}))
  throw new Error("cross-lot workbook survived LOT-0001 selection");

const preferred = priceSheetForSelectedLot(authoritative, "LOT-0001");
if (preferred?.id !== "88596379-a007-4913-b26a-42cfe2b72309")
  throw new Error(`unexpected BLKA price sheet: ${preferred?.id || "none"}`);
if (preferred.payload_sha256 !== "ae5a386fd253bbe209b79066137bc399ce58bc0ba34e9c5478cfb37b89f16822")
  throw new Error("BLKA price-sheet hash mismatch");

const facts = deriveCleaningRoomBookFacts(authoritative, "LOT-0001"),
  annual = facts.find(fact => fact.key === "annual_cleaning_area_occurrences"),
  area = facts.find(fact => fact.key === "areas");
if (annual?.value !== 2589414.889362)
  throw new Error(`annual cleaning area mismatch: ${annual?.value ?? "missing"}`);
if (area?.value !== 29142.6877)
  throw new Error(`source area mismatch: ${area?.value ?? "missing"}`);
if (annual.evidence?.[0]?.documentId !== preferred.id ||
    annual.evidence?.[0]?.cachedFormulaResultsVerified !== true)
  throw new Error("BLKA formula-cache provenance is incomplete");

console.log(JSON.stringify({
  mode: "READ_ONLY_CLEANING_SHADOW",
  selectedLotKey: "LOT-0001",
  inputDocuments: documents.length,
  authoritativeDocuments: authoritative.map(document => ({
    id: document.id,
    filename: document.filename,
    declaredLots: declaredDocumentLotNumbers(document),
  })),
  preferredDocument: {
    id: preferred.id,
    filename: preferred.filename,
    sha256: preferred.payload_sha256,
  },
  annualCleaningArea: annual.value,
  annualCleaningAreaUnit: annual.unit,
  sourceArea: area.value,
  sourceAreaUnit: area.unit,
  includedRows: annual.evidence[0].includedRows,
  firstIncludedRow: annual.evidence[0].firstIncludedRow,
  lastIncludedRow: annual.evidence[0].lastIncludedRow,
  externalWrite: false,
}));
