import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const server = readFileSync(new URL("../platform/server.mjs", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/089_tender_daily_source_sync.sql", import.meta.url), "utf8");
const relevanceMigration = readFileSync(new URL("../migrations/090_wb_relevance_decision.sql", import.meta.url), "utf8");
const ingestion = readFileSync(new URL("../platform/source-ingestion.mjs", import.meta.url), "utf8");

test("overview exposes only active, confidently WB-relevant records and orders current publications first", () => {
  assert.match(server, /source_lifecycle_status='ACTIVE'/);
  assert.match(server, /wb_relevance_status='RELEVANT'/);
  assert.match(server, /classification_confidence='HIGH'/);
  assert.match(server, /assigned_service_line IS NOT NULL/);
  assert.match(server, /publication_date DESC NULLS LAST/);
  assert.match(server, /pageSize/);
});

test("overview uses only the consolidated audited service-line decision", () => {
  assert.match(server, /tender\.assigned_service_line service_line/);
  assert.doesNotMatch(server, /LEFT JOIN LATERAL \(\s*SELECT CASE\s*WHEN evaluation\.primary_company/);
});

test("overview SELECT remains syntactically joined to its FROM clause", () => {
  assert.doesNotMatch(server, /portal_access_connected,\s*FROM tender\.tenders tender/);
  assert.match(server, /portal_access_connected\s*FROM tender\.tenders tender/);
});

test("publication, source change and synchronization timestamps stay separate", () => {
  assert.match(migration, /publication_date/);
  assert.match(migration, /last_synced_at/);
  assert.match(ingestion, /source_timestamp/);
});

test("database contract preserves records and marks lifecycle without physical deletion", () => {
  assert.match(migration, /source_lifecycle_status/);
  assert.doesNotMatch(migration, /DELETE\s+FROM\s+tender\.tenders/i);
});

test("database contract stores the three distinct WB relevance decisions", () => {
  assert.match(relevanceMigration, /RELEVANT','NOT_RELEVANT','REVIEW_REQUIRED/);
  assert.match(relevanceMigration, /classification_rule_id/);
  assert.match(relevanceMigration, /classification_basis/);
  assert.doesNotMatch(relevanceMigration, /DELETE\s+FROM\s+tender\.tenders/i);
});
