import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateTenantLot} from '../platform/tenant-lot-assignments.mjs';
import {validateStructuredRegionConfiguration} from '../platform/structured-regions.mjs';
const regions=(await validateStructuredRegionConfiguration({regions:[{id:'bayern',type:'STATE',state:'Bayern'}]})).configuration;
const tender={id:'t',tender_version_id:'v1',title:'bundesweit',regions:['DE300']};
const lot={lot_key:'L1',eligible_lot_count:2};
const normalized={lots:[{id:'L1',title:'Gebäudereinigung'},{id:'L2',title:'Bewachung Berlin'}],raw:{tender:{items:[{relatedLot:'L1',classification:{id:'90910000'},deliveryAddress:{region:'DE212'}},{relatedLot:'L2',classification:{id:'79710000'},deliveryAddress:{region:'DE300'}}]}}};
const profile={id:'p1',company_id:'c1',display_name:'Eigene Gesellschaft',service_line:'cleaning',regions,version:1};
test('customer company profiles assign a lot only for a unique service and region match',()=>{
 const result=evaluateTenantLot({tender,lot,normalized,profiles:[profile]});
 assert.equal(result.assignment_kind,'AUTOMATIC');assert.equal(result.company_id,'c1');assert.equal(result.details.locations.length,1);
 assert.deepEqual(evaluateTenantLot({tender,lot,normalized,profiles:[profile]}),result);
 const ambiguous=evaluateTenantLot({tender,lot,normalized,profiles:[profile,{...profile,id:'p2',company_id:'c2'}]});assert.equal(ambiguous.assignment_kind,'REVIEW_REQUIRED');assert.equal(ambiguous.company_id,null);
 const outside=evaluateTenantLot({tender,lot:{...lot,lot_key:'L2'},normalized,profiles:[{...profile,service_line:'security'}]});assert.equal(outside.assignment_kind,'REVIEW_REQUIRED');
});
test('saved manual decisions survive changed imports but cannot auto-clear source review',()=>{
 const prior={assignment_kind:'MANUAL',company_id:'c1',profile_id:'p1',source_version_id:'v1',details:{manualDecision:{companyId:'c1',profileId:'p1',sourceVersionId:'v1',reason:'explicitly reviewed'}}};
 const changed=evaluateTenantLot({tender:{...tender,tender_version_id:'v2'},lot,normalized,profiles:[profile],prior});
 assert.equal(changed.assignment_kind,'REVIEW_REQUIRED');assert.equal(changed.company_id,'c1');
 const repeated=evaluateTenantLot({tender:{...tender,tender_version_id:'v2'},lot,normalized,profiles:[profile],prior:{...changed,source_version_id:'v2'}});
 assert.deepEqual(repeated,changed);
});
test('all three service lines use their own lot evidence and never guess missing locations',()=>{
 for(const [service,title,cpv] of [['cleaning','Gebäudereinigung','90910000'],['security','Bewachung','79710000'],['facility_management','Hausmeisterdienst','79993100']]){
  const source={lots:[{id:'L1',title}],raw:{tender:{items:[{relatedLot:'L1',classification:{id:cpv},deliveryAddress:{region:'DE212'}}]}}};
  assert.equal(evaluateTenantLot({tender,lot,normalized:source,profiles:[{...profile,service_line:service}]}).assignment_kind,'AUTOMATIC');
  delete source.raw.tender.items[0].deliveryAddress;
  assert.equal(evaluateTenantLot({tender,lot,normalized:source,profiles:[{...profile,service_line:service}]}).assignment_kind,'REVIEW_REQUIRED');
 }
});
