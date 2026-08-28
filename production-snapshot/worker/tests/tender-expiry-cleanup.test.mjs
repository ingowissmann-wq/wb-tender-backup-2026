import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bindingDeadline, evaluateExpiryCandidate, runTenderCleanup, tombstoneImportDecision } from "../platform/tender-cleanup.mjs";

const cleanupSource=readFileSync(new URL("../platform/tender-cleanup.mjs",import.meta.url),"utf8");
const ingestionSource=readFileSync(new URL("../platform/source-ingestion.mjs",import.meta.url),"utf8");
const serverSource=readFileSync(new URL("../platform/server.mjs",import.meta.url),"utf8");
const migration=readFileSync(new URL("../migrations/091_safe_tender_expiry_cleanup.sql",import.meta.url),"utf8");
const reviewMigration=readFileSync(new URL("../migrations/093_fail_closed_expiry_review.sql",import.meta.url),"utf8");
const healthSource=readFileSync(new URL("../scripts/source-ingestion-health.mjs",import.meta.url),"utf8");

const row=(overrides={})=>({
  id:"00000000-0000-4000-8000-000000000001",data_class:"PUBLIC_REAL",source_code:"TED",external_id:"notice-1",
  offer_deadline:"2026-01-15T23:00:00.000Z",source_timestamp:"2026-01-01T10:00:00Z",version_source_timestamp:"2026-01-01T10:00:00Z",
  normalized_data:{offerDeadline:"2026-01-15",sourceStatus:"closed",raw:{"deadline-receipt-tender-date-lot":["2026-01-15"]}},...overrides,
});

