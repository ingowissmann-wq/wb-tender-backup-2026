import crypto from "node:crypto";
import path from "node:path";
import JSZip from "jszip";

export const DOCX_MIME="application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_MIME="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_FIELDS=500,MAX_VALUE_LENGTH=20_000;
const decode=value=>String(value??"").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,"&");
const encode=value=>String(value??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
const textNodes=xml=>[...String(xml||"").matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(match=>decode(match[1])).join("");
const attrs=raw=>Object.fromEntries([...String(raw||"").matchAll(/([\w:.-]+)="([^"]*)"/g)].map(match=>[match[1],decode(match[2])]));
const safeId=value=>String(value||"").trim().slice(0,200);
const requiredByName=name=>/^(?:REQ(?:UIRED)?[:_.-]|PFLICHT[:_.-])/i.test(String(name||""));
const hash=buffer=>crypto.createHash("sha256").update(buffer).digest("hex");

const loadSafeZip=async(buffer,mimeType)=>{
  if(!Buffer.isBuffer(buffer)||buffer.length<4||buffer.subarray(0,2).toString()!=="PK")throw new Error("office_archive_invalid");
  const zip=await JSZip.loadAsync(buffer,{checkCRC32:true});
  if(zip.file("word/vbaProject.bin")||zip.file("xl/vbaProject.bin")||zip.file("vbaProject.bin"))throw new Error("office_macro_forbidden");
  const types=await zip.file("[Content_Types].xml")?.async("string")||"";
  if(/macroEnabled/i.test(types))throw new Error("office_macro_forbidden");
  if(![DOCX_MIME,XLSX_MIME].includes(mimeType))throw new Error("office_mime_unsupported");
  return zip;
};

const inspectDocx=async(zip)=>{
  const entry=zip.file("word/document.xml");if(!entry)throw new Error("docx_document_missing");
  const xml=await entry.async("string"),fields=[],ids=new Set();let index=0;
  for(const match of xml.matchAll(/<w:sdt(?:\s[^>]*)?>([\s\S]*?)<\/w:sdt>/g)){
    index++;const body=match[1],properties=body.match(/<w:sdtPr(?:\s[^>]*)?>([\s\S]*?)<\/w:sdtPr>/)?.[1]||"",
      content=body.match(/<w:sdtContent(?:\s[^>]*)?>([\s\S]*?)<\/w:sdtContent>/)?.[1]||"",
      tag=decode(properties.match(/<w:tag\b[^>]*w:val="([^"]*)"[^>]*\/?\s*>/)?.[1]||""),
      alias=decode(properties.match(/<w:alias\b[^>]*w:val="([^"]*)"[^>]*\/?\s*>/)?.[1]||""),
      id=safeId(`docx:${tag||alias||index}`);
    if(ids.has(id))throw new Error("office_field_id_duplicate");ids.add(id);
    const options=[...properties.matchAll(/<w:listItem\b[^>]*(?:w:displayText|w:value)="([^"]*)"[^>]*\/?\s*>/g)].map(item=>decode(item[1])),
      type=/<w14:checkbox\b|<w:checkBox\b/.test(properties)?"checkbox":/<w:date\b/.test(properties)?"date":/<w:(?:dropDownList|comboBox)\b/.test(properties)?"select":"text",
      checked=/<w14:checked\b[^>]*w14:val="(?:1|true|on)"/.test(properties),value=type==="checkbox"?checked:textNodes(content);
    fields.push({id,label:alias||tag||`Feld ${index}`,type,required:requiredByName(tag),value,options,source:{part:"word/document.xml",index,tag:tag||null}});
  }
  return {format:"DOCX",fields,structuredFieldCount:fields.length,editable:fields.length>0,manualReview:fields.length===0};
};

const columnNumber=letters=>{let value=0;for(const char of letters)value=value*26+char.charCodeAt(0)-64;return value};
const columnLetters=number=>{let value="";for(let n=number;n>0;n=Math.floor((n-1)/26))value=String.fromCharCode(65+(n-1)%26)+value;return value};
const expandRange=range=>{
  const clean=String(range||"").replaceAll("$","").trim(),parts=clean.split(":"),parse=value=>{const match=value.match(/^([A-Z]{1,3})([1-9][0-9]{0,6})$/i);return match?{column:columnNumber(match[1].toUpperCase()),row:Number(match[2])}:null},start=parse(parts[0]),end=parse(parts[1]||parts[0]);
  if(!start||!end||end.column<start.column||end.row<start.row||(end.column-start.column+1)*(end.row-start.row+1)>MAX_FIELDS)return[];
  const result=[];for(let row=start.row;row<=end.row;row++)for(let column=start.column;column<=end.column;column++)result.push(`${columnLetters(column)}${row}`);return result;
};
const cellFromXml=(xml,address,sharedStrings)=>{
  const escaped=address.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),match=xml.match(new RegExp(`<c\\b([^>]*\\br="${escaped}"[^>]*)>([\\s\\S]*?)<\\/c>`));
  if(!match)return null;const attributes=attrs(match[1]),body=match[2],formula=body.match(/<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/)?.[1]||null,raw=body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1]??"",inline=body.match(/<is(?:\s[^>]*)?>([\s\S]*?)<\/is>/)?.[1],value=inline!==undefined?decode(inline.replace(/<[^>]+>/g,"")):attributes.t==="s"?sharedStrings[Number(raw)]??"":decode(raw);
  return {match,attributes,formula,value};
};
const inspectXlsx=async(zip)=>{
  const workbook=await zip.file("xl/workbook.xml")?.async("string"),relsXml=await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if(!workbook||!relsXml)throw new Error("xlsx_workbook_missing");
  const sharedXml=await zip.file("xl/sharedStrings.xml")?.async("string")||"",shared=[...sharedXml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map(match=>decode(match[1].replace(/<[^>]+>/g,""))),
    rels=new Map([...relsXml.matchAll(/<Relationship\b([^>]+)\/?\s*>/g)].map(match=>{const a=attrs(match[1]);return[a.Id,a.Target]})),
    sheets=[...workbook.matchAll(/<sheet\b([^>]+)\/?\s*>/g)].map((match,index)=>{const a=attrs(match[1]),target=rels.get(a["r:id"]),part=target?path.posix.normalize(`xl/${target}`.replace("xl//","xl/")):null;return{name:a.name||`Tabelle ${index+1}`,index,part}}),
    names=[...workbook.matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g)].map(match=>({attributes:attrs(match[1]),reference:decode(match[2])})),fields=[],ids=new Set();
  const sheetCache=new Map();for(const sheet of sheets){if(!sheet.part||!sheet.part.startsWith("xl/worksheets/"))continue;const xml=await zip.file(sheet.part)?.async("string");if(xml)sheetCache.set(sheet.name,{...sheet,xml})}
  const candidates=[];
  for(const item of names){if(item.attributes.hidden==="1"||/^_xlnm\./i.test(item.attributes.name||""))continue;const reference=item.reference.match(/^(?:'((?:[^']|'')+)'|([^'!]+))!\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})$/i);if(!reference)continue;candidates.push({sheetName:(reference[1]||reference[2]).replace(/''/g,"'"),address:`${reference[3].toUpperCase()}${reference[4]}`,name:item.attributes.name,source:"DEFINED_NAME"})}
  for(const sheet of sheetCache.values())for(const match of sheet.xml.matchAll(/<dataValidation\b([^>]*)>([\s\S]*?)<\/dataValidation>/g)){const a=attrs(match[1]),options=a.type==="list"?decode(match[2].match(/<formula1>([\s\S]*?)<\/formula1>/)?.[1]||"").replace(/^"|"$/g,"").split(",").filter(Boolean):[];for(const address of String(a.sqref||"").split(/\s+/).flatMap(expandRange))candidates.push({sheetName:sheet.name,address,name:`${sheet.name}_${address}`,source:"DATA_VALIDATION",validation:{type:a.type||"text",allowBlank:a.allowBlank==="1",options}})}
  for(const candidate of candidates){const sheet=sheetCache.get(candidate.sheetName),cell=sheet&&cellFromXml(sheet.xml,candidate.address,shared);if(!cell||cell.formula)continue;const id=safeId(`xlsx:${candidate.sheetName}!${candidate.address}`);if(ids.has(id))continue;ids.add(id);const validation=candidate.validation||{},numericCell=!cell.attributes.t&&cell.value!==""&&Number.isFinite(Number(cell.value)),type=validation.type==="whole"||validation.type==="decimal"||candidate.source==="DEFINED_NAME"&&numericCell?"number":validation.type==="date"?"date":validation.type==="list"?"select":"text";fields.push({id,label:candidate.name||`${candidate.sheetName} ${candidate.address}`,type,required:requiredByName(candidate.name)||validation.allowBlank===false&&candidate.source==="DATA_VALIDATION",value:cell.value,options:validation.options||[],source:{part:sheet.part,sheet:candidate.sheetName,address:candidate.address,kind:candidate.source}})}
  return {format:"XLSX",fields,structuredFieldCount:fields.length,editable:fields.length>0,manualReview:fields.length===0};
};

