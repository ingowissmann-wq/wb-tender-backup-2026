import {snapshotHash} from './canonical-truth.mjs';
import {requiredCalculationBindings} from './tenant-calculation-sources.mjs';
import {normalizeDecimal} from './unit-catalog.mjs';
const fail=message=>Object.assign(new Error(message),{statusCode:409});

// Numeric source values may change. Text, formulas, addresses and declared
// validation rules identify the approved layout and must remain unchanged.
export function calculationLayoutHash(parsed,bindings){
 if(!Array.isArray(parsed?.worksheets)||!parsed.worksheets.length)throw fail('calculation_template_layout_missing');
 const worksheets=parsed.worksheets.map(sheet=>({...sheet,rows:sheet.rows.map(row=>({...row,cells:(row.cells||[]).map(cell=>{
  if(bindings.some(x=>x.sheet===sheet.name&&x.cell===cell.address)){
   if(cell.formula||normalizeDecimal(cell.value)===null)throw fail('calculation_template_numeric_source_required');
   return {...cell,value:'NUMERIC_INPUT',displayed:'NUMERIC_INPUT'};
  }
  return cell;
 })}))}));
 return snapshotHash({worksheets,definedNames:parsed.definedNames??[]});
}

export function applyCalculationTemplate({bindings,sourceDocuments,targetDocuments,fileMap,parameters}){
 const sourceIds=[...new Set(bindings.map(x=>x.fileId))].sort();
 if(!fileMap||typeof fileMap!=='object'||Array.isArray(fileMap)||snapshotHash(Object.keys(fileMap).sort())!==snapshotHash(sourceIds))throw fail('calculation_template_file_map_invalid');
 const required=requiredCalculationBindings(parameters).map(x=>({key:x.key,unit:x.unit})).sort((a,b)=>a.key.localeCompare(b.key));
 const selected=bindings.map(x=>({key:x.key,unit:x.unit})).sort((a,b)=>a.key.localeCompare(b.key));
 if(snapshotHash(required)!==snapshotHash(selected))throw fail('calculation_template_profile_inputs_changed');
 const layouts=[];
 for(const sourceId of sourceIds){
  const source=sourceDocuments.filter(x=>x.id===sourceId),target=targetDocuments.filter(x=>x.id===fileMap[sourceId]);
  if(source.length!==1||target.length!==1)throw fail('calculation_template_own_files_required');
  const definitions=bindings.filter(x=>x.fileId===sourceId);
  const sourceHash=calculationLayoutHash(source[0].parsed,definitions),targetHash=calculationLayoutHash(target[0].parsed,definitions);
  if(sourceHash!==targetHash)throw fail('calculation_template_layout_changed');
  layouts.push({sourceFileId:sourceId,targetFileId:target[0].id,layoutSha256:sourceHash});
 }
 return {bindings:bindings.map(x=>({...x,fileId:fileMap[x.fileId]})),layouts};
}
