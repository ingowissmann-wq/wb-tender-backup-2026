import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";

import {parseBinaryDocument, extractArchiveDocuments} from "../platform/binary-parsers.mjs";
import {deriveCleaningRoomBookFacts} from "../platform/cleaning-room-book.mjs";

const verifiedDocument = parsed => ({
  id: `document-${parsed.type}`,
  filename: parsed.name,
  payload_sha256: parsed.sha256,
  procurement_verification_status: "VERIFIED",
  extracted_data: parsed,
});

const hasAutomaticCleaningQuantity = facts => facts.some(fact => [
  "annual_cleaning_area_occurrences",
  "areas",
  "productive_hours",
  "productive_hours_per_year",
].includes(fact.key));

test("CSV is parsed with exact cells but cannot silently become a Cleaning quantity", async () => {
  const parsed = await parseBinaryDocument({
    buffer: Buffer.from("Los;Fläche;Tage/Jahr\nLOT-0001;100;250\n"),
    name: "Los-1-Reinigungsflaechen.csv",
    mediaType: "text/csv",
  });
  assert.equal(parsed.type, "CSV");
  assert.equal(parsed.rows[1][1].value, "100");
  assert.equal(hasAutomaticCleaningQuantity(deriveCleaningRoomBookFacts([verifiedDocument(parsed)], "LOT-0001")), false);
});

test("DOCX tables are retained but need a versioned Cleaning rule before calculation", async () => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Fläche</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>100</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`);
  const parsed = await parseBinaryDocument({
    buffer: await zip.generateAsync({type: "nodebuffer"}),
    name: "Los-1-Reinigungsdaten.docx",
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  assert.deepEqual(parsed.tables[0][0], ["Fläche", "100"]);
  assert.equal(hasAutomaticCleaningQuantity(deriveCleaningRoomBookFacts([verifiedDocument(parsed)], "LOT-0001")), false);
});

test("generic XML and GAEB quantities cannot be reinterpreted as Cleaning area or hours", async () => {
  const xml = await parseBinaryDocument({
    buffer: Buffer.from("<?xml version=\"1.0\"?><Cleaning><Area unit=\"m2\">100</Area></Cleaning>"),
    name: "cleaning.xml",
    mediaType: "application/xml",
  });
  const gaeb = await parseBinaryDocument({
    buffer: Buffer.from("<?xml version=\"1.0\"?><GAEB><BoQ><BoQBody><Item><RNoPart>01</RNoPart><Qty>100</Qty><QU>m2</QU><BriefDescr>Reinigung</BriefDescr></Item></BoQBody></BoQ></GAEB>"),
    name: "cleaning.x83",
    mediaType: "application/xml",
  });
  assert.equal(xml.type, "XML");
  assert.equal(gaeb.gaeb.items[0].quantity, "100");
  assert.equal(hasAutomaticCleaningQuantity(deriveCleaningRoomBookFacts([
    verifiedDocument(xml), verifiedDocument(gaeb),
  ], "LOT-0001")), false);
});

test("archive children retain their path but unsupported tabular content remains non-calculating", async () => {
  const archive = new JSZip();
  archive.file("Los 1/Reinigungsflaechen.csv", "Fläche;Tage/Jahr\n100;250\n");
  const children = await extractArchiveDocuments(await archive.generateAsync({type: "nodebuffer"}));
  assert.equal(children.length, 1);
  assert.equal(children[0].archivePath, "Los 1/Reinigungsflaechen.csv");
  const parsed = await parseBinaryDocument({
    buffer: children[0].buffer,
    name: children[0].name,
    mediaType: children[0].mediaType,
  });
  assert.equal(hasAutomaticCleaningQuantity(deriveCleaningRoomBookFacts([verifiedDocument(parsed)], "LOT-0001")), false);
});
