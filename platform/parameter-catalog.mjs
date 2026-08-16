import { readFileSync } from "node:fs";
import { parameterUnitRules } from "./unit-catalog.mjs";

export const TAB = Object.freeze({
  COMPANY_PROFILE: "Gesellschaftsprofile",
  SERVICE_CPV: "Leistungen & CPV",
  REGION_CAPACITY: "Regionen & Kapazitäten",
  EVIDENCE: "Nachweise",
  CALCULATION: "Kalkulationsparameter",
  RISK_ECONOMICS: "Risiko & Wirtschaftlichkeit",
});

const assignments = Object.freeze({
  A01:"SERVICE_CPV",A02:"SERVICE_CPV",A03:"SERVICE_CPV",A04:"SERVICE_CPV",A05:"SERVICE_CPV",A06:"SERVICE_CPV",A07:"SERVICE_CPV",
  A08:"REGION_CAPACITY",A09:"REGION_CAPACITY",A10:"REGION_CAPACITY",
  A11:"EVIDENCE",A12:"EVIDENCE",A13:"EVIDENCE",A14:"SERVICE_CPV",A15:"SERVICE_CPV",A16:"COMPANY_PROFILE",
  B01:"REGION_CAPACITY",B02:"REGION_CAPACITY",B03:"REGION_CAPACITY",B04:"REGION_CAPACITY",B05:"REGION_CAPACITY",B06:"REGION_CAPACITY",B07:"REGION_CAPACITY",B08:"REGION_CAPACITY",B09:"REGION_CAPACITY",B10:"REGION_CAPACITY",
  B11:"EVIDENCE",B12:"RISK_ECONOMICS",
  C01:"CALCULATION",C02:"CALCULATION",C03:"CALCULATION",C04:"CALCULATION",C05:"CALCULATION",C06:"CALCULATION",C07:"CALCULATION",C08:"CALCULATION",C09:"CALCULATION",C10:"CALCULATION",C11:"CALCULATION",C12:"CALCULATION",C13:"CALCULATION",C14:"CALCULATION",C15:"CALCULATION",C16:"CALCULATION",C17:"CALCULATION",
  C18:"RISK_ECONOMICS",C19:"RISK_ECONOMICS",C20:"RISK_ECONOMICS",C21:"RISK_ECONOMICS",
});

const securityCostParameters=Object.freeze([
  {key:"S01",label:"Videoanlage – Kostenansatz / Einheitspreis",description:"Gesellschaftsscharf freigegebener Netto-Einheitspreis einer Videoanlage.",unit:"EUR/Einheit",defaultUnitId:"EUR_PER_UNIT"},
  {key:"S02",label:"Anlagenwoche – Kostenansatz / Einheitspreis",description:"Gesellschaftsscharf freigegebener Netto-Kostenansatz je Anlagenwoche.",unit:"EUR/Woche",defaultUnitId:"EUR_PER_WEEK"},
  {key:"S03",label:"Notruf-/Servicewoche – Kostenansatz / Einheitspreis",description:"Gesellschaftsscharf freigegebener Netto-Kostenansatz je Notruf- oder Servicewoche.",unit:"EUR/Woche",defaultUnitId:"EUR_PER_WEEK"},
  {key:"S04",label:"Baustellenausstattung – Kostenansatz / Einheitspreis",description:"Gesellschaftsscharf freigegebener Netto-Kostenansatz für Baustellenausstattung.",unit:"EUR",defaultUnitId:"EUR"},
].map(item=>Object.freeze({...item,code:item.key,tab:"CALCULATION",tabLabel:TAB.CALCULATION,category:"CALCULATION",dataType:"NUMBER_OR_STRUCTURED",expectedUnit:item.unit,units:parameterUnitRules[item.key].units.map(x=>({id:x.id,label:x.label,aliases:x.aliases,dataType:x.dataType,allowedInputForms:x.allowedInputForms,normalization:x.normalization,conversion:x.conversion})),unitDefinitionComplete:true,requiredFields:["companyId","serviceLine","parameterKey","newValue","unit","source","validFrom","reason"],allowedRoles:["tender.admin","tender.config.costs.edit"],matchingRelevant:false,goNoGoRelevant:false,calculationRelevant:true,sourceStatus:"KOSTENANSATZ_NOCH_NICHT_HINTERLEGT",priority:"S",status:"DRAFT_OPEN"})));

