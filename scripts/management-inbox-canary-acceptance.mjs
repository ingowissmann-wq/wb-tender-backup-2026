import fs from "node:fs";

const baseUrl=String(process.env.MANAGEMENT_INBOX_BASE_URL||"").replace(/\/$/,"");
const sessionFile=process.env.MANAGEMENT_INBOX_SESSION_FILE;
if(!baseUrl||!sessionFile)throw new Error("MANAGEMENT_INBOX_BASE_URL and MANAGEMENT_INBOX_SESSION_FILE are required");
const session=JSON.parse(fs.readFileSync(sessionFile,"utf8"));
const cookie=`wb_session=${session.token}; wb_csrf=${session.csrf}`;
const request=async path=>{
  const started=performance.now(),response=await fetch(`${baseUrl}${path}`,{headers:{cookie},signal:AbortSignal.timeout(55_000)});
  let body;try{body=await response.json()}catch{body=null}
  if(!response.ok)throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(body)}`);
  return {status:response.status,body,durationMs:Math.round(performance.now()-started)};
};
const query=params=>`/api/management-inbox?${new URLSearchParams(params)}`;
const countKeys=["CORE_REGION","STRATEGIC_REGION","OUTSIDE_CORE_REGION","EXCLUDED_REGION","REGION_UNRESOLVED","REGION_CONFIG_CONFLICT","MULTI_REGION_REVIEW"];
const filters=["CORE_REGION","STRATEGIC_REGION","OUTSIDE_CORE_REGION","EXCLUDED_REGION","REGION_UNRESOLVED,REGION_CONFIG_CONFLICT,MULTI_REGION_REVIEW"];
const summaries=[];
const safeHttps=value=>{try{const url=new URL(String(value||""));if(url.protocol!=="https:"||url.username||url.password||/;jsessionid=/i.test(url.pathname))return false;for(const key of url.searchParams.keys())if(/^(?:access_?token|auth(?:entication|orization)?|bearer|code|credential|id_?token|jwt|key|password|refresh_?token|secret|session(?:id)?|sid|ticket|token)$/i.test(key))return false;return true}catch{return false}};
const documentStates=new Set(["DOCUMENTS_FOUND","LOGIN_REQUIRED","FETCH_FAILED","FETCH_NOT_RUN","LINKS_NOT_EXTRACTED","SOURCE_HAS_NO_DOCUMENT_LINKS"]);

const initial=await request(query({company:"all",regionClass:"all",relevance:"relevant",serviceLine:"",page:"1",pageSize:"50"}));
if(!Array.isArray(initial.body.companies)||!initial.body.companies.length)throw new Error("no accessible companies");
for(const company of initial.body.companies){
  const common={company:company.company_id,relevance:"relevant",serviceLine:company.service_line,page:"1",pageSize:"50"};
  const all=await request(query({...common,regionClass:"all"}));
  const counts=Object.fromEntries(countKeys.map(key=>[key,Number(all.body.counts?.[key]||0)]));
  const countSum=Object.values(counts).reduce((sum,value)=>sum+value,0);
  if(Number(all.body.total)===0&&(all.body.items||[]).length!==0)throw new Error(`${company.legal_name}/${company.canonical_service}: zero total returned non-empty rows`);
  if(["cleaning","security"].includes(company.canonical_service)&&counts.CORE_REGION<=0)throw new Error(`${company.legal_name}/${company.canonical_service}: expected core-region fixture missing`);
  if(countSum!==Number(all.body.total))throw new Error(`${company.legal_name}/${company.canonical_service}: counter sum ${countSum} != total ${all.body.total}`);
  for(const item of all.body.items||[]){
    if(item.company_id!==company.company_id||item.canonical_service!==company.canonical_service)throw new Error(`${company.legal_name}: cross-scope item`);
    const evidence=item.linkEvidence;
    if(item.source_code==="TED"&&(!evidence?.originalNotice||evidence.originalNotice.label!=="Originalbekanntmachung öffnen"||!safeHttps(evidence.originalNotice.url)))throw new Error(`${company.legal_name}: missing or unsafe TED original notice evidence`);
    if(item.source_code==="DOE"&&(!evidence?.technicalSource||evidence.technicalSource.label!=="OCDS-Quelldatensatz anzeigen"||evidence.originalNotice||!safeHttps(evidence.technicalSource.url)))throw new Error(`${company.legal_name}: DOE OCDS source semantics invalid`);
    if(!evidence.procurementPortal&&!evidence.missingReasons?.procurementPortal)throw new Error(`${company.legal_name}: dishonest missing portal reason`);
    for(const link of [evidence.originalNotice,evidence.technicalSource,evidence.procurementPortal,...(evidence.documents||[]),evidence.login,evidence.registration,evidence.electronicSubmission].filter(Boolean))if(!safeHttps(link.url))throw new Error(`${company.legal_name}: unsafe external link`);
    if(/DOE_QUELLPAYLOAD|TED_QUELLPAYLOAD|ENRICHMENT_DOCUMENT/.test(JSON.stringify(evidence)))throw new Error(`${company.legal_name}: internal provenance leaked`);
    if(!documentStates.has(item.documentEvidence?.code))throw new Error(`${company.legal_name}: unclassified document state`);
  }
  const categoryTotals={};
  for(const regionClass of filters){
    const filtered=await request(query({...common,regionClass}));
    const expected=regionClass.includes(",")?counts.REGION_UNRESOLVED+counts.REGION_CONFIG_CONFLICT+counts.MULTI_REGION_REVIEW:counts[regionClass];
    if(Number(filtered.body.total)!==expected)throw new Error(`${company.legal_name}/${regionClass}: ${filtered.body.total} != ${expected}`);
    for(const key of countKeys)if(Number(filtered.body.counts?.[key]||0)!==counts[key])throw new Error(`${company.legal_name}/${regionClass}: counters changed with filter`);
    categoryTotals[regionClass]=Number(filtered.body.total);
  }
  const item=all.body.items?.[0];
  let detailStatus=null;
  if(item){
    const detail=await request(`/api/management-inbox/region-detail/${encodeURIComponent(item.tender_id)}?company=${encodeURIComponent(company.company_id)}&lot=${encodeURIComponent(item.lot_key||"")}`);
    detailStatus=detail.status;
    if(detail.body.linkEvidence?.originalNotice?.url!==item.linkEvidence?.originalNotice?.url||detail.body.documentEvidence?.code!==item.documentEvidence?.code)throw new Error(`${company.legal_name}: list/detail evidence mismatch`);
    if(item.linkEvidence?.procurementPortal?.portalId){
      const access=await request(`/api/portal-access/for-tender/${encodeURIComponent(item.tender_id)}?company=${encodeURIComponent(company.company_id)}&lot=${encodeURIComponent(item.lot_key||"")}`);
      if(!Array.isArray(access.body.items)||!access.body.items.length)throw new Error(`${company.legal_name}: optional portal access did not return matched portal`);
      const serialized=JSON.stringify(access.body);
      if(/ciphertext|auth_tag|totpSeed|recoveryCodes|password/i.test(serialized))throw new Error(`${company.legal_name}: secret material leaked by portal access API`);
    }
  }
  summaries.push({companyId:company.company_id,legalName:company.legal_name,canonicalService:company.canonical_service,profileId:company.profile_id,total:Number(all.body.total),counts,categoryTotals,firstPageItems:all.body.items?.length||0,originalNoticeEvidence:(all.body.items||[]).filter(item=>item.linkEvidence?.originalNotice).length,procurementPortalEvidence:(all.body.items||[]).filter(item=>item.linkEvidence?.procurementPortal).length,documentStates:[...new Set((all.body.items||[]).map(item=>item.documentEvidence?.code))],allDurationMs:all.durationMs,detailStatus});
}

console.log(JSON.stringify({passed:true,checkedAt:new Date().toISOString(),companies:summaries},null,2));
