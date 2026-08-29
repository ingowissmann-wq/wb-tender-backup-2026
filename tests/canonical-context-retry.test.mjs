import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const up=fs.readFileSync(new URL("../migrations/137_canonical_context_retry.sql",import.meta.url),"utf8");
const down=fs.readFileSync(new URL("../migrations/137_canonical_context_retry.down.sql",import.meta.url),"utf8");

test("canonical retry is limited to exact current 23502 pipeline failures",()=>{
  assert.match(up,/coalesce\(queue\.safe_error_code,queue\.error_code\)='23502'/);
  assert.match(up,/queue\.action_type='RUN_FULL_PIPELINE'/);
  assert.match(up,/source_lifecycle_status='ACTIVE'/);
  assert.match(up,/wb_relevance_status='RELEVANT'/);
  assert.match(up,/participation_status='ELIGIBLE'/);
  assert.match(up,/lifecycle\.offer_deadline>now\(\)/);
});

test("replacement job uses authoritative current bindings",()=>{
  for(const required of [
    "current_tender_version.id current_tender_version_id",
    "current_enrichment.id current_enrichment_version_id",
    "current_registered_tender_company_portals",
    "context_integrity_status='CANONICAL'",
    "context.canonical_lot_id",
    "context.current_credential_id",
    "context.current_configuration_version",
  ])assert.ok(up.includes(required),required);
  assert.match(up,/externalSubmission',false/);
  assert.doesNotMatch(up,/external_submissions|binding_action_releases/);
});

test("rollback is non-destructive and only soft-cancels unstarted jobs",()=>{
  assert.match(down,/SOFT_CANCEL_UNSTARTED_ONLY/);
  assert.match(down,/started_at IS NULL/);
  assert.match(down,/attempt=0/);
  assert.doesNotMatch(down,/DELETE FROM tender\.autopilot_queue/);
  assert.match(down,/physicalDeletes',0/);
});
