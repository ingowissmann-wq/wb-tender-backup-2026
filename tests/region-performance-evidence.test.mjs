import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateStructuredRegions,STRUCTURED_REGION_SCHEMA} from '../platform/structured-regions.mjs';
import {classifyRegion} from '../platform/region-gate.mjs';
const profile=(...rules)=>({schema:STRUCTURED_REGION_SCHEMA,regions:rules.map(rule=>({...rule,validationStatus:'VALID'}))});
const nuts=profile({id:'bw',type:'NUTS',nutsCode:'DE1'});

test('every performance location is retained and checked deterministically',()=>{
 const locations=[{nuts:'DE122',city:'Karlsruhe',district:'Stadtkreis Karlsruhe'},{nuts:'DE111',city:'Stuttgart'}];
 const forward=evaluateStructuredRegions(nuts,locations),reverse=evaluateStructuredRegions(nuts,locations.toReversed());
 assert.equal(forward.classification,'CORE_REGION');assert.equal(forward.locations.length,2);assert.deepEqual(forward,reverse);
 const mixed=evaluateStructuredRegions(nuts,[...locations,{nuts:'DE300'}]);
 assert.equal(mixed.classification,'MULTI_REGION_REVIEW');assert.equal(mixed.locations.filter(x=>x.classification==='OUTSIDE_CORE_REGION').length,1);
});
test('missing, contradictory, buyer-only and nationwide evidence cannot authorize a region',()=>{
 for(const locations of [[{}],[{nuts:'DE122',state:'Berlin'}],[{nuts:'DE',city:'Karlsruhe'}],[{nuts:'DE122',role:'BUYER'}]])assert.equal(evaluateStructuredRegions(nuts,locations).classification,'REGION_UNRESOLVED');
 const postcode=profile({type:'POSTAL_CODE',postalCode:'76131'});
 assert.equal(evaluateStructuredRegions(postcode,[{city:'Karlsruhe'}]).classification,'REGION_UNRESOLVED');
 const district=profile({type:'NUTS',nutsCode:'DE122'});
 assert.equal(evaluateStructuredRegions(district,[{nuts:'DE1'}]).classification,'REGION_UNRESOLVED');
});
test('absent or invalid coordinates never become zero or an outside decision',()=>{
 const radius=profile({type:'PLACE_RADIUS',latitude:49,longitude:8.4,radiusKm:20});
 for(const [latitude,longitude] of [[null,null],['',''],[true,false],[91,8],[49,181]])assert.equal(evaluateStructuredRegions(radius,[{latitude,longitude}]).classification,'REGION_UNRESOLVED');
});
test('structured gate preserves nationwide uncertainty despite a matching local address',()=>{
 const result=classifyRegion({company:{company_id:'synthetic'},tender:{id:'synthetic',title:'Bundesweite Reinigung',locations:[{nuts:'DE122'}]},config:{structuredRegions:nuts}});
 assert.equal(result.classification,'MULTI_REGION_REVIEW');assert.notEqual(result.decision,'REGION_GATE_PASSED');
});
