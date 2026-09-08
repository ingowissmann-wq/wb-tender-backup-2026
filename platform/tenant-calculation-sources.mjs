import {normalizeDecimal} from './unit-catalog.mjs';
import {validateRequiredSpreadsheetInputs} from './spreadsheet-required-inputs.mjs';
const reference=/^[A-Z]{1,3}[1-9][0-9]{0,6}$/;
const units={productiveHours:'HOURS',duration:'MONTHS'};
export function requiredCalculationBindings(parameters){
 const required=[{key:'productiveHours',unit:'HOURS'},{key:'duration',unit:'MONTHS'}];
 for(const [kind,rate] of Object.entries(parameters.C03?.value||{}))if(normalizeDecimal(rate)!==0)required.push({key:'supplementHours.'+kind,unit:'HOURS'});
 const quantityUnits={EUR_PER_UNIT:'UNITS',EUR_PER_OBJECT:'OBJECTS',EUR_PER_KM:'KM',EUR_PER_FTE:'FTE',EUR_PER_WEEK:'WEEKS'};
 for(const [key,item] of Object.entries(parameters))if(normalizeDecimal(item.value)!==0&&quantityUnits[item.unit])required.push({key:'quantities.'+key,unit:quantityUnits[item.unit]});
 return required;
}
export function buildTenantCalculationSources({documents,bindings,parameters}){
 const missing=[],facts={supplementHours:{},quantities:{}},provenance={quantities:{},supplementHours:{}};
 const required=requiredCalculationBindings(parameters),allowed=new Set(required.map(x=>x.key));
 if(!Array.isArray(bindings)||bindings.length>100)return {facts,provenance,missing:['CALCULATION_BINDINGS_INVALID']};
 if(bindings.some(x=>!x||!allowed.has(x.key)))missing.push('CALCULATION_BINDING_UNKNOWN');
 for(const definition of required){
  const options=bindings.filter(x=>x.key===definition.key);
  if(options.length!==1){missing.push(definition.key+':EXACTLY_ONE_SOURCE_REQUIRED');continue;}
  const binding=options[0];
  if(binding.unit!==definition.unit||!reference.test(binding.cell||'')||typeof binding.sheet!=='string'||binding.sheet.length>128){missing.push(definition.key+':SOURCE_REFERENCE_INVALID');continue;}
  const matches=documents.filter(x=>x.id===binding.fileId);
  if(matches.length!==1){missing.push(definition.key+':OWN_DOCUMENT_REQUIRED');continue;}
  const document=matches[0],sheets=document.parsed?.worksheets?.filter(x=>x.name===binding.sheet)||[];
  if(sheets.length!==1){missing.push(definition.key+':WORKSHEET_NOT_UNIQUE');continue;}
  const cells=sheets[0].rows.flatMap(row=>row.cells||[]).filter(cell=>cell.address===binding.cell);
  if(cells.length!==1||cells[0].formula){missing.push(definition.key+':LITERAL_CELL_REQUIRED');continue;}
  const value=normalizeDecimal(cells[0].value);
  if(value===null||value<0||units[definition.key]&&value===0){missing.push(definition.key+':SOURCE_VALUE_INVALID');continue;}
  const evidence={source:'USER_CONFIRMED_DOCUMENT_CELL',fileId:document.id,sha256:document.sha256,sheet:binding.sheet,address:binding.cell,unit:binding.unit,value};
  if(definition.key.startsWith('quantities.')){const key=definition.key.slice(11);facts.quantities[key]=value;provenance.quantities[key]=evidence;}
  else if(definition.key.startsWith('supplementHours.')){const key=definition.key.slice(16);facts.supplementHours[key]=value;provenance.supplementHours[key]=evidence;}
  else {facts[definition.key]=value;provenance[definition.key==='duration'?'contractDuration':definition.key]=evidence;}
 }
 const validation=validateRequiredSpreadsheetInputs(documents.map(document=>({id:document.id,payload_sha256:document.sha256,procurement_verification_status:'VERIFIED',extracted_data:document.parsed})));
 // VERIFIED here selects validation rules only; it is not a procurement-source claim.
 provenance.spreadsheetValidation=validation.checks;
 for(const item of validation.missing)missing.push(`${item.documentId}:${item.sheet}:${item.address}:${item.code}`);
 return {facts,provenance,missing};
}
