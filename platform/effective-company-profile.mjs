import {isExplicitlySupplied, snapshotHash} from "./canonical-truth.mjs";

const COLLECTION_KEYS = Object.freeze(["A11", "A12", "A13", "B11"]);
const asItems = value => {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.items)) return value.items;
  if (value === null || value === undefined) return [];
  return [value];
};
const active = item => {
  const status = String(item?.status || "ACTIVE").toUpperCase();
  return !["SUPERSEDED", "EXPIRED", "REVOKED", "DELETED", "INACTIVE"].includes(status);
};

export function normalizeProfileValue(value) {
  if (value === null || value === undefined) return {status:"MISSING", value:null};
  if (typeof value === "object" && !Array.isArray(value) && value.status) {
    const status=String(value.status).toUpperCase();
    return {...value,status,value:Object.hasOwn(value,"value")?value.value:value.value??null};
  }
  return {status:"PROVIDED",value};
}

export function buildEffectiveCompanyProfile({companyId, serviceArea, parameters = {}, companyProfile = null, sourceManifest = {}, resolvedAt = new Date().toISOString()} = {}) {
  const normalized = {};
  for (const [key, parameter] of Object.entries(parameters)) {
    const value = normalizeProfileValue(parameter?.value);
    normalized[key] = {...value, parameterId:parameter?.parameterId||null, sourceVersionId:parameter?.sourceVersionId||null, sourceVersion:parameter?.sourceVersion||null, validFrom:parameter?.validFrom||null, validUntil:parameter?.validUntil||null};
  }
  const capabilities=companyProfile?.capabilities||{};
  const derived={
    A01:capabilities.activeServices,
    A02:capabilities.inactiveServices,
    A03:capabilities.cpvCodes,
    A05:capabilities.keywords,
    A06:capabilities.synonyms,
    A07:capabilities.exclusions,
    A15:{companyId,serviceArea,primaryAssignment:true,status:"VERIFIED"}
  };
  for(const [key,value] of Object.entries(derived))if(!normalized[key]&&value!==null&&value!==undefined){
    const explicitEmpty=Array.isArray(value)&&value.length===0;
    normalized[key]={status:explicitEmpty?"NONE_DECLARED":"PROVIDED",value,parameterId:null,sourceVersionId:companyProfile?.id||null,sourceVersion:companyProfile?.version||null,validFrom:companyProfile?.valid_from||null,validUntil:null,derivedFrom:`companyProfile.${key==="A15"?"enterpriseAssignment":key}`};
  }
  for(const key of ["A04","A14"])if(!normalized[key])normalized[key]={status:"NOT_REQUIRED",value:[],parameterId:null,sourceVersionId:companyProfile?.id||null,sourceVersion:companyProfile?.version||null,validFrom:companyProfile?.valid_from||null,validUntil:null,derivedFrom:"optional matching rule absent; canonical global exclusion policy remains active"};
  for (const key of COLLECTION_KEYS) {
    const items=asItems(normalized[key]?.value).filter(active);
    if (normalized[key]) normalized[key]={...normalized[key],value:items,itemCount:items.length,status:normalized[key].status==="MISSING"?"MISSING":normalized[key].status};
  }
  const additional = {
    insurances: normalizeProfileValue(companyProfile?.insurance ?? companyProfile?.insurances),
    prequalifications: normalizeProfileValue(companyProfile?.prequalifications ?? companyProfile?.prequalification),
    additionalEvidence: normalizeProfileValue(companyProfile?.additional_evidence ?? companyProfile?.additionalEvidence),
    certifications: normalizeProfileValue(companyProfile?.certifications),
    references: normalizeProfileValue(companyProfile?.reference_profile ?? companyProfile?.references)
  };
  const readiness={
    discovery:Object.keys(normalized).filter(key=>/^D/i.test(key)).filter(key=>isExplicitlySupplied(normalized[key])).length,
    matching:Object.keys(normalized).filter(key=>/^A\d{2}$/.test(key)).filter(key=>isExplicitlySupplied(normalized[key])).length,
    capacity:Object.keys(normalized).filter(key=>/^B\d{2}$/.test(key)).filter(key=>isExplicitlySupplied(normalized[key])).length,
    calculation:Object.keys(normalized).filter(key=>/^C\d{2}$/.test(key)).filter(key=>isExplicitlySupplied(normalized[key])).length
  };
  const canonical={schemaVersion:1,companyId,serviceArea,parameters:normalized,additional,sourceManifest,companyProfileId:companyProfile?.id||null,companyProfileVersion:companyProfile?.version||null,readiness};
  const revision=snapshotHash(canonical);
  return {...canonical,revision,snapshotId:revision,resolvedAt};
}

export function profileParameterRows(snapshot) {
  return Object.entries(snapshot?.parameters||{}).map(([parameter_key,item])=>({parameter_key,new_value:item.value,status:item.status,parameter_id:item.parameterId,source_version_id:item.sourceVersionId,source_version:item.sourceVersion,valid_from:item.validFrom,valid_until:item.validUntil}));
}
