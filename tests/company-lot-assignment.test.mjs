import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyTenderServices} from '../platform/service-relevance.mjs';
const company=(id,sector,name=id)=>({company:{company_id:id,sector_slug:sector,legal_name:name,technical_key:id},parameters:[],profile:null});
const companies=[company('cleaning','cleaning'),company('security','security')];
const tender={id:'synthetic',title:'Gebäudereinigung und Bewachung',description:'Zwei unabhängige Lose',cpv_codes:['90911200','79710000']};
test('each lot is classified from its own evidence, without sibling CPVs or title',()=>{
 for(const [id,title,cpv] of [['cleaning','Gebäudereinigung','90911200'],['security','Bewachung','79710000']]){
  const result=classifyTenderServices({tender,lot:{external_id:id,title,cpv_codes:[cpv]},companies});
  assert.equal(result.primary.companyId,id);assert.equal(result.primary.lotKey,id);assert.deepEqual(result.primary.cpvCodes,[cpv]);
 }
 const incomplete=classifyTenderServices({tender,lot:{external_id:'missing',title:'Los 3'},companies});
 assert.equal(incomplete.primary,null);assert.equal(incomplete.overallStatus,'MANUAL_CLASSIFICATION_REQUIRED');
});
test('multiple matching companies require review regardless of names and input order',()=>{
 const matching=[company('one','cleaning','A Company'),company('two','cleaning','Z Company')];
 for(const candidates of [matching,matching.toReversed()]){
  const result=classifyTenderServices({tender:{title:'Gebäudereinigung',cpv_codes:['90911200']},companies:candidates});
  assert.equal(result.primary,null);assert.equal(result.decision.basis,'AMBIGUOUS_COMPANY');assert.ok(result.evaluations.every(x=>!x.primaryCompany&&x.serviceScopeGate==='REVIEW_REQUIRED'));
 }
});
test('a tender cannot invent the company service profile',()=>{
 const result=classifyTenderServices({tender:{title:'Gebäudereinigung',cpv_codes:['90911200']},companies:[company('unconfigured',null,'Example GmbH')]});
 assert.equal(result.primary,null);assert.equal(result.overallStatus,'MANUAL_CLASSIFICATION_REQUIRED');
});
