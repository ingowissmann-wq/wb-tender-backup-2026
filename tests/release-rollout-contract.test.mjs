import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routes = await readFile(new URL("../platform/autopilot-routes.mjs", import.meta.url), "utf8");
const migration = await readFile(new URL("../migrations/155_autopilot_overview_latest_lookup.sql", import.meta.url), "utf8");
const rollout = await readFile(new URL("../deployment/production-rollout.sh", import.meta.url), "utf8");
const backup = await readFile(new URL("../deployment/create-encrypted-production-backup.sh", import.meta.url), "utf8");
const encryptedCatalog = await readFile(new URL("../deployment/lib/encrypted-pg-archive.sh", import.meta.url), "utf8");
const plans = await readFile(new URL("../migrations/156_approved_tender_commercial_plans.sql", import.meta.url), "utf8");

test("overview resolves latest rows set-wise before joining", () => {
  assert.match(routes, /selected AS MATERIALIZED/);
  assert.match(routes, /latest_results AS/);
  assert.match(routes, /latest_jobs AS/);
  assert.doesNotMatch(routes.slice(routes.indexOf('"\/api\/autopilot\/navigation\/overview"'), routes.indexOf('"\/api\/autopilot\/navigation\/context')), /LEFT JOIN LATERAL/);
});

test("approved net plans retain server-side tenant limits", () => {
  assert.match(plans, /display_name='Pro'.*recommended_monthly_price_minor=99000/);
  assert.match(plans, /display_name='Business'.*recommended_monthly_price_minor=149000/);
  assert.match(plans, /display_name='Enterprise'.*recommended_monthly_price_minor=249000/);
  assert.doesNotMatch(plans, /INSERT\s+INTO\s+saas\.plans/i);
});

test("overview indexes are additive, online and reversible", () => {
  assert.equal((migration.match(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/g) || []).length, 3);
  assert.doesNotMatch(migration, /\b(?:DELETE|TRUNCATE|UPDATE|ALTER\s+TABLE|DROP)\b/i);
});

test("production rollout is digest-pinned, rehearsed and fail-closed", () => {
  assert.match(rollout, /RELEASE_IMAGE.*@sha256/);
  assert.match(rollout, /ACTUAL_COMMIT=\$\(git rev-parse HEAD\)/);
  assert.match(rollout, /EXPECTED_TREE/);
  assert.match(rollout, /create-encrypted-production-backup\.sh/);
  assert.match(backup, /pg_dump/);
  assert.match(backup, /gpg .*--symmetric/);
  assert.match(backup, /verify_encrypted_pg_archive_catalog/);
  assert.match(encryptedCatalog, /pg_restore -l/);
  assert.match(encryptedCatalog, /Broken pipe/);
  assert.match(backup, /sha256sum/);
  assert.match(rollout, /REHEARSAL_EVIDENCE/);
  assert.match(rollout, /api worker scheduler/);
  assert.match(rollout, /EXTERNAL_SUBMISSION_ENABLED=false/);
  assert.match(rollout, /WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false/);
  assert.match(rollout, /trap rollback ERR INT TERM/);
  assert.doesNotMatch(rollout, /(?:password|token|secret)=['"][^'"]+['"]/i);
});
