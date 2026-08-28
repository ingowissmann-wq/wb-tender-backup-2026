import { parameterByKey, parameterCatalog } from "./parameter-catalog.mjs";
import { unitValidation, units } from "./unit-catalog.mjs";

const stageImpact={discovery:"blockiert Discovery",matching:"blockiert vollständiges Matching",calculation:"blockiert Kalkulation"};
const nextAction={DRAFT:"Entwurf aktivieren",SUBMITTED:"Freigabe abschließen",APPROVED:"Freigegebene Version aktivieren",MISSING:"Wert erfassen",INVALID:"Wert oder Einheit korrigieren",EXPIRED:"Gültigkeit erneuern",FUTURE:"Gültigkeitsbeginn prüfen",BLOCKED_BY_SERVICE_EVIDENCE:"Leistungs- oder Sektornachweis ergänzen",BLOCKED_BY_PERMISSION:"Sektorfreigabe durchführen"};
const profileRequirements=Object.freeze({
  discovery:[
    ["A01","activeServices","Leistungsumfang bestätigen"],
    ["A03","cpvCodes","CPV-Hauptcodes bestätigen"],
    ["A05","keywords","Schlüsselwörter bestätigen"],
  ],
  matching:[
    ["A08","regions.active","Kernregionen erfassen"],
    ["A11","permissions","Erlaubnisse je Leistung ergänzen"],
    ["A12","certifications","Zertifikate je Leistung ergänzen"],
    ["A13","references","Referenzkategorien ergänzen"],
    ["B01","commercial.capacityLimits","Operative Kapazität erfassen"],
    ["B05","commercial.minimumOrderValue","Mindestauftragsvolumen erfassen"],
    ["B06","commercial.maximumOrderValue","Höchstauftragsvolumen erfassen"],
    ["B07","commercial.maximumDistance","Maximale Entfernung erfassen"],
    ["B09","commercial.preferredDurations","Vertragslaufzeit erfassen"],
    ["B10","commercial.subcontractorModels","Nachunternehmerregeln erfassen"],
    ["B11","reference.categories","Vergleichbare Referenzen ergänzen"],
  ],
});

const at=(object,path)=>path.split(".").reduce((value,key)=>value?.[key],object);
const meaningful=value=>Array.isArray(value)?value.length>0:value!==undefined&&value!==null&&value!==""&&value!=="NOCH ZU PFLEGEN";
const isoDate=value=>value?new Date(value).toISOString().slice(0,10):null;
const isCurrent=(from,until,today)=>!from||from<=today?(!until||until>=today):false;
const latestByKey=rows=>{const result={};for(const row of [...rows].sort((a,b)=>(b.status==="ACTIVE")-(a.status==="ACTIVE")||Number(b.version_no)-Number(a.version_no)))if(!result[row.parameter_key])result[row.parameter_key]=row;return result};
const canonicalStatus=(stage,blockers,activeCount)=>{
  if(!blockers.length)return "ACTIVE";
  if(blockers.some(x=>x.state==="BLOCKED_BY_PERMISSION"||x.state==="BLOCKED_BY_SERVICE_EVIDENCE"))return "BLOCKED";
  if(stage==="calculation")return "BLOCKED";
  return activeCount>0?"PARTIAL":"BLOCKED";
};

function parameterState(key,row,today){
  if(!row)return {state:"MISSING",versionStatus:null};
  const versionStatus=row.status;
  if(["DRAFT","SUBMITTED","APPROVED"].includes(versionStatus))return {state:versionStatus,versionStatus};
  if(versionStatus!=="ACTIVE")return {state:"MISSING",versionStatus};
  if(row.valid_until&&isoDate(row.valid_until)<today)return {state:"EXPIRED",versionStatus};
  if(row.valid_from&&isoDate(row.valid_from)>today)return {state:"FUTURE",versionStatus};
  const definition=parameterByKey[key],unitCheck=unitValidation(key,row.unit);
  const valueMissing=row.new_value===null||row.new_value===undefined||row.new_value==="";
  const sourceMissing=!String(row.source||"").trim();
  const invalidUnit=unitCheck.error||(!definition?.unitDefinitionComplete&&row.unit==="NOCH ZU PFLEGEN");
  if(valueMissing||sourceMissing||invalidUnit)return {state:"INVALID",versionStatus,invalidReason:invalidUnit?"Einheit entspricht nicht der kanonischen Regel":valueMissing?"Wert fehlt":"Quelle fehlt"};
  return {state:"ACTIVE",versionStatus};
}

