import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const migration=readFileSync(new URL("../migrations/127_authoritative_pipeline_enrichment_binding.sql",import.meta.url),"utf8");
const rollback=readFileSync(new URL("../migrations/127_authoritative_pipeline_enrichment_binding.down.sql",import.meta.url),"utf8");

test("binding backfill requires active canonical company-lot identity and authoritative evidence",()=>{
  assert.match(migration,/tender\.source_lifecycle_status='ACTIVE'/);
  assert.match(migration,/scope\.profile_id=company\.tender_profile_id/);
  assert.match(migration,/lot\.tender_id=context\.tender_id AND lot\.external_id=context\.lot_key/);
  assert.match(migration,/relevance\.relevance_status='RELEVANT'/);
  assert.match(migration,/selection\.source_lot_id=context\.lot_key/);
  assert.match(migration,/candidate\.payload_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/);
});

test("backfill never guesses, deletes, submits or weakens rollback data",()=>{
  assert.doesNotMatch(migration,/COALESCE\([^\n]*(?:lot_id|source_lot_id)/i);
  assert.doesNotMatch(migration,/\bDELETE FROM tender\./i);
  assert.match(migration,/external_submission_enabled',false/);
  assert.doesNotMatch(rollback,/\bDELETE FROM tender\./i);
  assert.doesNotMatch(rollback,/DROP (?:COLUMN|TABLE)/i);
});
