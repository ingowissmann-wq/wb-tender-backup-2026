import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const up=readFileSync(new URL("../migrations/146_enrichment_context_binding_version_uniqueness.sql",import.meta.url),"utf8");
const down=readFileSync(new URL("../migrations/146_enrichment_context_binding_version_uniqueness.down.sql",import.meta.url),"utf8");

test("enrichment context uniqueness includes the immutable enrichment version",()=>{
  assert.match(up,/DROP CONSTRAINT IF EXISTS enrichment_context_bindings_tenant_id_company_id_tender_ver_key/);
  assert.match(up,/enrichment_context_bindings_version_manifest_key[\s\S]*enrichment_version_id,tenant_id,company_id,tender_version_id,lot_id,source_manifest_sha256/);
  assert.doesNotMatch(up,/DELETE|TRUNCATE/i);
});

test("rollback restores the former constraint without deleting audit data",()=>{
  assert.match(down,/DROP INDEX IF EXISTS tender\.enrichment_context_bindings_version_manifest_key/);
  assert.match(down,/UNIQUE \(tenant_id,company_id,tender_version_id,lot_id,source_manifest_sha256\)/);
  assert.doesNotMatch(down,/DELETE|TRUNCATE/i);
});