test("expired public tender is an unambiguous cleanup candidate",()=>assert.equal(evaluateExpiryCandidate(row(),new Date("2026-01-16T23:01:00Z")).eligible,true));
test("expired deadline without an explicit inactive source status is never deleted",()=>{
  const result=evaluateExpiryCandidate(row({normalized_data:{offerDeadline:"2026-01-15",sourceStatus:"cn-standard",raw:{"deadline-receipt-tender-date-lot":["2026-01-15"]}}}),new Date("2026-01-16T23:01:00Z"));
  assert.equal(result.eligible,false); assert.equal(result.ambiguous,true); assert.equal(result.reason,"SOURCE_STATUS_ACTIVE_CONTRADICTION");
});
test("unknown source status is routed to review instead of being deleted",()=>{
  const result=evaluateExpiryCandidate(row({normalized_data:{offerDeadline:"2026-01-15",sourceStatus:"opaque-provider-value",raw:{"deadline-receipt-tender-date-lot":["2026-01-15"]}}}),new Date("2026-01-16T23:01:00Z"));
  assert.equal(result.eligible,false); assert.equal(result.ambiguous,true); assert.equal(result.reason,"SOURCE_STATUS_NOT_CONFIRMED_INACTIVE");
});
test("active tender remains",()=>assert.equal(evaluateExpiryCandidate(row({offer_deadline:"2026-01-20T23:00:00Z",normalized_data:{offerDeadline:"2026-01-20",sourceStatus:"competition",raw:{"deadline-receipt-tender-date-lot":["2026-01-20"]}}}),new Date("2026-01-16T00:00:00Z")).reason,"DEADLINE_ACTIVE"));
test("newer extended tender remains",()=>assert.equal(evaluateExpiryCandidate(row({offer_deadline:"2026-02-01T23:00:00Z",normalized_data:{offerDeadline:"2026-02-01",sourceStatus:"competition",raw:{"deadline-receipt-tender-date-lot":["2026-02-01"]}}}),new Date("2026-01-16T00:00:00Z")).eligible,false));
test("one active lot protects the whole tender",()=>assert.equal(evaluateExpiryCandidate(row({normalized_data:{offerDeadline:"2026-01-15",sourceStatus:"competition",raw:{"deadline-receipt-tender-date-lot":["2026-01-15","2026-01-20"]}}}),new Date("2026-01-16T23:01:00Z")).reason,"ACTIVE_LOT_DEADLINE"));
test("missing deadline is ambiguous and never eligible",()=>assert.deepEqual(evaluateExpiryCandidate(row({offer_deadline:null}),new Date()),{eligible:false,ambiguous:true,reason:"DEADLINE_MISSING"}));
test("contradictory source and stored deadlines are skipped",()=>assert.equal(evaluateExpiryCandidate(row({normalized_data:{offerDeadline:"2026-01-14",sourceStatus:"competition",raw:{"deadline-receipt-tender-date-lot":["2026-01-14"]}}}),new Date("2026-01-20T00:00:00Z")).reason,"DEADLINE_CONTRADICTION"));
test("Europe/Berlin date boundary retains the tender through the local deadline day",()=>{
  const deadline=bindingDeadline("2026-01-15");
  assert.equal(deadline.instant.toISOString(),"2026-01-15T23:00:00.000Z");
  assert.equal(evaluateExpiryCandidate(row(),new Date("2026-01-15T22:59:59Z")).eligible,false);
});
test("Europe/Berlin summer time date ends at 22:00 UTC",()=>assert.equal(bindingDeadline("2026-07-15").instant.toISOString(),"2026-07-15T22:00:00.000Z"));
test("Europe/Berlin winter time date ends at 23:00 UTC",()=>assert.equal(bindingDeadline("2026-12-15").instant.toISOString(),"2026-12-15T23:00:00.000Z"));
test("failed synchronization records a skipped cleanup and prevents deletion",async()=>{
  const calls=[]; const pool={query:async(sql)=>{calls.push(sql);return {rows:[{id:"run"}]}}};
  const result=await runTenderCleanup(pool,{syncSucceeded:false});
  assert.equal(result.skipped,true); assert.equal(calls.length,1); assert.match(calls[0],/SKIPPED_SYNC_FAILURE/);
});
test("deleted tombstone prevents an unchanged expired reimport",()=>{
  const decision=tombstoneImportDecision({tombstone_status:"DELETED",source_updated_at:"2026-01-01T00:00:00Z"},{offerDeadline:"2026-01-15",sourceTimestamp:"2026-01-02T00:00:00Z"},new Date("2026-01-20T00:00:00Z"));
  assert.deepEqual(decision,{allow:false,reason:"TOMBSTONE_STILL_EXPIRED"});
});
test("newer unambiguous extension permits controlled reactivation",()=>{
  const decision=tombstoneImportDecision({tombstone_status:"DELETED",source_updated_at:"2026-01-01T00:00:00Z"},{offerDeadline:"2026-02-15",sourceTimestamp:"2026-01-02T00:00:00Z",sourceStatus:"active"},new Date("2026-01-20T00:00:00Z"));
  assert.equal(decision.allow,true); assert.equal(decision.reactivated,true); assert.equal(decision.reason,"NEWER_UNAMBIGUOUS_DEADLINE_EXTENSION");
});
test("attachment cleanup is scoped through the tender enrichment version and shared blobs are retained",()=>{
  assert.match(cleanupSource,/version\.id=document\.enrichment_version_id WHERE version\.tender_id=\$1/);
  assert.match(cleanupSource,/NOT EXISTS\(SELECT 1 FROM tender\.enrichment_document_blobs/);
  assert.match(cleanupSource,/NOT EXISTS\(SELECT 1 FROM tender\.generated_documents/);
});
test("cleanup order leaves no tender-owned derived relationships",()=>{
  for(const table of ["autopilot_queue","autopilot_results","service_relevance_evaluations","source_references","tender_versions","lots","duplicate_links"]) assert.match(cleanupSource,new RegExp(`DELETE FROM tender\\.${table}`));
  assert.match(cleanupSource,/DELETE FROM tender\.tenders WHERE id=\$1/);
});
test("customer and work data are protected and tombstoned instead of cascaded",()=>{
  for(const table of ["favorites","notes","tasks","decisions","calculations","bid_packages","submission_contexts","required_documents"]) assert.match(cleanupSource,new RegExp(`EXISTS\\(SELECT 1 FROM tender\\.${table}`));
  assert.doesNotMatch(migration,/REFERENCES tender\.tenders\(id\) ON DELETE CASCADE/);
  assert.match(cleanupSource,/PROTECTED_TOMBSTONE/);
  assert.match(cleanupSource,/Keep relational enrichment\/document evidence when any customer/);
  assert.doesNotMatch(cleanupSource,/search_document=NULL/);
});
test("batch abort uses savepoints and later batches can safely continue",()=>{
  assert.match(cleanupSource,/SAVEPOINT cleanup_item/); assert.match(cleanupSource,/ROLLBACK TO SAVEPOINT cleanup_item/); assert.match(cleanupSource,/offset\+=boundedBatch/);
});
test("repeated cleanup is idempotent",()=>{
  assert.match(cleanupSource,/ON CONFLICT\(source_code,external_id\) DO UPDATE/);
  assert.match(cleanupSource,/ON CONFLICT DO NOTHING/);
  assert.match(cleanupSource,/WHERE t\.data_class='PUBLIC_REAL'.*t\.offer_deadline IS NOT NULL/s);
});
test("parallel cleanup is prevented by the existing file lock and a database advisory lock",()=>{
  assert.match(cleanupSource,/pg_advisory_xact_lock\(hashtext\('wb-tender-expiry-cleanup'\)\)/);
  assert.match(ingestionSource,/acquireLease/);
});
test("portal and public API exclude expired and tombstoned tenders",()=>{
  assert.match(serverSource,/source_lifecycle_status='ACTIVE'/);
  assert.match(serverSource,/data_class='PUBLIC_REAL' AND source_lifecycle_status='ACTIVE'/);
  assert.match(serverSource,/SELECT external_id,title,buyer,publication_date,offer_deadline,source_url FROM tender\.tenders tender WHERE data_class='PUBLIC_REAL' AND source_lifecycle_status='ACTIVE'/);
  assert.match(serverSource,/source_lifecycle_status='ACTIVE'[\s\S]{0,180}participation_status IN\('ELIGIBLE','PARTIALLY_ELIGIBLE'\)[\s\S]{0,180}current_participation_eligible_lots/);
});
test("active tender detail pages retain the guarded and lot-bound query",()=>assert.match(serverSource,/SELECT \* FROM tender\.tenders tender WHERE id=\$1 AND data_class='PUBLIC_REAL' AND source_lifecycle_status='ACTIVE'[\s\S]{0,180}current_participation_eligible_lots/));
test("tombstones contain only minimal lifecycle identity and audit fields",()=>{
  for(const field of ["source_code","external_id","last_known_deadline","deleted_at","deletion_reason","last_source_status","source_updated_at"]) assert.match(migration,new RegExp(field));
  assert.doesNotMatch(migration,/tender_tombstones[\s\S]{0,800}\b(description|documents|raw_payload)\b/);
});
test("ambiguous deadlines have a dedicated internal review group",()=>{
  assert.match(reviewMigration,/CREATE TABLE IF NOT EXISTS tender\.tender_expiry_reviews/);
  assert.match(cleanupSource,/DEADLINE_MISSING/);
  assert.match(cleanupSource,/review_status='OPEN'/);
});
test("production health warns on review growth, storage pressure, orphans, and tombstone reimports",()=>{
  for(const marker of ["EXPIRY_REVIEW_GROUP_GROWTH","DISK_FREE_BELOW_20_PERCENT","ORPHANED_DATABASE_FILES_PRESENT","expiredTombstoneReimports"]) assert.match(healthSource,new RegExp(marker));
});
