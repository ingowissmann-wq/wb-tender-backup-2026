import test from "node:test";
import assert from "node:assert/strict";

import {
  declaredDocumentLotNumbers,
  deriveCleaningRoomBookFacts,
  derivePriceSheetCleaningFacts,
  priceSheetForSelectedLot,
  selectLotAuthoritativeDocuments,
} from "../platform/cleaning-room-book.mjs";

const cell = (address, column, value, formula = null) => ({
  address,
  column,
  value: formula ? null : String(value),
  displayed: String(value),
  result: formula ? String(value) : null,
  formula,
});

const workbook = ({ id, lot = 1, revision = "20260825", hash, rows }) => ({
  id,
  lot_id: "shared-enrichment-lot-id",
  filename: `110-26_Los ${lot} - Preisblatt${revision ? ` ${revision}` : ""}.XLSX`,
  payload_sha256: hash,
  procurement_verification_status: "VERIFIED",
  provenance: { lotBindingSource: "SINGLE_SELECTED_LOT", lotKey: "LOT-0005" },
  extracted_data: {
    worksheets: [{
      name: "P4, Aufmaß",
      rows: [
        { rowNumber: 5, cells: [cell("A5", 1, `Preisblatt der Vergabestelle (Los ${lot})`)] },
        { rowNumber: 8, cells: [
          cell("E8", 5, "Fläche in m²"),
          cell("G8", 7, "Tage/Jahr"),
          cell("H8", 8, "Fläche in m² pro Jahr"),
        ] },
        ...rows.map(({ rowNumber, area, days }) => ({
          rowNumber,
          cells: [
            cell(`E${rowNumber}`, 5, area),
            cell(`G${rowNumber}`, 7, days),
            cell(
              `H${rowNumber}`,
              8,
              area * days,
              'IF(Tabelle1[[#This Row],[Tage/Jahr]]>0,Tabelle1[[#This Row],[Fläche in m²]]*Tabelle1[[#This Row],[Tage/Jahr]],"")',
            ),
          ],
        })),
      ],
    }],
  },
});

test("price-sheet cleaning facts use the newest exact self-declared lot workbook only", () => {
  const current = workbook({
      id: "current-los-1",
      hash: "hash-current-los-1",
      rows: [
        { rowNumber: 9, area: 100, days: 52 },
        { rowNumber: 10, area: 50, days: 248 },
      ],
    }),
    old = workbook({
      id: "old-los-1",
      revision: "",
      hash: "hash-old-los-1",
      rows: [{ rowNumber: 9, area: 999, days: 248 }],
    }),
    otherLot = workbook({
      id: "current-los-2",
      lot: 2,
      hash: "hash-current-los-2",
      rows: [{ rowNumber: 9, area: 5000, days: 248 }],
    }),
    documents = [current, old, otherLot];

  assert.deepEqual(declaredDocumentLotNumbers(current), [1]);
  const authoritative = selectLotAuthoritativeDocuments(
    documents,
    new Set(["actual-selected-los-1-enrichment-id"]),
    "LOT-0001",
  );
  assert.deepEqual(authoritative.map(document => document.id), ["current-los-1", "old-los-1"]);

  assert.equal(priceSheetForSelectedLot(authoritative, "LOT-0001")?.id, "current-los-1");
  assert.notDeepEqual(derivePriceSheetCleaningFacts(authoritative, "LOT-0001"), []);
  const facts = deriveCleaningRoomBookFacts(authoritative, "LOT-0001");
  const annual = facts.find(fact => fact.key === "annual_cleaning_area_occurrences");
  const area = facts.find(fact => fact.key === "areas");
  assert.equal(annual.value, 17600);
  assert.equal(area.value, 150);
  assert.equal(annual.evidence[0].documentId, "current-los-1");
  assert.equal(annual.evidence[0].includedRows, 2);
  assert.equal(annual.evidence[0].selectedLotKey, "LOT-0001");
});

test("a shared technical lot id cannot admit an explicitly different lot", () => {
  const wrong = workbook({
    id: "wrong",
    lot: 5,
    hash: "wrong-hash",
    rows: [{ rowNumber: 9, area: 100, days: 248 }],
  });
  assert.deepEqual(
    selectLotAuthoritativeDocuments(
      [wrong],
      new Set(["shared-enrichment-lot-id"]),
      "LOT-0001",
    ),
    [],
  );
  assert.equal(
    deriveCleaningRoomBookFacts([wrong], "LOT-0001")
      .some(fact => fact.key === "annual_cleaning_area_occurrences"),
    false,
  );
});

test("same-revision price-sheet ambiguity fails closed", () => {
  const left = workbook({
      id: "left",
      hash: "left-hash",
      rows: [{ rowNumber: 9, area: 100, days: 52 }],
    }),
    right = workbook({
      id: "right",
      hash: "right-hash",
      rows: [{ rowNumber: 9, area: 200, days: 52 }],
    });
  const facts = deriveCleaningRoomBookFacts([left, right], "LOT-0001");
  assert.equal(facts.some(fact => fact.key === "annual_cleaning_area_occurrences"), false);
});

test("invalid cached annual-area formulas are rejected", () => {
  const invalid = workbook({
    id: "invalid",
    hash: "invalid-hash",
    rows: [{ rowNumber: 9, area: 100, days: 52 }],
  });
  invalid.extracted_data.worksheets[0].rows[2].cells[2].result = "999999";
  invalid.extracted_data.worksheets[0].rows[2].cells[2].displayed = "999999";
  assert.equal(
    deriveCleaningRoomBookFacts([invalid], "LOT-0001")
      .some(fact => fact.key === "annual_cleaning_area_occurrences"),
    false,
  );
});
