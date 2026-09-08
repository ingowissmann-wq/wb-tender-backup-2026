import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTenantCalculationSources,requiredCalculationBindings} from '../platform/tenant-calculation-sources.mjs';
const parameters={C03:{value:{night:25}},C11:{value:5,unit:'EUR_PER_UNIT'},C13:{value:1,unit:'EUR_PER_KM'}};
const cells=[{address:'C23',value:100},{address:'C24',value:12},{address:'C25',value:10},{address:'C26',value:20},{address:'C27',value:50}];
const document={id:'file',sha256:'abc',parsed:{worksheets:[{name:'Los 1',rows:[{cells}]}]}};
const bindings=requiredCalculationBindings(parameters).map((x,i)=>({...x,fileId:'file',sheet:'Los 1',cell:'C'+(23+i)}));
test('document cells supply hours, duration, supplements and quantities without fallback values',()=>{
 const result=buildTenantCalculationSources({documents:[document],bindings,parameters});assert.deepEqual(result.missing,[]);
 assert.equal(result.facts.productiveHours,100);assert.equal(result.facts.duration,12);assert.equal(result.facts.supplementHours.night,10);assert.equal(result.facts.quantities.C11,20);assert.equal(result.facts.quantities.C13,50);
 assert.equal(result.provenance.productiveHours.address,'C23');assert.equal(result.provenance.contractDuration.unit,'MONTHS');assert.equal(result.provenance.quantities.C13.fileId,'file');
 assert.deepEqual(buildTenantCalculationSources({documents:[document],bindings,parameters}),result);
});
test('unknown documents, duplicate sources, wrong units and stale formula caches block calculation',()=>{
 for(const alter of [x=>x.bindings[0].fileId='foreign',x=>x.bindings.push({...x.bindings[0]}),x=>x.bindings[0].unit='MONTHS',x=>x.documents[0].parsed.worksheets[0].rows[0].cells[0].formula='A1*B1',x=>x.documents[0].parsed.worksheets[0].rows[0].cells[0].value='5W',x=>x.bindings[0].sheet='Los 2']){
  const input=structuredClone({documents:[document],bindings,parameters});alter(input);assert.ok(buildTenantCalculationSources(input).missing.length);
 }
});

test('calculation request identity survives PostgreSQL JSONB object-key ordering',async()=>{
 const {snapshotHash}=await import('../platform/canonical-truth.mjs');
 const input={assignmentId:'lot',bindings,confirmed:true};
 const reordered=JSON.parse(JSON.stringify(input),(_,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).reverse()):value);
 assert.equal(snapshotHash(input),snapshotHash(reordered));
});
