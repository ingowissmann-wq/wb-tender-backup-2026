import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const worker=readFileSync(new URL("../platform/autopilot-pipeline-worker.mjs",import.meta.url),"utf8");
const migration=readFileSync(new URL("../migrations/145_public_document_queue_scope.sql",import.meta.url),"utf8");
const rollback=readFileSync(new URL("../migrations/145_public_document_queue_scope.down.sql",import.meta.url),"utf8");

test("queued company-lot processing preserves an authoritative primary tender decision",()=>{
  assert.match(worker,/async function authoritativeQueuedSelection/);
  assert.match(worker,/relevance\.primary_company=true/);
  assert.match(worker,/relevance\.recommendation='FULL_PIPELINE_ALLOWED'/);
  assert.match(worker,/tender_lot_selections/);
  assert.match(worker,/enrichment_context_bindings/);
  assert.match(worker,/await bindExactEnrichmentContext\(pool/);
  assert.match(worker,/if\(contextActions\.includes\(action\)&&!selected\.length\)throw/);
  assert.match(worker,/resolution_status='DOWNLOAD_SUCCEEDED'/);
  assert.match(worker,/provenance=\(provenance-'error'-'errorClass'\)/);
});

test("database queue guard permits only validated public read scopes and never login or submission",()=>{
  assert.match(migration,/public_read_scope_valid/);
  assert.match(migration,/NEW\.credential_id IS NULL/);
  assert.match(migration,/evidence_role='PROCUREMENT_DOCUMENT'/);
  assert.match(migration,/'PUBLIC_DOCUMENTS_POSSIBLE'=ANY/);
  assert.doesNotMatch(migration,/public_read_scope_valid:=NEW\.action_type IN\([^)]*TEST_LOGIN/s);
  assert.doesNotMatch(migration,/public_read_scope_valid:=NEW\.action_type IN\([^)]*SUBMIT/s);
  assert.match(rollback,/CREATE OR REPLACE FUNCTION tender\.reject_unscoped_portal_job/);
});

test("document completion uses canonical archive-scoped counts and clears stale retry errors",()=>{
  assert.match(worker,/async function canonicalProcurementDocumentCounts/);
  assert.match(worker,/archiveChildrenMaterialized/);
  assert.match(worker,/AND NOT materialized_archive/);
  assert.match(worker,/result_counts=\$8::jsonb,error_code=NULL,safe_error_code=NULL,error_detail_safe=NULL,blocking_reason=NULL/);
  assert.match(worker,/document_type IN \('TENDER_DOCUMENT','PORTAL_TENDER_DOCUMENT','INTERNAL_ACCEPTANCE_DOCUMENT'\)/);
  assert.match(worker,/archiveChildrenMaterialized/);
  assert.match(worker,/status='SUCCEEDED',current_step='COMPLETED'[\s\S]{0,240}terminal_at=NULL,terminal_result=NULL/);
});
