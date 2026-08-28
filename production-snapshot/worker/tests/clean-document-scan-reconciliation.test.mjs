import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const migration=readFileSync(new URL("../migrations/124_clean_document_scan_reconciliation.sql",import.meta.url),"utf8");
const scanner=readFileSync(new URL("../platform/malware-scanner.mjs",import.meta.url),"utf8");
const worker=readFileSync(new URL("../platform/autopilot-pipeline-worker.mjs",import.meta.url),"utf8");
const retry=readFileSync(new URL("../scripts/retry-quarantined-document-scans.mjs",import.meta.url),"utf8");

test("clean scan reconciliation is exact, fail-closed and continuous",()=>{
  assert.match(migration,/NEW\.status='CLEAN'/);
  assert.match(migration,/document\.payload_sha256=NEW\.payload_sha256/);
  assert.match(migration,/document\.provenance->>'procurementVerified'='true'/);
  assert.match(migration,/document\.provenance->>'statusGuard' IS NULL/);
  assert.match(migration,/document\.tender_association_verified AND document\.lot_association_verified/);
  assert.match(migration,/document\.magic_bytes_verified AND document\.content IS NOT NULL/);
  assert.doesNotMatch(migration,/procurement_verification_status='VERIFIED'[\s\S]+LOT_ASSOCIATION_MISSING/);
});

test("scanner defaults match the deployed 100 MiB and 120 second clamd envelope",()=>{
  assert.match(scanner,/DEFAULT_MAX_BYTES=100\*1024\*1024/);
  assert.match(scanner,/CLAMD_TIMEOUT_MS\|\|120000/);
  assert.match(scanner,/CLAMD_STREAM_MAX_BYTES/);
});

test("persistent document retries bound concurrent clamd streams",()=>{
  assert.match(worker,/MALWARE_SCAN_CONCURRENCY\|\|2/);
  assert.match(worker,/Math\.min\(4,/);
  assert.match(worker,/rows\.slice\(offset,offset\+scanConcurrency\)/);
});

test("manual retry scheduling is hash-bound, size-bounded, transactional and non-transmitting",()=>{
  assert.match(retry,/scan\.status='QUARANTINED'/);
  assert.match(retry,/octet_length\(document\.content\)<=100\*1024\*1024/);
  assert.match(retry,/createHash\("sha256"\)/);
  assert.match(retry,/APPLY_DOCUMENT_SCAN_RETRY/);
  assert.match(retry,/externalSubmission:false,transmitted:false/);
});
