const reference=/^([A-Z]{1,3})([1-9][0-9]*)$/;
const columnNumber=letters=>[...letters].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
const columnName=value=>{let out='';while(value>0){value--;out=String.fromCharCode(65+value%26)+out;value=Math.floor(value/26)}return out};
function rangeCells(value,budget){
 const addresses=[];
 for(const range of String(value||'').replaceAll('$','').split(/\s+/).filter(Boolean)){
  const [start,end=start,...extra]=range.split(':'),a=reference.exec(start),b=reference.exec(end);
  if(extra.length||!a||!b)throw new Error('SPREADSHEET_VALIDATION_RANGE_UNSUPPORTED');
  const left=columnNumber(a[1]),right=columnNumber(b[1]),top=Number(a[2]),bottom=Number(b[2]);
  if(left>right||top>bottom||right>16384||bottom>1048576||(right-left+1)*(bottom-top+1)>budget-addresses.length)throw new Error('SPREADSHEET_VALIDATION_RANGE_REQUIRES_REVIEW');
  for(let row=top;row<=bottom;row++)for(let col=left;col<=right;col++)addresses.push(columnName(col)+row);
 }
 if(!addresses.length)throw new Error('SPREADSHEET_VALIDATION_RANGE_UNSUPPORTED');
 return addresses;
}
const valueOf=cell=>cell?.formula?cell.result:cell?.value??cell?.displayed;
const blank=value=>value===null||value===undefined||typeof value==='string'&&!value.trim();
const decimal=value=>typeof value==='number'&&Number.isFinite(value)?value:typeof value==='string'&&/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())&&Number.isFinite(Number(value))?Number(value):null;

// Only explicit workbook validation rules establish a required field. An address
// such as C23 by itself says nothing about the value's business meaning.
export function validateRequiredSpreadsheetInputs(documents,{maxCells=20000}={}){
 const checks=[],missing=[];let remaining=maxCells;
 for(const document of [...documents].sort((a,b)=>String(a.id).localeCompare(String(b.id)))){
  if(document.procurement_verification_status!=='VERIFIED')continue;
  for(const sheet of document.extracted_data?.worksheets||[]){
   const cells=new Map((sheet.rows||[]).flatMap(row=>(row.cells||[]).map(cell=>[cell.address,cell])));
   for(const rule of sheet.dataValidations||[]){
    if(rule.allowBlank===true)continue;
    let addresses;
    try{addresses=rangeCells(rule.range,remaining);remaining-=addresses.length;}
    catch(error){missing.push({documentId:document.id,sheet:sheet.name,address:rule.range,code:error.message});continue;}
    for(const address of addresses){
     const value=valueOf(cells.get(address)),source={documentId:document.id,hash:document.payload_sha256,sheet:sheet.name,address};
     let code=null;
     if(blank(value))code='SPREADSHEET_REQUIRED_VALUE_MISSING';
     else if(rule.type==='list'){
      const literal=/^"([^"]*)"$/.exec(String(rule.formula1||''));
      if(!literal)code='SPREADSHEET_VALIDATION_REQUIRES_REVIEW';
      else if(!literal[1].split(',').includes(String(value)))code='SPREADSHEET_VALUE_NOT_IN_LIST';
     }else if(['decimal','whole','textLength'].includes(rule.type)){
      const actual=rule.type==='textLength'?String(value).length:decimal(value),a=decimal(rule.formula1),b=decimal(rule.formula2),operator=rule.operator||'between';
      if(actual===null||rule.type==='whole'&&!Number.isInteger(actual))code='SPREADSHEET_VALUE_TYPE_INVALID';
      else if(a===null||['between','notBetween'].includes(operator)&&b===null)code='SPREADSHEET_VALIDATION_REQUIRES_REVIEW';
      else{
       const comparison={between:()=>actual>=a&&actual<=b,notBetween:()=>actual<a||actual>b,equal:()=>actual===a,notEqual:()=>actual!==a,greaterThan:()=>actual>a,lessThan:()=>actual<a,greaterThanOrEqual:()=>actual>=a,lessThanOrEqual:()=>actual<=a}[operator];
       if(!comparison)code='SPREADSHEET_VALIDATION_REQUIRES_REVIEW';else if(!comparison())code='SPREADSHEET_VALUE_OUT_OF_RANGE';
      }
     }else code='SPREADSHEET_VALIDATION_REQUIRES_REVIEW';
     checks.push({...source,type:rule.type,operator:rule.operator,formula1:rule.formula1,formula2:rule.formula2,value:value??null,status:code||'VALID'});
     if(code)missing.push({...source,code});
    }
   }
  }
 }
 return {checks,missing};
}
