import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const up=fs.readFileSync(new URL("../migrations/151_terminal_deadline_context_truth.sql",import.meta.url),"utf8");
const down=fs.readFileSync(new URL("../migrations/151_terminal_deadline_context_truth.down.sql",import.meta.url),"utf8");

test("deadline truth is source-authoritative, terminal, audited and submission inert",()=>{
  assert.match(up,/DEADLINE_CLOSED/);
  assert.match(up,/AUTHORITATIVE_OFFER_DEADLINE_CLOSED/);
  assert.match(up,/tender\.offer_deadline IS NOT NULL AND tender\.offer_deadline<=now\(\)/);
  assert.match(up,/lifecycle\.tender_id=context\.tender_id AND lifecycle\.lot_key=context\.lot_key AND lifecycle\.is_current/);
  assert.match(up,/context_integrity_status='REPAIR_REQUIRED'/);
  assert.match(up,/rowFingerprint/);
  assert.match(up,/'physicalDeletes',0/);
  assert.match(up,/'externalSubmission',false/);
  assert.doesNotMatch(up,/INSERT INTO tender\.(?:lots|enrichment_versions|enrichment_context_bindings|tender_lot_selections)/);
});

test("deadline truth rollback restores exact prior status without deleting tender data",()=>{
  assert.match(up,/context_integrity_migration_151_restore/);
  assert.match(up,/FORCE ROW LEVEL SECURITY/);
  assert.match(down,/DISABLE TRIGGER pipeline_context_exact_identity/);
  assert.match(down,/SET context_integrity_status=restore\.prior_status/);
  assert.match(down,/ENABLE TRIGGER pipeline_context_exact_identity/);
  assert.doesNotMatch(down,/DELETE FROM tender\.(?:pipeline_contexts|tenders|lots|enrichment_versions)/);
  assert.match(down,/TERMINAL_DEADLINE_CONTEXT_TRUTH_ROLLED_BACK/);
});
