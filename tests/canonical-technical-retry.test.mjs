import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const up=fs.readFileSync(new URL("../migrations/138_canonical_technical_retry.sql",import.meta.url),"utf8");
const down=fs.readFileSync(new URL("../migrations/138_canonical_technical_retry.down.sql",import.meta.url),"utf8");

test("technical retry admits only exact known internal error classes",()=>{
  for(const code of ["TECHNISCHER_CONNECTORFEHLER","PORTAL_DER_AUSSCHREIBUNG_NICHT_ERMITTELT","DOWNLOADLINK_NICHT_AUFGELOEST","DOKUMENTENLISTE_NICHT_ERMITTELT"])
    assert.ok(up.includes(`'${code}'`),code);
  assert.match(up,/queue\.status IN\('DEAD_LETTER','FAILED'\)/);
  assert.match(up,/latest_error AS MATERIALIZED/);
  assert.match(up,/authoritative_context AS MATERIALIZED/);
  assert.match(up,/terminal_result='MIGRATION_ROLLBACK_BEFORE_EXECUTION'/);
});

test("technical retry requires every current authoritative execution gate",()=>{
  for(const gate of ["data_class='PUBLIC_REAL'","source_lifecycle_status='ACTIVE'","participation_status='ELIGIBLE'","lifecycle.offer_deadline>now()","current_registered_tender_company_portals","context_integrity_status='CANONICAL'","configuration.configuration_version_no IS NOT NULL"])
    assert.ok(up.includes(gate),gate);
  assert.match(up,/externalSubmission',false/);
  assert.doesNotMatch(up,/external_submissions|binding_action_releases/);
});

test("technical retry rollback is a non-destructive soft cancel",()=>{
  assert.match(down,/SOFT_CANCEL_UNSTARTED_ONLY/);
  assert.match(down,/started_at IS NULL/);
  assert.doesNotMatch(down,/DELETE FROM tender\.autopilot_queue/);
});
