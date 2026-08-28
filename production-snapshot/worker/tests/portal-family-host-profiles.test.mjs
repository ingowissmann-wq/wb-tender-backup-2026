import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {PORTAL_ADAPTER_CATALOG} from "../platform/portal-adapter-catalog.mjs";

const migration=readFileSync(new URL("../migrations/128_portal_family_host_profiles.sql",import.meta.url),"utf8");
const rollback=readFileSync(new URL("../migrations/128_portal_family_host_profiles.down.sql",import.meta.url),"utf8");
const matrix=readFileSync(new URL("../scripts/company-portal-matrix-readonly.mjs",import.meta.url),"utf8");
const loginCanary=readFileSync(new URL("../scripts/portal-family-login-entry-canary.mjs",import.meta.url),"utf8");
const worker=readFileSync(new URL("../platform/autopilot-pipeline-worker.mjs",import.meta.url),"utf8");
const parsers=readFileSync(new URL("../platform/binary-parsers.mjs",import.meta.url),"utf8");

test("observed hosts are classified into explicit reusable families without enablement",()=>{
  for(const host of ["plattform.aumass.de","vergabe.landbw.de","vergabe.stadt-frankfurt.de",
    "www.ausschreibungen.ls.brandenburg.de","www.deutsches-ausschreibungsblatt.de",
    "www.evergabe.nrw.de","www.vergabe.metropoleruhr.de"]) assert.match(migration,new RegExp(host.replaceAll(".","\\.")));
  assert.match(migration,/portal_registry_adapter_host_entrypoint_unique/);
  assert.match(migration,/adapter_id='ai-vergabe-manager'/);
  assert.match(migration,/adapter_id='cosinex'/);
  assert.match(migration,/adapter_id='aumass'/);
  assert.ok(PORTAL_ADAPTER_CATALOG.some(item=>item.adapterId==="aumass"));
  assert.match(migration,/current_portal_host_capability_truth/);
  assert.match(migration,/adapter_validation_status='VALIDATED_READ_ONLY'/);
  assert.match(migration,/89\/89 unique leaf files ClamAV CLEAN/);
});

test("login-entry canary is read-only and covers every newly classified host",()=>{
  for(const host of ["plattform.aumass.de","vergabe.landbw.de","vergabe.stadt-frankfurt.de",
    "www.ausschreibungen.ls.brandenburg.de","www.deutsches-ausschreibungsblatt.de",
    "www.evergabe.nrw.de","www.vergabe.metropoleruhr.de"])assert.match(loginCanary,new RegExp(host.replaceAll(".","\\.")));
  assert.match(loginCanary,/externalWrite:false/);
  assert.doesNotMatch(loginCanary,/credential|password|submit/i);
});

test("matrix consumes host evidence and checks internal adapter readiness before external accounts",()=>{
  assert.match(matrix,/current_portal_host_capability_truth/);
  assert.match(matrix,/featureImplemented/);
  assert.match(matrix,/publicReadCapabilities\.has\(capability\)/);
  assert.ok(matrix.indexOf("featureKey&&!featureReady")<matrix.indexOf("needsCredential.has(capability)&&!credential"));
  assert.match(matrix,/hostSpecificCapabilityEvidence:hostCapabilityView/);
});

test("classification never enables, submits, deletes business data or weakens rollback",()=>{
  assert.doesNotMatch(migration,/adapter_enabled\s*=\s*true/i);
  assert.match(migration,/'enabled_by_migration',0/);
  assert.match(migration,/external_submission_enabled',false/);
  assert.doesNotMatch(migration,/\bDELETE FROM tender\./i);
  assert.doesNotMatch(rollback,/\bDELETE FROM tender\./i);
  assert.doesNotMatch(rollback,/DROP (?:COLUMN|TABLE)/i);
});

test("large archives remain quarantined until every bounded leaf scan is clean",()=>{
  assert.match(worker,/QUARANTINED_PENDING_LEAF_SCAN/);
  assert.match(worker,/PENDING_LEAF_SCAN/);
  assert.match(worker,/CLEAN_BY_BOUNDED_LEAF_SCAN/);
  assert.match(worker,/CONTAINER_REPLACED_BY_CLEAN_LEAF_SCANS/);
  assert.match(worker,/next_retry_at='infinity'::timestamptz/);
  assert.match(worker,/Number\(materialized\?\.count\s*\|\|\s*0\)\s*===\s*children\.length\s*&&\s*materialized\?\.all_clean\s*===\s*true/);
  assert.match(parsers,/maxArchiveInputBytes: 400_000_000/);
  assert.match(parsers,/maxArchiveBytes: 500_000_000/);
  assert.match(parsers,/image\/vnd\.dwg/);
});
