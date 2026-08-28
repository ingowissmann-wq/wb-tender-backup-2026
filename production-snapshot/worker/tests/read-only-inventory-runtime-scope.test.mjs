import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const inventoryScripts = [
  "portal-access-inventory-readonly.mjs",
  "portal-access-production-snapshot-readonly.mjs",
  "portal-adapter-gap-inventory-readonly.mjs",
  "portal-capability-inventory-readonly.mjs",
  "portal-context-schema-inventory-readonly.mjs",
  "portal-link-evidence-inventory-readonly.mjs",
  "portal-role-usage-inventory-readonly.mjs",
  "system-wide-inventory-readonly.mjs",
];

test("production read-only inventories preserve explicit runtime RLS scope options", () => {
  for (const filename of inventoryScripts) {
    const source = fs.readFileSync(new URL(`../scripts/${filename}`, import.meta.url), "utf8");
    assert.match(source, /process\.env\.DATABASE_SESSION_OPTIONS/, filename);
    assert.match(source, /default_transaction_read_only=on/, filename);
    assert.match(source, /\.filter\(Boolean\)\.join\(" "\)/, filename);
  }
});

test("acceptance inventories derive and install the authoritative background RLS scope", () => {
  for (const filename of [
    "company-context-inventory-readonly.mjs",
    "context-binding-repair-inventory-readonly.mjs",
    "portal-access-inventory-readonly.mjs",
    "portal-access-production-snapshot-readonly.mjs",
    "portal-adapter-gap-inventory-readonly.mjs",
    "portal-capability-inventory-readonly.mjs",
    "company-portal-matrix-readonly.mjs",
    "context-defect-inventory-readonly.mjs",
    "document-truth-inventory-readonly.mjs",
    "portal-context-schema-inventory-readonly.mjs",
    "portal-host-sample-links-readonly.mjs",
    "portal-link-evidence-inventory-readonly.mjs",
    "portal-role-usage-inventory-readonly.mjs",
    "process-stage-inventory-readonly.mjs",
    "system-wide-inventory-readonly.mjs",
  ]) {
    const source = fs.readFileSync(new URL(`../scripts/${filename}`, import.meta.url), "utf8");
    assert.match(source, /loadBackgroundScope\(rawPool\)/, filename);
    assert.match(source, /createFixedScopedPool\(rawPool,\s*await loadBackgroundScope\(rawPool\)\)/, filename);
    assert.match(source, /default_transaction_read_only=on/, filename);
  }
});

test("system-wide context defects exclude intentional historical and tender-global null identities", () => {
  const source = fs.readFileSync(new URL("../scripts/system-wide-inventory-readonly.mjs", import.meta.url), "utf8");
  assert.match(source, /pipelineContextsMissingLotRaw/);
  assert.match(source, /pipelineContextsMissingEnrichmentVersionRaw/);
  assert.match(source, /context_integrity_status='REPAIR_REQUIRED' AND lot_id IS NULL/);
  assert.match(source, /context_integrity_status='REPAIR_REQUIRED' AND enrichment_version_id IS NULL/);
  assert.match(source, /pipelineContextsHistorical/);
  assert.match(source, /pipelineContextsTenderGlobal/);
});
