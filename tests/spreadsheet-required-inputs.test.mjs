import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRequiredSpreadsheetInputs} from '../platform/spreadsheet-required-inputs.mjs';
const document=(value,rule={range:'C23',type:'decimal',operator:'greaterThan',formula1:'0',allowBlank:false})=>({id:'verified-document',payload_sha256:'a'.repeat(64),procurement_verification_status:'VERIFIED',extracted_data:{worksheets:[{name:'Kalkulation',rows:[{cells:value===undefined?[]:[{address:'C23',value}]}],dataValidations:[rule]}]}});
test('C23 is required according to its actual workbook rule, including absent XML cells',()=>{
 for(const value of [undefined,null,'',0,-1,'nicht belegt'])assert.equal(validateRequiredSpreadsheetInputs([document(value)]).missing.length,1);
 const result=validateRequiredSpreadsheetInputs([document('12.5')]);assert.equal(result.missing.length,0);assert.equal(result.checks[0].address,'C23');assert.equal(result.checks[0].hash,'a'.repeat(64));assert.equal(result.checks[0].value,'12.5');
});
test('text frequencies in C23 remain text and are checked against the declared allowed values',()=>{
 const rule={range:'C23',type:'list',formula1:'"1M,5W,2J"',allowBlank:false};
 assert.equal(validateRequiredSpreadsheetInputs([document('1M',rule)]).missing.length,0);
 assert.equal(validateRequiredSpreadsheetInputs([document('99W',rule)]).missing[0].code,'SPREADSHEET_VALUE_NOT_IN_LIST');
 const noRule=document('1M');noRule.extracted_data.worksheets[0].dataValidations=[];assert.deepEqual(validateRequiredSpreadsheetInputs([noRule]),{checks:[],missing:[]});
});
test('unknown formulas, excessive ranges and invalid numeric values require review, never default values',()=>{
 const cases=[document(5,{range:'C23',type:'custom',formula1:'EXTERNAL(A1)',allowBlank:false}),document(5,{range:'A1:XFD1048576',type:'decimal',allowBlank:false}),document('9'.repeat(400))];
 for(const item of cases)assert.equal(validateRequiredSpreadsheetInputs([item]).missing.length,1);
 const optional=document(undefined,{range:'C23',type:'whole',formula1:'0',formula2:'10',allowBlank:true});assert.deepEqual(validateRequiredSpreadsheetInputs([optional]),{checks:[],missing:[]});
});
