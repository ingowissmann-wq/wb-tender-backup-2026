import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const script=fs.readFileSync(new URL("../scripts/repair-ted-munich-contexts.mjs",import.meta.url),"utf8");
test("TED Munich repair is exact, official-source hash bound and submission inert",()=>{
  for(const value of ["472413-2026","540350-2026","552392-2026","ted_munich_plan_hash_mismatch","BEGIN ISOLATION LEVEL SERIALIZABLE",
    "https://ted.europa.eu/en/notice/","vergabe.muenchen.de","PROCUREMENT_DOCUMENT","DOCUMENT_PORTAL","externalSubmission:false","transmitted:false"])
    assert.ok(script.includes(value),value);
  assert.doesNotMatch(script,/INSERT INTO tender\.(autopilot_queue|submission_contexts|submission_attempts)/);
});
test("single lots require explicit selection while multi-lot contexts remain tender-global",()=>{
  assert.match(script,/single_lot_selection_missing/);
  assert.match(script,/unexpected_multi_lot_selection/);
  assert.match(script,/canonicalLots\.length===1\?"CANONICAL":"TENDER_GLOBAL"/);
  assert.doesNotMatch(script,/LOT-0000.*selectedLotKey|selectedLotKey.*LOT-0000/);
});
