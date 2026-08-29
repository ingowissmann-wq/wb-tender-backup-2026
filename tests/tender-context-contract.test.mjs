import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  TENDER_CONTEXT_FIELDS,
  TENDER_CONTEXT_SCHEMA_VERSION,
  normalizeTenderContext,
} from "../platform/tender-context-contract.mjs";

const ids = {
  tenant_id: "11111111-1111-4111-8111-111111111111",
  company_id: "22222222-2222-4222-8222-222222222222",
  tender_id: "33333333-3333-4333-8333-333333333333",
  tender_version_id: "44444444-4444-4444-8444-444444444444",
  lot_id: "55555555-5555-4555-8555-555555555555",
  enrichment_lot_id: "66666666-6666-4666-8666-666666666666",
  enrichment_version_id: "77777777-7777-4777-8777-777777777777",
  document_portal_id: "88888888-8888-4888-8888-888888888888",
  submission_portal_id: "99999999-9999-4999-8999-999999999999",
  credential_scope_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  region_version_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};
const complete = {
  ...ids,
  lot_key: "LOT-7",
  publication_source: "TED",
  credential_status: "VALID",
  relevance_version: "12",
};
const routes = readFileSync(new URL("../platform/autopilot-routes.mjs", import.meta.url), "utf8");

test("canonical tender context names both lot UUID namespaces and never conflates them", () => {
  assert.match(TENDER_CONTEXT_FIELDS.lot_id.note, /tender\.lots/);
  assert.match(TENDER_CONTEXT_FIELDS.enrichment_lot_id.note, /enrichment_lots/);
  const result = normalizeTenderContext(complete, { stage: "CALCULATION" });
  assert.equal(result.status, "READY");
  assert.equal(result.context.schema_version, TENDER_CONTEXT_SCHEMA_VERSION);
  assert.equal(result.context.lot_id, ids.lot_id);
  assert.equal(result.context.enrichment_lot_id, ids.enrichment_lot_id);
  assert.notEqual(result.context.lot_id, result.context.enrichment_lot_id);
});

test("API projections do not expose enrichment lot UUIDs as canonical lot_id", () => {
  assert.match(routes, /d\.lot_id enrichment_lot_id,el\.lot_key document_lot_key/);
  assert.match(routes, /SELECT id,lot_id enrichment_lot_id,document_type/);
  assert.match(routes, /SELECT lot_id enrichment_lot_id,field_key/);
  assert.doesNotMatch(routes, /SELECT d\.id,d\.lot_id,el\.lot_key document_lot_key/);
});

test("missing action identity produces explicit blockers without guessed IDs", () => {
  const lot = normalizeTenderContext({ ...complete, lot_id: null, lot_key: null }, { stage: "CALCULATION" });
  assert.equal(lot.status, "LOT_SELECTION_REQUIRED");
  assert.deepEqual(lot.missing.filter((field) => field.startsWith("lot_")), ["lot_id", "lot_key"]);
  assert.equal(lot.context.lot_id, null);

  const enrichment = normalizeTenderContext({ ...complete, enrichment_version_id: null }, { stage: "CALCULATION" });
  assert.equal(enrichment.status, "ENRICHMENT_INITIALIZATION_REQUIRED");
  assert.equal(enrichment.context.enrichment_version_id, null);

  const malformed = normalizeTenderContext({ ...complete, lot_id: "LOT-0000" }, { stage: "CALCULATION" });
  assert.equal(malformed.status, "DATA_CONTEXT_REPAIR_REQUIRED");
  assert.deepEqual(malformed.invalid, ["lot_id"]);
});

test("region absence cannot erase credential, lot, document or enrichment truth", () => {
  const result = normalizeTenderContext({ ...complete, region_version_id: null }, { stage: "DETAIL" });
  assert.equal(result.context.region_version_id, null);
  assert.equal(result.context.credential_scope_id, ids.credential_scope_id);
  assert.equal(result.context.credential_status, "VALID");
  assert.equal(result.context.lot_id, ids.lot_id);
  assert.equal(result.context.enrichment_version_id, ids.enrichment_version_id);
  assert.equal(result.context.document_portal_id, ids.document_portal_id);
});

test("credential truth is nullable only without a credential scope and unknown states fail closed", () => {
  assert.equal(normalizeTenderContext({ ...complete, credential_scope_id: null, credential_status: null }, { stage: "DETAIL" }).status, "READY");
  const missing = normalizeTenderContext({ ...complete, credential_status: null }, { stage: "DETAIL" });
  assert.equal(missing.status, "DATA_CONTEXT_REPAIR_REQUIRED");
  assert.ok(missing.invalid.includes("credential_status"));
  const unknown = normalizeTenderContext({ ...complete, credential_status: "DOCUMENTS_AVAILABLE" }, { stage: "DETAIL" });
  assert.equal(unknown.status, "DATA_CONTEXT_REPAIR_REQUIRED");
});

test("public and protected document stages have distinct credential requirements", () => {
  const publicContext = { ...complete, credential_scope_id: null, credential_status: null };
  assert.equal(normalizeTenderContext(publicContext, { stage: "DOCUMENT_PUBLIC" }).status, "READY");
  const protectedContext = normalizeTenderContext(publicContext, { stage: "DOCUMENT_PROTECTED" });
  assert.equal(protectedContext.status, "PORTAL_ACCESS_REQUIRED");
  assert.deepEqual(protectedContext.missing, ["credential_scope_id", "credential_status"]);
  for (const credential_status of ["CONFIGURED_UNVERIFIED", "MFA_REQUIRED", "CAPTCHA_OR_USER_ACTION_REQUIRED", "EXPIRED", "INVALID", "LOCKED", "PORTAL_UNAVAILABLE", "VALIDATION_PENDING"]) {
    assert.equal(normalizeTenderContext({ ...complete, credential_status }, { stage: "DOCUMENT_PROTECTED" }).status, "PORTAL_ACCESS_REQUIRED", credential_status);
  }
  assert.equal(normalizeTenderContext(complete, { stage: "DOCUMENT_PROTECTED" }).status, "READY");
  assert.equal(normalizeTenderContext({ ...complete, credential_status: "MFA_REQUIRED" }, { stage: "SUBMISSION_PREFLIGHT" }).actionAllowed, false);
});
