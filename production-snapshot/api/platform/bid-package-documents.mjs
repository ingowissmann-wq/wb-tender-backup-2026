import { generateDocument, GENERATOR_VERSION } from "./document-generators.mjs";
import { manifestHash } from "./bid-workflow.mjs";

const definitions=[
  {category:"PRICE_SHEET",code:"BID_PRICE_SHEET",title:"Preisblatt",type:"CALCULATION_OVERVIEW",format:"XLSX"},
  {category:"SPECIFICATION",code:"BID_SPECIFICATION",title:"Leistungsverzeichnis",type:"DOCUMENT_LIST",format:"XLSX"},
  {category:"FORMS",code:"BID_FORMS",title:"Formblätter",type:"OFFER_CHECKLIST",format:"DOCX"},
  {category:"EVIDENCE",code:"BID_EVIDENCE",title:"Nachweise",type:"EVIDENCE_MATRIX",format:"DOCX"},
  {category:"CERTIFICATES",code:"BID_CERTIFICATES",title:"Zertifikate",type:"DOCUMENT_LIST",format:"PDF"},
];
const scalar=value=>value===undefined||value===null?"Nicht verfügbar":typeof value==="object"?JSON.stringify(value):String(value);
const selectData=(definition,context)=>{
  const totals=context.calculation.totals||{},requirements=context.requirements||[],profile=context.profile?.parameters||context.profile||{};
  const common={Tender:context.tender.title,Auftraggeber:context.tender.buyer,Los:context.bidPackage.lot_key||"Gesamt",Gesellschaft:context.company.legal_name,Vergabenummer:context.tender.procurement_number||context.tender.notice_number||"Nicht verfügbar"};
  if(definition.category==="PRICE_SHEET")return {...common,Angebotspreis_netto:scalar(totals.offerPriceNet??totals.offerPrice??totals.price),DB1:scalar(totals.db1),DB2:scalar(totals.db2),DB3:scalar(totals.db3),Gewinn:scalar(totals.profit),Preispositionen:scalar(totals.pricePositions||[])};
  if(definition.category==="SPECIFICATION")return {...common,Leistungspositionen:scalar(totals.pricePositions||[]),Leistungsgrundlage:scalar(context.management.payload?.operations||context.management.payload?.calculation||{})};
  if(definition.category==="FORMS")return {...common,Formblätter:scalar(requirements.filter(x=>/form|erklärung|formular/i.test(`${x.category} ${x.requirement}`)).map(x=>({Anforderung:x.requirement,Status:x.status,Pflicht:x.mandatory})))};
  if(definition.category==="EVIDENCE")return {...common,Nachweise:scalar(requirements.filter(x=>/nachweis|eignung|referenz/i.test(`${x.category} ${x.requirement}`)).map(x=>({Anforderung:x.requirement,Status:x.status,Pflicht:x.mandatory}))),Unternehmensnachweise:scalar(profile.A11??profile.references??"Nicht verfügbar")};
  return {...common,Zertifikate:scalar(profile.A12??profile.certifications??requirements.filter(x=>/zertifikat|bescheinigung/i.test(`${x.category} ${x.requirement}`)).map(x=>({Anforderung:x.requirement,Status:x.status,Pflicht:x.mandatory})))};
};