export const inspectOfficeForm=async(buffer,mimeType)=>{const zip=await loadSafeZip(buffer,mimeType),inspection=mimeType===DOCX_MIME?await inspectDocx(zip):await inspectXlsx(zip);return{...inspection,mimeType,sourceSha256:hash(buffer),originalUnchanged:true}};

const normalizedValues=(inspection,values)=>{
  if(!values||typeof values!=="object"||Array.isArray(values))throw new Error("office_form_values_invalid");
  const fields=new Map(inspection.fields.map(field=>[field.id,field])),entries=Object.entries(values);if(entries.length>MAX_FIELDS)throw new Error("office_form_too_many_values");
  for(const [id,raw] of entries){const field=fields.get(id);if(!field)throw new Error("office_form_field_unknown");if(typeof raw!=="string"&&typeof raw!=="number"&&typeof raw!=="boolean")throw new Error("office_form_value_invalid");const value=typeof raw==="string"?raw:raw;if(String(value).length>MAX_VALUE_LENGTH)throw new Error("office_form_value_too_long");if(field.type==="number"&&value!==""&&!Number.isFinite(Number(value)))throw new Error("office_form_number_invalid");if(field.type==="select"&&field.options.length&&!field.options.includes(String(value)))throw new Error("office_form_option_invalid")}
  for(const field of inspection.fields)if(field.required&&String(values[field.id]??field.value??"").trim()==="")throw new Error("office_form_required_value_missing");
  return Object.fromEntries(inspection.fields.map(field=>[field.id,values[field.id]??field.value??""]));
};

