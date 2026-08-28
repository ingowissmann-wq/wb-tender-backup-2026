import { sha256 } from "./autopilot-core.mjs";
export const DOCUMENT_TYPES=["COVER_LETTER","PRICE_SHEET","CALCULATION","SERVICE_CONCEPT","IMPLEMENTATION_CONCEPT","STAFFING_CONCEPT","QUALITY_CONCEPT","SUSTAINABILITY_CONCEPT","SECURITY_CONCEPT","REFERENCES","EVIDENCE_LIST","DECLARATIONS","SUBCONTRACTORS","DEADLINES","SIGNATURE_LIST","CHECKLIST"];
export function prepareDocument(template,context) {
  if(!DOCUMENT_TYPES.includes(template.type))throw new Error("template_type_invalid");
  const missing=(template.requiredFields||[]).filter((key)=>context[key]===undefined||context[key]===null||context[key]==="");
  const rendered=missing.length?null:String(template.body||"").replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g,(_,key)=>String(context[key]??`[FEHLT:${key}]`));
  const manifest={templateVersion:template.version,tenderVersion:context.tenderVersion,calculationVersion:context.calculationVersion,companyVersion:context.companyVersion,dataKeys:Object.keys(context).sort(),binding:false,externalUpload:false,electronicSignature:false};
  return {status:missing.length?"BLOCKED":"PREPARED",missing,rendered,manifest,sha256:rendered?sha256(rendered):null};
}
export function exportPlan(document,format) {
  if(!["DOCX","XLSX","PDF","JSON"].includes(format))throw new Error("format_invalid");
  if(document.status!=="PREPARED")throw new Error("document_incomplete");
  return {format,status:"INTERNAL_EXPORT_READY",externalUpload:false,signature:false};
}