export async function generateBidPackageDocuments(client,{bidPackageId,createdBy}){
  const context=(await client.query(`SELECT bp.*,t.title,t.buyer,t.procurement_number,t.notice_number,t.data_class,c.company_id,c.totals,
      ec.legal_name,mo.payload,mo.status management_status
    FROM tender.bid_packages bp JOIN tender.tenders t ON t.id=bp.tender_id
    JOIN tender.calculations c ON c.id=bp.calculation_id
    JOIN tender.enterprise_company_links ec ON ec.company_id=c.company_id
    JOIN tender.management_outputs mo ON mo.id=bp.management_output_id WHERE bp.id=$1 FOR UPDATE OF bp`,[bidPackageId])).rows[0];
  if(!context)throw new Error("bid_package_not_found");
  const requirements=(await client.query("SELECT category,requirement,mandatory,status,evidence_needed FROM tender.requirements WHERE tender_id=$1 AND (lot_id IS NULL OR lot_id=(SELECT id FROM tender.lots WHERE tender_id=$1 AND external_id=$2 LIMIT 1)) ORDER BY category,created_at",[context.tender_id,context.lot_key])).rows;
  const profile=(await client.query("SELECT jsonb_build_object('certifications',certifications,'references',reference_profile,'capabilities',capabilities,'commercial',commercial_profile) parameters FROM tender.company_profiles WHERE company_id=$1 AND status='ACTIVE' ORDER BY version DESC LIMIT 1",[context.company_id])).rows[0]||{};
  const input={bidPackage:context,tender:context,calculation:{totals:context.totals},company:{legal_name:context.legal_name},management:{payload:context.payload},requirements,profile};
  const documents=[];
  for(const definition of definitions){
    const existing=(await client.query("SELECT id,category,version,format,status,sha256,storage_key,output_size_bytes FROM tender.generated_documents WHERE bid_package_id=$1 AND category=$2",[bidPackageId,definition.category])).rows[0];
    if(existing){documents.push(existing);continue}
    let template=(await client.query("SELECT id FROM tender.document_templates WHERE code=$1 AND company_id IS NULL AND version=1 AND active=true LIMIT 1",[definition.code])).rows[0];
    if(!template)template=(await client.query("INSERT INTO tender.document_templates(code,company_id,version,format,template_storage_key,required_fields,active,created_by) VALUES($1,NULL,1,$2,$3,'[]'::jsonb,true,$4) RETURNING id",[definition.code,definition.format,`builtin://${definition.code.toLowerCase()}/v1`,createdBy])).rows[0];
    const generated=await generateDocument({type:definition.type,format:definition.format,title:definition.title,data:selectData(definition,input),metadata:{company:context.legal_name,tenderVersion:context.tender_version_id,calculationVersion:context.calculation_version,generatorRequestedBy:createdBy,createdAt:context.created_at}});
    await client.query("INSERT INTO tender.document_blobs(payload_sha256,content,size_bytes,mime_type) VALUES($1,$2,$3,$4) ON CONFLICT(payload_sha256) DO NOTHING",[generated.sha256,generated.buffer,generated.sizeBytes,definition.format==="PDF"?"application/pdf":definition.format==="XLSX"?"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":"application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);
    const row=(await client.query(`INSERT INTO tender.generated_documents(tender_id,template_id,tender_version_id,calculation_id,version,format,storage_key,sha256,status,missing_fields,source_manifest,created_by,generator_version,generated_at,output_media_type,output_size_bytes,internal_draft_only,bid_package_id,category)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'INTERNAL_DRAFT_READY',$9::jsonb,$10::jsonb,$11,$12,now(),$13,$14,true,$15,$16) RETURNING id,category,version,format,status,sha256,storage_key,output_size_bytes`,[context.tender_id,template.id,context.tender_version_id,context.calculation_id,context.version,definition.format,`sha256:${generated.sha256}`,generated.sha256,JSON.stringify(generated.manifest.missingFields),JSON.stringify({...generated.manifest,bidPackageId,category:definition.category,lotKey:context.lot_key,companyId:context.company_id}),createdBy,GENERATOR_VERSION,definition.format==="PDF"?"application/pdf":definition.format==="XLSX"?"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",generated.sizeBytes,bidPackageId,definition.category])).rows[0];
    documents.push(row);
  }
  const missing=definitions.filter(def=>!documents.some(doc=>doc.category===def.category)).map(def=>def.category),documentManifest=documents.map(doc=>({id:doc.id,category:doc.category,version:doc.version,format:doc.format,sha256:doc.sha256,sizeBytes:Number(doc.output_size_bytes)})).sort((a,b)=>a.category.localeCompare(b.category));
  const status=missing.length?"BID_PACKAGE_INCOMPLETE":"BID_PACKAGE_READY_FOR_SUBMISSION";
  const manifest={...(context.manifest||{}),documents:documentManifest,documentGeneration:{status:missing.length?"INCOMPLETE":"PACKAGE_COMPLETE",generatorVersion:GENERATOR_VERSION}};
  const updated=(await client.query("UPDATE tender.bid_packages SET status=$2,manifest=$3::jsonb,manifest_sha256=$4,missing_items=$5::jsonb WHERE id=$1 RETURNING *",[bidPackageId,status,JSON.stringify(manifest),manifestHash(manifest),JSON.stringify(missing)])).rows[0];
  await client.query("INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'DOCUMENT_GENERATION_COMPLETED',$2,$3::jsonb),($1,'PACKAGE_COMPLETE',$2,$3::jsonb)",[createdBy,context.tender_id,JSON.stringify({bidPackageId,lotKey:context.lot_key,companyId:context.company_id,documents:documentManifest,missing,externalWrite:false})]);
  return {bidPackage:updated,documents,missing,packageComplete:missing.length===0};
}