const fillDocx=async(zip,inspection,values)=>{
  const entry=zip.file("word/document.xml"),xml=await entry.async("string");let index=0;
  const next=xml.replace(/<w:sdt(?:\s[^>]*)?>([\s\S]*?)<\/w:sdt>/g,whole=>{index++;const field=inspection.fields.find(item=>item.source.index===index);if(!field)return whole;const value=values[field.id],encoded=encode(value),replacement=whole.replace(/(<w:sdtContent(?:\s[^>]*)?>)([\s\S]*?)(<\/w:sdtContent>)/,(_,open,content,close)=>{let written=false,nextContent=content.replace(/(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g,(_text,start,_value,end)=>{if(written)return`${start}${end}`;written=true;return`${start}${field.type==="checkbox"?(value?"☒":"☐"):encoded}${end}`});if(!written)nextContent=`<w:r><w:t xml:space="preserve">${field.type==="checkbox"?(value?"☒":"☐"):encoded}</w:t></w:r>`;return`${open}${nextContent}${close}`});return field.type==="checkbox"?replacement.replace(/(<w14:checked\b[^>]*w14:val=")[^"]*(")/,`$1${value?"1":"0"}$2`):replacement});
  zip.file("word/document.xml",next);
};
const fillXlsx=async(zip,inspection,values)=>{
  const byPart=new Map();for(const field of inspection.fields){if(!byPart.has(field.source.part))byPart.set(field.source.part,[]);byPart.get(field.source.part).push(field)}
  for(const [part,fields] of byPart){const entry=zip.file(part);let xml=await entry.async("string");for(const field of fields){const cell=cellFromXml(xml,field.source.address,[]);if(!cell)throw new Error("office_form_source_cell_missing");const value=values[field.id],attributes=cell.match[1].replace(/\s+t="[^"]*"/g,"");const body=field.type==="number"&&value!==""?`<v>${encode(Number(value))}</v>`:`<is><t xml:space="preserve">${encode(value)}</t></is>`,type=field.type==="number"&&value!==""?"":' t="inlineStr"',replacement=`<c${attributes}${type}>${body}</c>`;xml=xml.replace(cell.match[0],replacement)}zip.file(part,xml)}
};

export const fillOfficeForm=async(buffer,mimeType,values)=>{
  const zip=await loadSafeZip(buffer,mimeType),inspection=mimeType===DOCX_MIME?await inspectDocx(zip):await inspectXlsx(zip);if(!inspection.editable)throw new Error("office_form_structured_fields_missing");const normalized=normalizedValues(inspection,values);if(mimeType===DOCX_MIME)await fillDocx(zip,inspection,normalized);else await fillXlsx(zip,inspection,normalized);const output=await zip.generateAsync({type:"nodebuffer",compression:"DEFLATE",compressionOptions:{level:6}}),verified=await inspectOfficeForm(output,mimeType),verifiedMap=new Map(verified.fields.map(field=>[field.id,field.value]));for(const [id,value] of Object.entries(normalized))if(String(verifiedMap.get(id)??"")!==String(value))throw new Error("office_form_reread_verification_failed");return{content:output,sha256:hash(output),sizeBytes:output.length,fields:verified.fields,fieldCount:verified.fields.length,sourceSha256:hash(buffer),originalUnchanged:true,rereadVerified:true,externalWrite:false,transmitted:false};
};
