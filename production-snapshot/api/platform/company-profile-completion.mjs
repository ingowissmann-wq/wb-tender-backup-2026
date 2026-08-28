import crypto from "node:crypto";

const source = (types, label) => ({ types, label });
export const profileFieldDefinitions = Object.freeze([
  {key:"registerCourt",aliases:["Registergericht"],label:"Registergericht",area:"Gesellschaftsstammdaten",action:"Wert und Quelle hinterlegen",role:"Stammdatenpflege",target:["capabilities","registerCourt"],source:source(["TRADE_REGISTER_EXTRACT","ARTICLES_OF_ASSOCIATION"],"Handelsregisterauszug")},
  {key:"commercialRegisterNumber",aliases:["Handelsregisternummer"],label:"Handelsregisternummer",area:"Gesellschaftsstammdaten",action:"Wert und Quelle hinterlegen",role:"Stammdatenpflege",target:["capabilities","commercialRegisterNumber"],source:source(["TRADE_REGISTER_EXTRACT"],"Handelsregisterauszug")},
  {key:"centralCompanyId",aliases:["zentrale Gesellschafts-ID"],label:"Zentrale Gesellschafts-ID",area:"Gesellschaftsstammdaten",action:"Wert und Quelle hinterlegen",role:"Stammdatenpflege",target:["capabilities","centralCompanyId"],source:source(["TRADE_REGISTER_EXTRACT","ARTICLES_OF_ASSOCIATION","AUTHORIZED_INTERNAL_POLICY"],"autorisierter Gesellschaftsnachweis")},
  {key:"sector",aliases:["Sektorzuordnung"],label:"Sektorzuordnung",area:"Leistungs-/Unternehmensprofil",action:"Wert und Quelle hinterlegen",role:"Fachverantwortung Leistung",target:["capabilities","sector"],source:source(["BOARD_RESOLUTION","AUTHORIZED_INTERNAL_POLICY"],"freigegebene Sektorentscheidung")},
  {key:"permits",aliases:["gesellschaftsscharfe Erlaubnisse","Erlaubnisse"],label:"Erlaubnisse",area:"Nachweise",action:"Nachweis hochladen",role:"Nachweisprüfung",target:["certifications","permits"],source:source(["PERMIT_OR_CERTIFICATE"],"gültige Erlaubnisurkunde")},
  {key:"certifications",aliases:["gesellschaftsscharfe Zertifikate","Zertifikate"],label:"Zertifikate",area:"Nachweise",action:"Nachweis hochladen",role:"Nachweisprüfung",target:["certifications","items"],source:source(["PERMIT_OR_CERTIFICATE","INSURANCE_PROOF"],"gültiger Zertifikatsnachweis")},
  {key:"references",aliases:["verifizierte Referenzen"],label:"Referenzen",area:"Referenzverwaltung",action:"Referenz bearbeiten",role:"Referenzprüfung",target:["reference_profile","categories"],source:source(["REFERENCE_EVIDENCE"],"Referenznachweis")},
  {key:"capacityLimits",aliases:["Kapazitätsgrenzen"],label:"Kapazitätsgrenzen",area:"Regionen & Kapazitäten",action:"Kapazität festlegen",role:"Operative Leitung",target:["commercial_profile","capacityLimits"],source:source(["CAPACITY_APPROVAL","BOARD_RESOLUTION"],"Kapazitätsfreigabe")},
  {key:"minimumOrderValue",aliases:["Mindestauftragsvolumen"],label:"Mindestauftragsvolumen",area:"Kapazität/Wirtschaftlichkeit",action:"Freigabegrenze festlegen",role:"Kaufmännische Leitung",target:["commercial_profile","minimumOrderValue"],source:source(["BOARD_RESOLUTION","AUDITED_FINANCIAL_STATEMENT"],"freigegebene Wirtschaftlichkeitsentscheidung")},
  {key:"maximumOrderValue",aliases:["Höchstauftragsvolumen"],label:"Höchstauftragsvolumen",area:"Kapazität/Wirtschaftlichkeit",action:"Freigabegrenze festlegen",role:"Kaufmännische Leitung",target:["commercial_profile","maximumOrderValue"],source:source(["BOARD_RESOLUTION","AUDITED_FINANCIAL_STATEMENT"],"freigegebene Wirtschaftlichkeitsentscheidung")},
  {key:"preferredDurations",aliases:["bevorzugte Vertragslaufzeiten"],label:"Bevorzugte Vertragslaufzeiten",area:"Kalkulationsparameter",action:"Wert eingeben",role:"Kalkulationsverantwortung",target:["commercial_profile","preferredDurations"],source:source(["BOARD_RESOLUTION","AUTHORIZED_INTERNAL_POLICY"],"freigegebene Kalkulationsrichtlinie")},
  {key:"maximumDistance",aliases:["maximale Entfernung"],label:"Maximale Entfernung",area:"Regionen & Kapazitäten",action:"Kapazität festlegen",role:"Operative Leitung",target:["commercial_profile","maximumDistance"],source:source(["CAPACITY_APPROVAL","BOARD_RESOLUTION"],"Kapazitätsfreigabe")},
  {key:"subcontractorModels",aliases:["zulässige Nachunternehmermodelle"],label:"Zulässige Nachunternehmermodelle",area:"Leistungs-/Kapazitätsprofil",action:"Wert eingeben",role:"Fachverantwortung Leistung",target:["commercial_profile","subcontractorModels"],notApplicableAllowed:true,source:source(["BOARD_RESOLUTION","AUTHORIZED_INTERNAL_POLICY"],"autorisierte Nachunternehmerrichtlinie")},
  {key:"targetMargins",aliases:["Zieldeckungsbeiträge"],label:"Zieldeckungsbeiträge",area:"Kalkulationsparameter",action:"Freigabegrenze festlegen",role:"Kaufmännische Leitung",target:["commercial_profile","targetMargins"],source:source(["BOARD_RESOLUTION","AUDITED_FINANCIAL_STATEMENT"],"freigegebene Kalkulationsentscheidung")},
  {key:"riskLimits",aliases:["Risikogrenzen"],label:"Risikogrenzen",area:"Risiko & Wirtschaftlichkeit",action:"Freigabegrenze festlegen",role:"Risiko-/Kaufmännische Leitung",target:["commercial_profile","riskLimits"],source:source(["RISK_RESOLUTION","BOARD_RESOLUTION"],"freigegebener Risikobeschluss")},
  {key:"approvedCostParameters",aliases:["freigegebene Kostenparameter"],label:"Freigegebene Kostenparameter",area:"Kalkulationsparameter",action:"Zur zuständigen Maske",role:"Kalkulationsverantwortung",target:["commercial_profile","approvedCostParameters"],source:source(["BOARD_RESOLUTION","AUTHORIZED_INTERNAL_POLICY","AUDITED_FINANCIAL_STATEMENT"],"freigegebene Kostenparameter")},
]);

