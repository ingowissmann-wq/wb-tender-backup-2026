import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {validateCompanyProfileInput} from '../platform/tenant-company-profiles.mjs';
import {parameterUnitRules} from '../platform/unit-catalog.mjs';
import {calculateSectorTender} from '../platform/sector-calculation.mjs';
const input=(serviceLine='cleaning')=>({id:crypto.randomUUID(),serviceLine,validFrom:'2026-09-01',confirmed:true,regions:{regions:[{type:'STATE',state:'Bayern'}]},parameters:Object.fromEntries(Object.entries(parameterUnitRules).filter(([key])=>key.startsWith('C')||serviceLine==='security').map(([key,rule])=>[key,{value:key==='C01'?20:key==='C02'?'Freigegebener Tarif 2026':key==='C03'?{night:0,sunday:0,holiday:0}:0,unit:rule.units[0].id,source:'SYNTHETIC approved reference'}]))});
test('versioned company inputs feed the single engine for cleaning, security and facility without default costs',()=>{
 for(const service of ['cleaning','security','facility_management']){
  const source=input(service),validated=validateCompanyProfileInput(source);
  assert.deepEqual(validateCompanyProfileInput(source),validated);
  assert.equal(validated.parameters.C01.sourceVersionId,source.id);
  const result=calculateSectorTender({serviceArea:service,parameters:validated.parameters,effectiveAt:'2026-09-08',facts:{productiveHours:100,duration:12},provenance:{productiveHours:{source:'VERIFIED_TENDER'},contractDuration:{source:'VERIFIED_TENDER'}}});
  assert.equal(result.status,'CALCULATED');assert.equal(result.totalPrice,2000);
 }
});
test('company profiles require explicit approval, every cost source, correct units and effective dates',()=>{
 const mutations=[x=>x.confirmed=false,x=>delete x.parameters.C05,x=>x.parameters.C01.source='',x=>x.parameters.C01.unit='EUR/Monat',x=>x.parameters.C01.value='',x=>x.parameters.C03.value={},x=>x.parameters.C20.value=100,x=>x.validFrom='2026-02-30',x=>x.validUntil='2026-01-01',x=>x.parameters.C01.validFrom='2027-01-01',x=>x.regions.regions=[],x=>x.parameters.UNKNOWN={value:1}];
 for(const mutate of mutations){const value=input();mutate(value);assert.throws(()=>validateCompanyProfileInput(value),/company_profile_/)}
});
