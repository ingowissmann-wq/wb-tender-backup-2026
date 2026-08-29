import assert from "node:assert/strict";
import test from "node:test";

import { deriveCleaningRoomBookFacts } from "../platform/cleaning-room-book.mjs";

const workbook = {
  id: "grouped-price-sheet",
  filename: "20260829_Los 1 - Preisblatt.xlsx",
  payload_sha256: "a".repeat(64),
  procurement_verification_status: "VERIFIED",
  extracted_data: { worksheets: [{
    name: "P4, Aufmaß",
    rows: [
      { rowNumber: 1, cells: [{ address: "A1", value: "Los 1" }] },
      { rowNumber: 8, cells: [
        { address: "E8", value: "Fläche in m2" },
        { address: "F8", value: "Reinigungsgruppe" },
        { address: "G8", value: "Tage/Jahr" },
        { address: "H8", value: "Fläche in m2 pro Jahr" },
        { address: "I8", value: "m2/Stunde" },
        { address: "J8", value: "Stunde/Jahr" },
      ] },
      { rowNumber: 9, cells: [
        { address: "E9", value: 100 }, { address: "F9", value: "A" },
        { address: "G9", value: 200 },
        { address: "H9", result: 20000, formula: "Fläche in m² * Tage/Jahr" },
        { address: "I9", value: 200 }, { address: "J9", result: 100 },
      ] },
      { rowNumber: 10, cells: [
        { address: "E10", value: 50 }, { address: "F10", value: "C" },
        { address: "G10", value: 100 },
        { address: "H10", result: 5000, formula: "Fläche in m² * Tage/Jahr" },
        { address: "I10", value: null }, { address: "J10", value: null },
      ] },
    ],
  }] },
};

test("price-sheet facts preserve annual cleaning area by exact cleaning group", () => {
  const facts = deriveCleaningRoomBookFacts([workbook], "LOT-0001");
  assert.equal(facts.find(item => item.key === "annual_cleaning_area_occurrences").value, 25000);
  assert.deepEqual(facts.find(item => item.key === "annual_cleaning_area_by_group").value, [
    { group: "A", sourceArea: 100, annualCleaningArea: 20000, rows: 1 },
    { group: "C", sourceArea: 50, annualCleaningArea: 5000, rows: 1 },
  ]);
  assert.deepEqual(facts.find(item => item.key === "price_sheet_productivity_inventory").value, [
    { group: "A", rows: 1, rowsWithPerformance: 1, rowsWithAnnualHours: 1,
      rowsWithConsistentPerformanceHours: 1, performanceValues: [200], annualHours: 100 },
    { group: "C", rows: 1, rowsWithPerformance: 0, rowsWithAnnualHours: 0,
      rowsWithConsistentPerformanceHours: 0, performanceValues: [], annualHours: 0 },
  ]);
});

test("verified explicit initial contract period excludes extension options from base duration", () => {
  const contract = {
    id: "contract",
    filename: "Los 1 - Vertrag.pdf",
    payload_sha256: "b".repeat(64),
    procurement_verification_status: "VERIFIED",
    extracted_data: { pages: [{ pageNumber: 9, text:
      "Vertragsdauer Der Vertrag beginnt am 01.05.2027 und endet am 30.04.2029. " +
      "Er verlängert sich optional. Der Vertrag endet spätestens mit Ablauf des 30.04.2032.",
    }] },
  };
  const facts = deriveCleaningRoomBookFacts([contract], "LOT-0001");
  assert.equal(facts.find(item => item.key === "contract_duration_months").value, 24);
  assert.equal(facts.find(item => item.key === "contract_maximum_duration_months").value, 60);
});
