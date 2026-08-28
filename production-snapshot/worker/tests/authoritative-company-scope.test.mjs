import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {classifyCompanyService,classifyTenderServices} from "../platform/service-relevance.mjs";
import {buildEffectiveCompanyProfile,profileParameterRows} from "../platform/effective-company-profile.mjs";

const up=fs.readFileSync(new URL("../migrations/143_authoritative_company_tender_scope.sql",import.meta.url),"utf8");
const down=fs.readFileSync(new URL("../migrations/143_authoritative_company_tender_scope.down.sql",import.meta.url),"utf8");

test("scope migration is exact, immutable, RLS-bound and submission inert",()=>{
  for(const token of [
    "b8bc1f97-60cb-4c5d-b42a-d31d44839c5a","WB-Protect & Service GmbH",
    "Ingo Wissmann","DATE '2026-08-26'","canonical_service","authority_sha256",
    "authoritative_company_scope_immutable","FORCE ROW LEVEL SECURITY",
    "security_invoker=true","runtime_tenant_allowed","runtime_company_allowed","external_submission_authorized=false",
    "unrelated_company_changed","authoritative_tender_scope_not_unique","approved_enterprise_company_scope_apply",
  ])assert.ok(up.includes(token),token);
  assert.doesNotMatch(up,/external_submission_enabled\s*=\s*true|allow_external_submission\s*=\s*true|BINDING_SUBMIT/);
});

test("same-service companies require a tender-specific primary decision instead of alphabetical assignment",()=>{
  const tender={title:"Bewachung und Sicherheitsdienst",cpv_codes:["79713000"]};
  const companies=[
    {company:{company_id:"b8bc1f97-60cb-4c5d-b42a-d31d44839c5a",legal_name:"WB-Protect & Service GmbH",technical_key:"wb-protect-service",sector_slug:"security",sector_status:"approved"}},
    {company:{company_id:"7edf1812-b5e9-4b5c-addf-95d2339362b3",legal_name:"WB-Security GmbH",technical_key:"wb-security",sector_slug:"security",sector_status:"approved"}},
  ].map(item=>{
    const effective=buildEffectiveCompanyProfile({companyId:item.company.company_id,serviceArea:"security",companyProfile:{id:item.company.company_id,version:1,capabilities:{activeServices:["security"]}}});
    return {...item,parameters:profileParameterRows(effective),profile:{capabilities:{activeServices:["security"]}}};
  });
  const result=classifyTenderServices({tender,companies});
  assert.equal(result.primary,null);
  assert.equal(result.decision.ruleId,"WB_COMPANY_PRIMARY_ASSIGNMENT_REQUIRED");
  assert.ok(result.evaluations.every(item=>item.relevanceStatus==="POTENTIALLY_RELEVANT"&&item.serviceScopeGate==="REVIEW_REQUIRED"&&!item.primaryCompany));
});

test("an exact non-derived A15 primary assignment resolves the same-service ambiguity",()=>{
  const tender={title:"Bewachung und Sicherheitsdienst",cpv_codes:["79713000"]};
  const protect={company:{company_id:"b8bc1f97-60cb-4c5d-b42a-d31d44839c5a",legal_name:"WB-Protect & Service GmbH",technical_key:"wb-protect-service",sector_slug:"security",sector_status:"approved"},parameters:[{parameter_key:"A15",new_value:{companyId:"b8bc1f97-60cb-4c5d-b42a-d31d44839c5a",serviceArea:"security",primaryAssignment:true,status:"VERIFIED",source:"TENDER_SPECIFIC_BOARD_ASSIGNMENT"},status:"PROVIDED"}],profile:{capabilities:{activeServices:["security"]}}};
  const security={company:{company_id:"7edf1812-b5e9-4b5c-addf-95d2339362b3",legal_name:"WB-Security GmbH",technical_key:"wb-security",sector_slug:"security",sector_status:"approved"},parameters:[],profile:{capabilities:{activeServices:["security"]}}};
  const result=classifyTenderServices({tender,companies:[protect,security]});
  assert.equal(result.primary.companyId,protect.company.company_id);
});

test("rollback reverses derived binding but retains an audited determination history",()=>{
  for(const token of ["'REVOKED'","ROLLBACK_REVOCATION","MIGRATION_ROLLBACK","AUTHORITATIVE_COMPANY_TENDER_SCOPE_ROLLED_BACK","externalWrite',false"])
    assert.ok(down.includes(token),token);
  assert.doesNotMatch(down,/UPDATE tender\.authoritative_company_scope_versions|DELETE FROM tender\.authoritative_company_scope_versions/);
  assert.doesNotMatch(down,/DROP TABLE.*authoritative_company_scope_versions/i);
});

test("WB-Protect accepts only its exact verified derived A15 company and security scope",()=>{
  const company={company_id:"b8bc1f97-60cb-4c5d-b42a-d31d44839c5a",legal_name:"WB-Protect & Service GmbH",technical_key:"wb-protect-service",sector_slug:"security",sector_status:"approved"};
  const tender={title:"Bewachung und Sicherheitsdienst",cpv_codes:["79713000"]};
  const allowed=classifyCompanyService({tender,company,parameters:[{parameter_key:"A15",new_value:{companyId:company.company_id,serviceArea:"security",primaryAssignment:true,status:"VERIFIED"},status:"PROVIDED"}]});
  assert.equal(allowed.relevanceStatus,"RELEVANT");
  assert.equal(allowed.serviceScopeGate,"PASSED");
  for(const wrong of [
    {companyId:"7edf1812-b5e9-4b5c-addf-95d2339362b3",serviceArea:"security",status:"VERIFIED"},
    {companyId:company.company_id,serviceArea:"cleaning",status:"VERIFIED"},
    {companyId:company.company_id,serviceArea:"security",status:"PENDING_REVIEW"},
  ]){
    const result=classifyCompanyService({tender,company,parameters:[{parameter_key:"A15",new_value:wrong,status:"PROVIDED"}]});
    assert.equal(result.relevanceStatus,"NOT_APPLICABLE");
    assert.equal(result.serviceScopeGate,"FAILED_NOT_RELEVANT");
  }
});
