import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../platform/verified-session-fanout.mjs", import.meta.url),
  "utf8",
);

test("a replacement session does not enqueue an already active exact context", () => {
  for (const token of [
    "AND NOT EXISTS(SELECT 1 FROM tender.autopilot_queue active_job",
    "active_job.tender_id=context.tender_id",
    "active_job.company_id=context.company_id",
    "coalesce(active_job.lot_key,'')=context.lot_key",
    "active_job.portal_id=$3 AND active_job.credential_id=$4",
    "active_job.enrichment_version_id=context.enrichment_version_id",
    "active_job.status IN('PENDING','CLAIMED','RETRY','QUEUED','RUNNING')",
  ])
    assert.ok(source.includes(token), token);
});

test("a deduplicated session dispatch is attached to the existing job", () => {
  assert.ok(source.includes("WHERE dispatch.session_id=$1 AND dispatch.job_id IS NULL"));
  assert.ok(source.includes("SET job_id=existing.job_id,dispatch_status='QUEUED'"));
  assert.ok(source.includes("ORDER BY dispatch.id,job.created_at DESC,job.id DESC"));
});
