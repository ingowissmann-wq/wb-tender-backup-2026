import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const migration=readFileSync(new URL("../migrations/129_authoritative_portal_assignment_backfill.sql",import.meta.url),"utf8");
const rollback=readFileSync(new URL("../migrations/129_authoritative_portal_assignment_backfill.down.sql",import.meta.url),"utf8");

test("portal role backfill requires exact current selection, version, host and unique evidence",()=>{
  for(const token of ["tender_lot_selections","resolution.tender_version_id=selection.tender_version_id",
    "resolution.resolution_status='UNIQUE_EVIDENCE'","candidate_count=1",
    "lower(portal.canonical_domain)=lower(resolution.exact_host)","assignment_source",
    "'UNIQUE_EVIDENCE'","evidence_sha256 ~ '^[0-9a-f]{64}$'",
    "WHEN 'PROCUREMENT_DOCUMENT' THEN 'DOCUMENT_PORTAL'",
    "WHEN 'SUBMISSION' THEN 'SUBMISSION_PORTAL'",
    "DROP CONSTRAINT IF EXISTS tender_portal_resolutions_tender_version_id_key",
    "tender_portal_resolutions_version_role_uq"])
    assert.ok(migration.includes(token),token);
  assert.ok(!migration.includes("DELETE FROM tender.tender_portal_assignments"));
});

test("portal assignment rollback preserves business evidence",()=>{
  assert.match(rollback,/DELETE FROM app\.schema_migrations/);
  assert.ok(!rollback.includes("DELETE FROM tender.tender_portal_assignments"));
});