function detail({company,serviceLine,stage,key,state,row,reason}){
  const definition=parameterByKey[key];
  return {parameterKey:key,label:definition?.label||key,companyId:company.company_id,company:company.legal_name,serviceLine,state:state.state,versionStatus:state.versionStatus,versionNo:row?.version_no||null,currentValue:state.state==="INVALID"?state.invalidReason:null,expectedRule:definition?.units?.length?definition.units.map(x=>x.label).join(" oder "):definition?.expectedUnit||"fachliche Profilbestätigung",validFrom:isoDate(row?.valid_from),validUntil:isoDate(row?.valid_until),impact:stageImpact[stage],tab:definition?.category||"COMPANY_PROFILE",tabLabel:definition?.tabLabel||"Gesellschaftsprofile",nextAction:reason||nextAction[state.state]||"Statusursache prüfen"};
}

function profileStage(stage,company,profile,latest,today){
  const serviceLine=company.configuration_service_line;
  const blockers=[];
  for(const [key,path,action] of profileRequirements[stage]||[]){
    if(meaningful(at(profile,path)))continue;
    const row=latest[key],state=parameterState(key,row,today);
    if(state.state==="ACTIVE")continue;
    blockers.push(detail({company,serviceLine,stage,key,state,row,reason:action}));
  }
  if(company[`${stage}_status`] === "BLOCKED_PENDING_SERVICE_EVIDENCE"){
    for(const key of ["A11","A12"]){if(blockers.some(x=>x.parameterKey===key))continue;const row=latest[key],state=parameterState(key,row,today);if(state.state!=="ACTIVE")blockers.push(detail({company,serviceLine,stage,key,state:{...state,state:"BLOCKED_BY_SERVICE_EVIDENCE"},row,reason:"Leistungs- oder Sektornachweis ergänzen"}))}
  }
  if(company.sector_status==="manual-sector-approval-required")blockers.unshift({parameterKey:"SECTOR_APPROVAL",label:"Gesonderte Sektorfreigabe für Sicherheitsdienstleistungen erforderlich.",companyId:company.company_id,company:company.legal_name,serviceLine,state:"BLOCKED_BY_PERMISSION",versionStatus:null,versionNo:null,currentValue:"Sektorzuordnung und fachliche Freigabe fehlen",expectedRule:"Vorstandsfreigabe des Sektors einschließlich Leistungsart, Erlaubnissen, Kapazität und Referenzen",validFrom:null,validUntil:null,impact:stageImpact[stage],tab:"COMPANY_PROFILE",tabLabel:"Gesellschaftsprofile",nextAction:"Sektorfreigabe durchführen"});
  const total=(profileRequirements[stage]||[]).length+(company.sector_status==="manual-sector-approval-required"?1:0),openCount=blockers.length;
  const activeCount=Math.max(0,total-openCount),status=canonicalStatus(stage,blockers,activeCount);
  return {stage,status,activeCount,openCount,summary:openCount?`${openCount} Voraussetzungen fehlen oder sind nicht aktiv.`:"Alle erforderlichen Voraussetzungen sind aktiv.",blockers};
}

