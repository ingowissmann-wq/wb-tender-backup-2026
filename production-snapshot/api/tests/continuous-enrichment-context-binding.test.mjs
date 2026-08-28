import assert from "node:assert/strict";
import test from "node:test";
import {bindExactEnrichmentContext} from "../platform/autopilot-pipeline-worker.mjs";

const scope={
  tender:{id:"11111111-1111-4111-8111-111111111111"},
  enrichment:{id:"22222222-2222-4222-8222-222222222222",payload_sha256:"a".repeat(64)},
  company:{
    tenant_id:"33333333-3333-4333-8333-333333333333",
    company_id:"44444444-4444-4444-8444-444444444444",
    profile_id:"55555555-5555-4555-8555-555555555555",
  },
};

test("tender-global enrichment needs no synthetic lot binding",async()=>{
  let queried=false;
  const result=await bindExactEnrichmentContext({query:async()=>{queried=true;}},{...scope,lotKey:null});
  assert.equal(result,null);
  assert.equal(queried,false);
});

test("lot-scoped enrichment binds only through exact tenant, profile, tender version and canonical lot",async()=>{
  let query;
  const expected={id:"66666666-6666-4666-8666-666666666666"};
  const result=await bindExactEnrichmentContext({query:async(sql,params)=>{
    query={sql,params};return {rows:[expected]};
  }},{...scope,lotKey:"LOT-1"});
  assert.equal(result,expected);
  assert.match(query.sql,/JOIN tender\.lots lot ON lot\.tender_id=\$2 AND lot\.external_id=\$4/);
  assert.match(query.sql,/enterprise\.tender_profile_id=scope\.profile_id/);
  assert.match(query.sql,/scope\.tenant_id=\$3 AND scope\.company_id=\$6 AND scope\.profile_id=\$7/);
  assert.match(query.sql,/INSERT INTO tender\.enrichment_context_bindings/);
  assert.deepEqual(query.params,[scope.enrichment.id,scope.tender.id,scope.company.tenant_id,
    "LOT-1",scope.enrichment.payload_sha256,scope.company.company_id,scope.company.profile_id]);
});

test("missing canonical identity fails closed instead of guessing IDs",async()=>{
  await assert.rejects(()=>bindExactEnrichmentContext({query:async()=>({rows:[]})},{...scope,lotKey:"LOT-MISSING"}),
    error=>error.code==="EXACT_ENRICHMENT_CONTEXT_REQUIRED");
});
