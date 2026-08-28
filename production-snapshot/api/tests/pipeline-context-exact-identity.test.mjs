import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const migration=readFileSync(new URL("../migrations/125_pipeline_context_exact_identity.sql",import.meta.url),"utf8");
const rollback=readFileSync(new URL("../migrations/125_pipeline_context_exact_identity.down.sql",import.meta.url),"utf8");

test("pipeline contexts receive exact tenant, lot and current enrichment identities",()=>{
  assert.match(migration,/ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES saas\.tenants/);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS lot_id uuid REFERENCES tender\.lots/);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS enrichment_version_id uuid REFERENCES tender\.enrichment_versions/);
  assert.match(migration,/binding\.tenant_id=NEW\.tenant_id AND binding\.company_id=NEW\.company_id/);
  assert.match(migration,/binding\.tender_id=NEW\.tender_id AND binding\.source_lot_id=NEW\.lot_key/);
  assert.match(migration,/context_integrity_status:='REPAIR_REQUIRED'/);
  assert.match(migration,/runtime_tenant_allowed\(tenant_id\) AND tender\.runtime_company_allowed\(company_id\)/);
});

test("every pipeline refresh re-evaluates a newly materialized exact binding",()=>{
  assert.match(migration,/CREATE TRIGGER pipeline_context_exact_identity\s+BEFORE INSERT OR UPDATE\s+ON tender\.pipeline_contexts/s);
  assert.doesNotMatch(migration,/UPDATE OF tender_id,lot_key,company_id/);
});

test("pipeline identity rollback remains application-compatible and data preserving",()=>{
  assert.match(rollback,/ALTER COLUMN tenant_id DROP NOT NULL/);
  assert.match(rollback,/legacy_company_tenant_bindings/);
  assert.doesNotMatch(rollback.replace(/DELETE FROM app\.schema_migrations[^;]+;/,""),/\b(?:DELETE|TRUNCATE)\b/i);
  assert.doesNotMatch(rollback,/DROP COLUMN/);
});
