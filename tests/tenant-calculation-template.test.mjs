import test from 'node:test';
import assert from 'node:assert/strict';
import {applyCalculationTemplate} from '../platform/tenant-calculation-template.mjs';
import {buildTenantCalculationSources} from '../platform/tenant-calculation-sources.mjs';
const parameters={C03:{value:{night:0}}};
const bindings=[{key:'productiveHours',unit:'HOURS',fileId:'source',sheet:'Input',cell:'C23'},{key:'duration',unit:'MONTHS',fileId:'source',sheet:'Input',cell:'C24'}];
const parsed=hours=>({worksheets:[{name:'Input',rows:[{cells:[{address:'B23',value:'Total approved hours'},{address:'C23',value:String(hours),displayed:String(hours)},{address:'C24',value:'12',displayed:'12'}]}],dataValidations:[]}]});
const fixture=()=>({bindings:structuredClone(bindings),sourceDocuments:[{id:'source',parsed:parsed(100)}],targetDocuments:[{id:'new',sha256:'new-file-hash',parsed:parsed(150)}],fileMap:{source:'new'},parameters});
test('approved template reuses mappings but reads new values with new-file provenance',()=>{
 const input=fixture(),result=applyCalculationTemplate(input);
 assert.deepEqual(result.bindings,bindings.map(x=>({...x,fileId:'new'})));
 const calculated=buildTenantCalculationSources({documents:input.targetDocuments,bindings:result.bindings,parameters});
 assert.equal(calculated.facts.productiveHours,150);assert.deepEqual(calculated.missing,[]);
 assert.equal(calculated.provenance.productiveHours.fileId,'new');assert.equal(calculated.provenance.productiveHours.sha256,'new-file-hash');
 assert.deepEqual(applyCalculationTemplate(input),result);assert.equal(input.bindings[0].fileId,'source');
});
test('template rejects changed labels, formulas, validation, missing cells and unknown document bindings',()=>{
 for(const alter of [
  x=>x.targetDocuments[0].parsed.worksheets[0].rows[0].cells[0].value='Annual area',
  x=>x.targetDocuments[0].parsed.worksheets[0].rows[0].cells[1].formula='A1*B1',
  x=>x.targetDocuments[0].parsed.worksheets[0].dataValidations.push({range:'C23',allowBlank:true}),
  x=>x.targetDocuments[0].parsed.worksheets[0].rows[0].cells.pop(),
  x=>x.targetDocuments[0].parsed.worksheets[0].rows[0].cells[1].value='unknown',
  x=>x.fileMap.foreign='new',x=>x.fileMap.source='foreign',x=>x.fileMap={},
  x=>x.parameters={C03:{value:{night:25}}},
 ]){const input=fixture();alter(input);assert.throws(()=>applyCalculationTemplate(input),/calculation_template_/);}
});
