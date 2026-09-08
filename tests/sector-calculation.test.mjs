import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateSectorTender} from '../platform/sector-calculation.mjs';
import {parameterUnitRules} from '../platform/unit-catalog.mjs';

const scenario=(serviceArea='cleaning')=>({
 serviceArea,effectiveAt:'2026-09-07T00:00:00Z',
 parameters:Object.fromEntries(Object.entries(parameterUnitRules).filter(([key])=>/^C\d\d$/.test(key)||serviceArea==='security'&&/^S\d\d$/.test(key)).map(([key,rule])=>[key,{value:key==='C01'?20:key==='C02'?'Freigegebener Tarif 2026':key==='C03'?{night:0,sunday:0,holiday:0}:0,unit:rule.units[0].id,parameterId:key+'-approved',sourceVersionId:'profile-version-1',validFrom:'2026-01-01',validUntil:null}])),
 facts:{productiveHours:100,duration:12,supplementHours:{night:0,sunday:0,holiday:0}},
 provenance:{productiveHours:{source:'VERIFIED_PROCUREMENT_DOCUMENT'},contractDuration:{source:'VERIFIED_PROCUREMENT_DOCUMENT'}}
});

test('catalog units and all three contribution targets produce an independently calculated reference',()=>{
 const input=scenario();
 for(const [key,value] of Object.entries({C04:20,C05:10,C06:5,C07:2,C08:10,C09:1,C11:100,C12:2,C17:120,C18:5,C19:20,C20:15,C21:10}))input.parameters[key].value=value;
 input.parameters.C03.value.night=10;input.facts.supplementHours.night=20;input.provenance.supplementHours={night:{source:'VERIFIED_SHIFT_SCHEDULE'}};
 input.facts.quantities={C11:2};input.provenance.quantities={C11:{source:'VERIFIED_BILL_OF_QUANTITIES'}};
 const result=calculateSectorTender(input);
 assert.equal(result.status,'CALCULATED');
 assert.deepEqual(Object.fromEntries(['directWages','supplements','employerOnCosts','holidayReserve','sicknessReserve','otherAbsenceReserve','directCosts','attributableCosts','overhead','risk','totalCosts','totalPrice','db1','db2','db3'].map(k=>[k,result[k]])),{
 directWages:2000,supplements:40,employerOnCosts:408,holidayReserve:200,sicknessReserve:100,otherAbsenceReserve:40,directCosts:3188,attributableCosts:3408,overhead:340.8,risk:187.44,totalCosts:3936.24,totalPrice:4373.6,db1:1185.6,db2:965.6,db3:437.36});
 assert.deepEqual(calculateSectorTender(input),result);
});

test('cleaning, security and facility calculations preserve input and formula versions',()=>{
 for(const service of ['cleaning','security','facility_management']){
  const input=scenario(service),first=calculateSectorTender(input);assert.equal(first.status,'CALCULATED');assert.equal(first.totalPrice,2000);
  input.parameters.C01={...input.parameters.C01,value:21,sourceVersionId:'profile-version-2'};
  const changed=calculateSectorTender(input);assert.equal(changed.totalPrice,2100);assert.notEqual(changed.inputVersion,first.inputVersion);assert.equal(first.totalPrice,2000);assert.equal(changed.formulaVersion,first.formulaVersion);
 }
});

test('missing, expired, ambiguous or incorrectly dimensioned values fail without fallback amounts',()=>{
 const mutations=[i=>delete i.parameters.C05,i=>delete i.facts.duration,i=>i.parameters.C01.value='20 or 30',i=>i.parameters.C01.validUntil='2026-01-02',i=>i.parameters.C05.unit='Stunden',i=>delete i.parameters.C01.sourceVersionId,i=>i.parameters.C21.value=100,i=>{i.parameters.C03.value.night=10;delete i.facts.supplementHours.night;},i=>i.parameters.C05.value=-1,i=>i.parameters.C01.value=1e308];
 for(const mutate of mutations){const input=scenario();mutate(input);const result=calculateSectorTender(input);assert.equal(result.status,'CALCULATION_BLOCKED_MISSING_INPUT');assert.ok(result.missing.length);assert.equal(result.totalPrice,undefined);}
});

test('security equipment requires explicitly sourced quantities and preserves per-unit prices',()=>{
 const input=scenario('security');input.parameters.S01.value=1000;input.parameters.S02.value=10;input.parameters.S03.value=5;input.parameters.S04.value=500;
 assert.equal(calculateSectorTender(input).status,'CALCULATION_BLOCKED_MISSING_INPUT');
 input.facts.quantities={S01:1,S02:156,S03:156};input.provenance.quantities=Object.fromEntries(['S01','S02','S03'].map(key=>[key,{source:'VERIFIED_PRICE_SCHEDULE'}]));
 const result=calculateSectorTender(input);assert.equal(result.status,'CALCULATED');assert.equal(result.securityNonPersonnelCosts,3840);assert.equal(result.totalPrice,5840);
});

test('required spreadsheet cell C23 blocks price generation until a sourced positive value exists',()=>{
 const input=scenario();input.facts.requiredCells=[{address:'C23',source:'verified-lot-price-sheet',value:null}];
 assert.ok(calculateSectorTender(input).missing.includes('Pflichtfeld C23'));
 input.facts.requiredCells[0].value=12;assert.equal(calculateSectorTender(input).status,'CALCULATED');
});

 test('obsolete calculation entry points cannot produce prices',async()=>{
 const legacy=await import('../platform/calculation.mjs');
 assert.throws(()=>legacy.calculateScenario({},{}),/legacy_calculation_engine_disabled/);
 assert.throws(()=>legacy.sensitivity({},{}),/legacy_calculation_engine_disabled/);
 });

test('supplement hours require their own evidence even when the supplied amount is zero',()=>{
 const input=scenario('security');input.parameters.C03.value.night=25;
 assert.ok(calculateSectorTender(input).missing.includes('night Zuschlagsstunden Quelle'));
 input.provenance.supplementHours={night:{source:'APPROVED_NO_NIGHT_SHIFTS'}};
 assert.equal(calculateSectorTender(input).status,'CALCULATED');
});
test('date-only validity includes the complete stated day and rejects impossible calendar dates',()=>{
 const input=scenario();input.parameters.C01.validUntil='2026-09-07';input.effectiveAt='2026-09-07T23:59:59.999Z';
 assert.equal(calculateSectorTender(input).status,'CALCULATED');input.effectiveAt='2026-09-08T00:00:00Z';assert.ok(calculateSectorTender(input).missing.includes('C01 Gültigkeit'));
 input.parameters.C01.validUntil=null;input.parameters.C01.validFrom='2026-02-30';assert.ok(calculateSectorTender(input).missing.includes('C01 Gültigkeit'));
});