const editPermission = Object.freeze({
  COMPANY_PROFILE:"tender.config.services.edit", SERVICE_CPV:"tender.config.services.edit",
  REGION_CAPACITY:"tender.config.regions.edit", EVIDENCE:"tender.config.evidence.edit",
  CALCULATION:"tender.config.costs.edit", RISK_ECONOMICS:"tender.config.costs.edit",
});
const source=readFileSync(new URL("./assets/WB-TENDER-AUTOPILOT-MINIMUM-BUSINESS-PARAMETER-APPROVAL.txt",import.meta.url),"utf8");
const headings=[...source.matchAll(/^([ABC]\d{2})\s+(.+)$/gm)];
const numericUnits=/EUR|Prozent|%|Anzahl|km|Monate|Tage|Stunden|FTE|Vollzeit|DB/i;
export const parameterCatalog=Object.freeze([...headings.map((match,index)=>{
  const key=match[1], category=assignments[key], block=source.slice(match.index,headings[index+1]?.index??source.length);
  if(!category)throw new Error(`parameter_mapping_missing:${key}`);
  const parsedUnit=block.match(/^Einheit:\s*(.+)$/m)?.[1]||"NOCH ZU PFLEGEN",unitRule=parameterUnitRules[key],unit=unitRule?.units[0].label||parsedUnit;
  return Object.freeze({
    key, code:key, label:match[2], tab:category, tabLabel:TAB[category], category,
    dataType:unitRule?unitRule.units[0].dataType:numericUnits.test(unit)?"NUMBER_OR_STRUCTURED":"TEXT_OR_STRUCTURED", unit,
    expectedUnit:unit,units:unitRule?.units.map(x=>({id:x.id,label:x.label,aliases:x.aliases,dataType:x.dataType,allowedInputForms:x.allowedInputForms,normalization:x.normalization,conversion:x.conversion}))||[],defaultUnitId:unitRule?.defaultUnitId||null,unitDefinitionComplete:Boolean(unitRule)||unit!=="NOCH ZU PFLEGEN",requiredFields:["companyId","serviceLine","parameterKey","newValue","unit","source","validFrom","reason"],
    allowedRoles:["tender.admin",editPermission[category]], matchingRelevant:/^(A0[1-9]|A10|A14|A15|B0[1-4]|B07)$/.test(key),
    goNoGoRelevant:/^(A0[1-4]|A07|A1[0-5]|B(0[1-9]|10|11|12)|C(18|19|20|21))$/.test(key),
    calculationRelevant:key.startsWith("C"), sourceStatus:block.match(/^Wert:\s*(.+)$/m)?.[1]||"FEHLT", priority:key[0], status:"DRAFT_OPEN",
  });
}),...securityCostParameters]);
if(parameterCatalog.length!==53||new Set(parameterCatalog.map(x=>x.key)).size!==53)throw new Error("parameter_catalog_must_contain_53_unique_keys");
export const parameterByKey=Object.freeze(Object.fromEntries(parameterCatalog.map(x=>[x.key,x])));
export const editRight=editPermission;
export function mappingError(key,category){
  const item=parameterByKey[key];
  if(!item)return {code:"parameter_unknown",message:"Der ausgewählte Parameter ist nicht im produktiven Katalog definiert."};
  if(item.category!==category)return {code:"category_mismatch",message:`${item.key} – ${item.label} kann ausschließlich im Bereich ${item.tabLabel} gespeichert werden.`};
  return null;
}