export const profileFieldByKey=Object.freeze(Object.fromEntries(profileFieldDefinitions.map(x=>[x.key,x])));
export const profileSourceTypeLabels=Object.freeze({TRADE_REGISTER_EXTRACT:"Handelsregisterauszug",ARTICLES_OF_ASSOCIATION:"Gesellschaftsvertrag",BOARD_RESOLUTION:"Vorstandsbeschluss",INSURANCE_PROOF:"Versicherungsnachweis",PERMIT_OR_CERTIFICATE:"Erlaubnis oder Zertifikat",AUDITED_FINANCIAL_STATEMENT:"Geprüfter Jahresabschluss",CAPACITY_APPROVAL:"Kapazitätsfreigabe",REFERENCE_EVIDENCE:"Referenznachweis",RISK_RESOLUTION:"Risikobeschluss",AUTHORIZED_INTERNAL_POLICY:"Interne autorisierte Richtlinie"});
const missing=v=>v==null||v===""||/NOCH ZU PFLEGEN|GESPERRT/i.test(typeof v==="string"?v:JSON.stringify(v))||(Array.isArray(v)&&!v.length);
const valueAt=(profile,target)=>target.reduce((v,k)=>v?.[k],profile);
export function evaluateProfile(profile,now=new Date()){
  const declared=new Set(Array.isArray(profile?.capabilities?.missing)?profile.capabilities.missing:[]),provenance=profile?.field_provenance||{};
  const fields=profileFieldDefinitions.map(def=>{
    const value=valueAt(profile,def.target),meta=provenance[def.key]||null,valueMissing=missing(value),notApplicable=meta?.notApplicable===true,
      sourceMissing=!meta?.sourceType||!meta?.sourceLabel||!meta?.issuer,expired=Boolean(meta?.validUntil&&new Date(`${meta.validUntil}T23:59:59Z`)<now),authoritative=meta?.verificationStatus==="VERIFIED"&&!expired;
    let state="COMPLETE",reason="Wert und autoritative Quelle sind vollständig.";
    if(notApplicable){state=meta?.notApplicableReason&&meta?.verifiedBy?"COMPLETE":"NOT_APPLICABLE_REASON_MISSING";reason=state==="COMPLETE"?"Nicht zutreffend wurde autorisiert begründet.":"Begründung und autorisierte Bestätigung fehlen."}
    else if(valueMissing&&sourceMissing){state="VALUE_AND_SOURCE_MISSING";reason="Wert und feldbezogene Quelle fehlen."}
    else if(valueMissing){state="VALUE_MISSING";reason="Der fachliche Wert fehlt."}
    else if(sourceMissing){state="SOURCE_MISSING";reason="Die erforderliche Quellenprovenienz fehlt."}
    else if(expired){state="EVIDENCE_EXPIRED";reason="Der hinterlegte Nachweis ist abgelaufen."}
    else if(!authoritative){state=meta?.verificationStatus==="REJECTED"?"VALIDATION_FAILED":"SOURCE_NOT_AUTHORITATIVE";reason=meta?.verificationStatus==="REJECTED"?"Die Quellenprüfung ist fehlgeschlagen.":"Die Quelle ist gespeichert, aber noch nicht autoritativ verifiziert."}
    return {...def,value:valueMissing?null:value,provenance:meta,state,reason,complete:state==="COMPLETE"};
  });
  const complete=fields.filter(x=>x.complete).length,missingValues=fields.filter(x=>["VALUE_MISSING","VALUE_AND_SOURCE_MISSING"].includes(x.state)).length,missingSources=fields.filter(x=>x.state!=="COMPLETE"&&!["VALUE_MISSING"].includes(x.state)).length;
  return {fields,completeCount:complete,totalCount:fields.length,completenessPercent:Math.round(100*complete/fields.length),missingValues,missingSources,releaseReady:complete===fields.length};
}
export function setProfileField(profile,definition,value){const next=structuredClone(profile),[root,key]=definition.target;next[root]={...(next[root]||{}),[key]:value};return next}
const stable=v=>Array.isArray(v)?`[${v.map(stable).join(",")}]`:v&&typeof v==="object"?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`:JSON.stringify(v);
export const profileFingerprint=profile=>crypto.createHash("sha256").update(stable({companyId:profile.company_id,version:profile.version,capabilities:profile.capabilities,certifications:profile.certifications,referenceProfile:profile.reference_profile,commercialProfile:profile.commercial_profile,fieldProvenance:profile.field_provenance})).digest("hex");