function calculationStage(company,latest,today){
  const requirements=parameterCatalog.filter(x=>x.calculationRelevant),blockers=[];
  for(const definition of requirements){const row=latest[definition.key],state=parameterState(definition.key,row,today);if(state.state!=="ACTIVE")blockers.push(detail({company,serviceLine:company.configuration_service_line,stage:"calculation",key:definition.key,state,row}))}
  if(company.sector_status==="manual-sector-approval-required")blockers.unshift({parameterKey:"SECTOR_APPROVAL",label:"Gesonderte Sektorfreigabe für Sicherheitsdienstleistungen erforderlich.",companyId:company.company_id,company:company.legal_name,serviceLine:company.configuration_service_line,state:"BLOCKED_BY_PERMISSION",versionStatus:null,versionNo:null,currentValue:"Sektorzuordnung und fachliche Freigabe fehlen",expectedRule:"Vorstandsfreigabe des Sektors einschließlich Leistungsart, Erlaubnissen, Kapazität und Referenzen",validFrom:null,validUntil:null,impact:stageImpact.calculation,tab:"COMPANY_PROFILE",tabLabel:"Gesellschaftsprofile",nextAction:"Sektorfreigabe durchführen"});
  const openCount=blockers.length,activeCount=requirements.length-blockers.filter(x=>x.parameterKey!=="SECTOR_APPROVAL").length;
  return {stage:"calculation",status:canonicalStatus("calculation",blockers,activeCount),activeCount,openCount,summary:blockers.length?`${blockers.length} Kalkulationsvoraussetzungen fehlen oder sind nicht aktiv.`:"Alle erforderlichen Voraussetzungen sind aktiv.",blockers};
}

export function buildStatusBlockers(companies,changes,{today=new Date().toISOString().slice(0,10),logger}={}){
  const byCompany=Object.groupBy(changes,row=>row.company_id);
  return companies.map(company=>{
    try{
      const profile={...(company.capabilities||{}),commercial:company.commercial_profile||{},reference:company.reference_profile||{}},latest=latestByKey(byCompany[company.company_id]||[]);
      return {companyId:company.company_id,company:company.legal_name,serviceLine:company.configuration_service_line,statusSource:{type:"CANONICAL_ACTIVE_PARAMETER_AND_GATE_RESOLUTION",configurationVersion:company.configuration_version,profileId:company.tender_profile_id,legacySnapshot:{discovery:company.discovery_status,matching:company.matching_status,calculation:company.calculation_status}},stages:{discovery:profileStage("discovery",company,profile,latest,today),matching:profileStage("matching",company,profile,latest,today),calculation:calculationStage(company,latest,today)}};
    }catch(error){logger?.error?.({err:error,companyId:company.company_id},"status blocker read model failed");return {companyId:company.company_id,company:company.legal_name,serviceLine:company.configuration_service_line,error:"Statusursache konnte nicht vollständig ermittelt werden.",stages:{}}}
  });
}

export async function readStatusBlockers(pool,companies,logger){
  if(!companies.length)return {readOnly:true,generatedAt:new Date().toISOString(),companies:[]};
  const ids=companies.map(x=>x.company_id),profiles=(await pool.query(`SELECT l.company_id,l.tender_profile_id,l.legal_name,l.sector_status,l.discovery_status,l.matching_status,l.calculation_status,l.configuration_version,COALESCE(l.sector_slug,l.technical_key) configuration_service_line,p.capabilities,p.certifications,p.reference_profile,p.commercial_profile FROM tender.enterprise_company_links l JOIN tender.company_profiles p ON p.id=l.tender_profile_id WHERE l.company_id=ANY($1::uuid[]) ORDER BY l.legal_name`,[ids])).rows;
  const changes=(await pool.query(`SELECT v.company_id,v.service_line,v.version_no,
   CASE WHEN a.change_id=c.id THEN 'ACTIVE' WHEN v.status='ACTIVE' THEN 'SUPERSEDED' ELSE v.status END status,
   c.parameter_key,c.new_value,c.unit,c.source,c.valid_from,c.valid_until
   FROM tender.configuration_versions v JOIN tender.configuration_changes c ON c.version_id=v.id
   LEFT JOIN tender.configuration_active_parameters a ON a.company_id=v.company_id AND a.service_line=v.service_line AND a.parameter_key=c.parameter_key
   WHERE v.company_id=ANY($1::uuid[]) ORDER BY v.company_id,(a.change_id=c.id) DESC,v.version_no DESC`,[ids])).rows;
  return {readOnly:true,generatedAt:new Date().toISOString(),companies:buildStatusBlockers(profiles,changes,{logger})};
}
