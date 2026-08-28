import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
const up=fs.readFileSync(new URL("../migrations/149_superseded_relevance_context_truth.sql",import.meta.url),"utf8");
const down=fs.readFileSync(new URL("../migrations/149_superseded_relevance_context_truth.down.sql",import.meta.url),"utf8");
test("authoritatively excluded lots become terminal without invented bindings",()=>{
  assert.match(up,/SUPERSEDED_RELEVANCE/);
  assert.match(up,/CURRENT_RELEVANCE_EXCLUDES_CONTEXT/);
  assert.match(up,/relevance_status IN\('EXCLUDED','NOT_APPLICABLE'\)/);
  assert.match(up,/NOT EXISTS\(SELECT 1 FROM tender\.tender_lot_selections/);
  assert.match(up,/'externalSubmission',false/);
  assert.doesNotMatch(up,/\b(?:DELETE|TRUNCATE)\s+(?:FROM\s+)?tender\.pipeline_contexts/i);
});
test("rollback restores fail-closed repair semantics without deleting context evidence",()=>{
  assert.match(down,/context_integrity_status:='REPAIR_REQUIRED'/);
  assert.match(down,/EXACT_ENRICHMENT_BINDING_MISSING/);
  assert.doesNotMatch(down,/\b(?:DELETE|TRUNCATE)\s+(?:FROM\s+)?tender\.pipeline_contexts/i);
});
