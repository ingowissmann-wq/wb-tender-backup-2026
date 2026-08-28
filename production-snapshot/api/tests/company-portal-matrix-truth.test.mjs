import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyPortalFeatureGap,
  companyContextStatus,
  hasConcreteAdapterImplementation,
} from "../platform/company-portal-capability-status.mjs";

test("Tenant binding and tender service scope are evaluated independently", () => {
  const missingScope = {
    tenant_id: "tenant-1",
    tenant_count: 1,
    canonical_services: [],
    tender_scope_count: 0,
    scope_tenant_count: 0,
    scope_tenant_id: null,
  };
  assert.deepEqual(companyContextStatus(missingScope), {
    status: "DATA_CONTEXT_REPAIR_REQUIRED",
    repair: "Autoritatives Tender-Profil mit genau einem Leistungsbereich und demselben Tenant wie die Gesellschaft freigeben.",
  });
  assert.equal(companyContextStatus({...missingScope,
    canonical_services:["security"],tender_scope_count:1,scope_tenant_count:1,scope_tenant_id:"tenant-1"}),null);
});

test("Unknown and unimplemented adapters are not mislabeled as broken adapters", () => {
  const feature = {portal_support:"SUPPORTED",autopilot_supported:true,actively_configured:false};
  assert.equal(hasConcreteAdapterImplementation({adapter_id:"unknown-abcd",adapter_validation_status:"NO_ACTIVE_TENDER_FOR_VALIDATION"}),false);
  assert.equal(classifyPortalFeatureGap({adapter_id:"unknown-abcd",adapter_validation_status:"NO_ACTIVE_TENDER_FOR_VALIDATION"},feature),"UNSUPPORTED_PORTAL_REQUIRES_ADAPTER");
  assert.equal(classifyPortalFeatureGap({adapter_id:"dtvp",adapter_validation_status:"PRODUCTION_VALIDATED"},null),"UNSUPPORTED_PORTAL_REQUIRES_ADAPTER");
  assert.equal(classifyPortalFeatureGap({adapter_id:"dtvp",adapter_validation_status:"PRODUCTION_VALIDATED"},feature),"ADAPTER_REPAIR_REQUIRED");
});

test("Read-only matrix joins the authoritative SaaS tenant binding", () => {
  const source=readFileSync(new URL("../scripts/company-portal-matrix-readonly.mjs",import.meta.url),"utf8");
  assert.match(source,/saas\.legacy_company_tenant_bindings/);
  assert.match(source,/companyContextStatus\(company\)/);
  assert.match(source,/classifyPortalFeatureGap\(portal,featureFor\(portal,featureKey\)\)/);
  assert.match(source,/classifyPortalFeatureGap\(portal,featureFor\(portal,"LOGIN"\)\)/);
  assert.match(source,/FAMILY_INTERNAL_REPLAY_EVIDENCE/);
  assert.match(source,/familyAdapterReadiness/);
  assert.match(source,/companyConfiguration/);
  assert.match(source,/EXTERNAL_VALIDATION_PENDING/);
  assert.match(source,/NOT_APPLICABLE_INACTIVE_PORTAL/);
});
