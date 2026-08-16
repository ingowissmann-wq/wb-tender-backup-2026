import crypto from "node:crypto";

export const RELEVANCE_STATUSES=Object.freeze(["RELEVANT","POTENTIALLY_RELEVANT","MANUAL_CLASSIFICATION_REQUIRED","NOT_RELEVANT","EXCLUDED","NOT_APPLICABLE"]);
export const TERMINAL_RELEVANCE=new Set(["NOT_RELEVANT","EXCLUDED","NOT_APPLICABLE"]);
export const PROCESSABLE_RELEVANCE=new Set(["RELEVANT","POTENTIALLY_RELEVANT","MANUAL_CLASSIFICATION_REQUIRED"]);

const TAXONOMY=Object.freeze({
  cleaning:{label:"Cleaning",keywords:["unterhaltsreinigung","gebäudereinigung","gebäudereinigungs","büroreinigung","glasreinigung","fensterreinigung","grundreinigung","bauzwischenreinigung","bauendreinigung","industriereinigung","hallenreinigung","logistikreinigung","treppenhausreinigung","praxisreinigung","sanitärreinigung","bodenreinigung","sonderreinigung","reinigungsdienst","cleaning services","office cleaning","window cleaning"],cpv:["9091","90911","909112","909113","90914","90919","909192","909193"],exclusions:["abwasserreinigung","kanalreinigung","straßenreinigung"]},
  security:{label:"Security",keywords:["objektschutz","werkschutz","bewachung","doorman","revierdienst","interventionsdienst","empfangsdienst","pfortendienst","baustellenbewachung","schließdienst","sicherheitsdienst","guard services","security services","surveillance services"],cpv:["7970","7971","79711","79713","79714","79715"],exclusions:["it-sicherheit","cyber-security","cybersicherheit","sicherheitsbeleuchtung"]},
  "facility-management":{label:"Facility Management",keywords:["hausmeisterservice","hausmeisterdienst","winterdienst","grünpflege","grünanlagenpflege","außenanlagenpflege","infrastrukturelles facility management","facility management","objektkontrolle","gebäudemanagement"],cpv:["79993","799931","5070","5071","5072","5073","77314","9062"],exclusions:["sachverständigenprüfung","bauplanung","neubau","rohbau"]},
  sicherheitstechnik:{label:"Sicherheitstechnik",keywords:["videoüberwachung","zutrittskontrolle","einbruchmeldeanlage","einbruchmeldetechnik","alarmtechnik","sicherheitssystem","überwachungstechnik"],cpv:["3512","35121","351217","351253","429611","5061"],exclusions:["blitzschutzbau","sicherheitsbeleuchtung","allgemeine elektroinstallation","transformatorenbau","fahrstromtechnik","cyber-security"]},
  "emergency-services":{label:"Emergency Services",keywords:["betriebssanitäter","sanitätsdienst","medizinische absicherung","rettungsfachpersonal","werksanitätsdienst","betriebliches notfallmanagement","betriebliche notfallversorgung"],cpv:["85142","85143","75252"],exclusions:["dialyseausrüstung","medizinische geräte","medizinische warenlieferung","krankenhausgeräte","ärztliche leistung","feuerwehrfahrzeug"]}
});
const GLOBAL_NEGATIVE=["stromliefer","elektrizitätsliefer","erdgasbeliefer","rohbau","systemboden","systemböden","trockenbau","fensterbau","außentüren","architektur","ingenieurleistung","umweltanalytik","umweltschutzanalytik","abfalltransport","abfallverwertung","altpapiersammlung","dialyseausrüstung","ausrüstung für nierdialyse","feuerwehrfahrzeug","druckleistung","broschürenleistung","büromaschine","kopiersystem","drucksystem","archivumzug","abbrucharbeit","rückbauarbeit","warenlieferung","transformatorenbau","fahrstromtechnik"];

export const normalize=value=>String(value??"").normalize("NFKC").toLocaleLowerCase("de").replace(/[‐‑–—]/g,"-").replace(/\s+/g," ").trim();
export const unique=values=>[...new Set((values||[]).flat(Infinity).filter(value=>value!==null&&value!==undefined&&String(value).trim()).map(value=>String(value).trim()))];
const flatten=value=>{if(value===null||value===undefined)return[];if(Array.isArray(value))return value.flatMap(flatten);if(typeof value==="object")return Object.entries(value).flatMap(([key,item])=>[key,...flatten(item)]);return[String(value)]};
const values=(value,keys=[])=>{if(value===null||value===undefined)return[];if(keys.length&&typeof value==="object"&&!Array.isArray(value)){const picked=keys.flatMap(key=>flatten(value[key]));if(picked.length)return unique(picked)}return unique(flatten(value))};
const cpvMatch=(allowed,actual)=>allowed.some(prefix=>actual.some(code=>String(code).replace(/\D/g,"").startsWith(String(prefix).replace(/\D/g,""))));
const termHits=(terms,text)=>unique(terms.map(normalize).filter(term=>term&&text.includes(term)));
const activeParameterMap=parameters=>Object.fromEntries((parameters||[]).filter(row=>!row.status||["ACTIVE","PROVIDED","VERIFIED","NONE_DECLARED","NOT_APPLICABLE","NOT_REQUIRED"].includes(String(row.status).toUpperCase())).map(row=>[row.parameter_key,row.new_value]));
const sectorFor=company=>company.sector_slug||({"wb-cleaning":"cleaning","wb-security":"security","wb-facilitys":"facility-management","wb-sicherheitstechnik":"sicherheitstechnik","wb-emergency-service":"emergency-services"}[company.technical_key]||([["cleaning","cleaning"],["security","security"],["facilitys","facility-management"],["sicherheitstechnik","sicherheitstechnik"],["emergency","emergency-services"]].find(([needle])=>normalize(company.legal_name).includes(needle))?.[1]||""));
const sourceText=({tender,lot,enrichment})=>normalize([tender.title,tender.description,tender.procurement_subject,tender.contract_type,lot?.title,lot?.description,enrichment?.structured_data?.title,enrichment?.structured_data?.description,enrichment?.structured_data?.scope,enrichment?.structured_data?.categories].map(x=>typeof x==="object"?JSON.stringify(x):x).filter(Boolean).join(" "));
const sourceCpvs=({tender,lot,enrichment})=>unique([...(tender.cpv_codes||[]),...(lot?.cpv_codes||lot?.structured_data?.cpvCodes||[]),...(enrichment?.structured_data?.cpvCodes||[])]).map(x=>String(x).replace(/\D/g,""));
const configuredTerms=(p,key,names)=>values(p[key],names);

export function classifyCompanyService({tender,lot=null,enrichment=null,company,parameters=[],profile=null}){
  let sector=sectorFor(company),taxonomy=TAXONOMY[sector];const p=activeParameterMap(parameters),text=sourceText({tender,lot,enrichment}),cpvCodes=sourceCpvs({tender,lot,enrichment});if(!taxonomy){const inferred=Object.entries(TAXONOMY).map(([key,value])=>({key,value,score:termHits(value.keywords,text).length+(cpvMatch(value.cpv,cpvCodes)?2:0)})).sort((a,b)=>b.score-a.score)[0];if(inferred?.score>0){sector=inferred.key;taxonomy=inferred.value}}
  const configuredPositive=unique([...configuredTerms(p,"A01",["activeServices","services","scope"]),...configuredTerms(p,"A05",["keywords"]),...configuredTerms(p,"A06",["synonyms"])]);
  const configuredCpvs=configuredTerms(p,"A03",["cpvCodes","codes"]);
  const configuredExcluded=unique([...configuredTerms(p,"A02",["inactiveServices","excluded","services"]),...configuredTerms(p,"A07",["exclusions","excluded","keywords"]),...configuredTerms(p,"A14",["exclusions","excluded","objects","customers"])]);
  const excludedCpvs=configuredTerms(p,"A04",["cpvCodes","excluded","codes"]),profileCapabilities=profile?.capabilities||{};
  const positiveTerms=unique([...(taxonomy?.keywords||[]),...configuredPositive,...(profileCapabilities.activeServices||[]),...(profileCapabilities.keywords||[]),...(profileCapabilities.synonyms||[])]);
  const positiveCpvs=unique([...(taxonomy?.cpv||[]),...configuredCpvs,...(profileCapabilities.cpvCodes||[])]);
  const exclusionTerms=unique([...(taxonomy?.exclusions||[]),...configuredExcluded,...(profileCapabilities.exclusions||[])]);
  const positives=termHits(positiveTerms,text),exclusions=termHits(exclusionTerms,text),globalExclusions=termHits(GLOBAL_NEGATIVE,text),positiveCpv=cpvMatch(positiveCpvs,cpvCodes),excludedCpv=cpvMatch(excludedCpvs,cpvCodes);
  const protect=company.technical_key==="wb-protect-service"||company.sector_status==="manual-sector-approval-required",explicitA15=values(p.A15,["primaryCompanies","alternativeCompanies","allowedCompanies","assignments"]).map(normalize),a15Allowed=explicitA15.some(value=>value.includes(normalize(company.legal_name))||value.includes(normalize(company.technical_key)));
  let status,gate,reason;
  if(protect&&!a15Allowed){status="NOT_APPLICABLE";gate="FAILED_NOT_RELEVANT";reason="Für WB-Protect & Service fehlt eine aktive eigene A15-Sektor- und Erlaubnisfreigabe."}
  else if(excludedCpv||exclusions.length){status="EXCLUDED";gate="FAILED_EXCLUDED";reason=`Aktiver Ausschluss für ${company.legal_name}: ${unique([...exclusions,...(excludedCpv?["A04-CPV"]:[])]).join(", ")}.`}
  else if(globalExclusions.length&&!positives.length&&!positiveCpv){status="NOT_RELEVANT";gate="FAILED_NOT_RELEVANT";reason=`Fachfremder Vergabegegenstand: ${globalExclusions.join(", ")}.`}
  else if(positives.length||positiveCpv){status="RELEVANT";gate="PASSED";reason=`Positiver ${taxonomy?.label||sector}-Scope: ${unique([...positives,...(positiveCpv?["CPV"]:[])]).join(", ")}.`}
  else if(!text||text.length<24){status="MANUAL_CLASSIFICATION_REQUIRED";gate="REVIEW_REQUIRED";reason="Bekanntmachungsdaten reichen für eine sichere fachliche Zuordnung nicht aus."}
  else {status="NOT_APPLICABLE";gate="FAILED_NOT_RELEVANT";reason=`Keine positiven Leistungs- oder CPV-Signale für ${company.legal_name}.`}
  const score=(positives.length*10)+(positiveCpv?20:0)-(exclusions.length*30)-(excludedCpv?50:0)-(globalExclusions.length*10);
  return {companyId:company.company_id,companyName:company.legal_name,serviceLine:sector||"CONFIGURATION_REQUIRED",lotKey:lot?.lot_key||lot?.external_id||null,relevanceStatus:status,serviceScopeGate:gate,score,positiveSignals:positives,exclusionSignals:unique([...exclusions,...globalExclusions]),cpvCodes,appliedRules:["A01","A02","A03","A04","A05","A06","A07","A14","A15"].map(key=>({key,active:p[key]!==undefined,value:p[key]??null})),reason,configurationRequired:!taxonomy||protect&&!a15Allowed,processable:PROCESSABLE_RELEVANCE.has(status)};
}

export function classifyTenderServices({tender,lot=null,enrichment=null,companies=[]}){
  const evaluations=companies.map(item=>classifyCompanyService({tender,lot,enrichment,...item})),eligible=evaluations.filter(x=>x.relevanceStatus==="RELEVANT").sort((a,b)=>b.score-a.score||a.companyName.localeCompare(b.companyName,"de"));
  const primary=eligible[0]||null;
  for(const evaluation of evaluations){evaluation.primaryCompany=Boolean(primary&&evaluation.companyId===primary.companyId);evaluation.alternativeCompany=false;if(primary&&evaluation!==primary&&!(["EXCLUDED","NOT_RELEVANT"].includes(evaluation.relevanceStatus)))evaluation.relevanceStatus="NOT_APPLICABLE",evaluation.serviceScopeGate="FAILED_NOT_RELEVANT",evaluation.reason=`Primärgesellschaft ist ${primary.companyName}; keine aktive A15-Alternativfreigabe für ${evaluation.companyName}.`,evaluation.processable=false}
  return {evaluations,primary,alternatives:[],overallStatus:primary?primary.relevanceStatus:evaluations.some(x=>x.relevanceStatus==="MANUAL_CLASSIFICATION_REQUIRED")?"MANUAL_CLASSIFICATION_REQUIRED":evaluations.some(x=>x.relevanceStatus==="EXCLUDED")?"EXCLUDED":"NOT_RELEVANT"};
}

export const sectorQuestions=(serviceLine,source={})=>{
  if(serviceLine==="facility-management"){
    const text=normalize(JSON.stringify(source)),definitions=[
      ["Technische Anlagen und Anlagenmengen",["anlage","heizung","lüftung","klima","sanitär","elektro","aufzug","tga"]],
      ["Wartungs- und Prüfzyklen",["wartung","instandhaltung","inspektion","prüfung","prüfzyklus"]],
      ["Rufbereitschaft und Bereitschaftszeiten",["rufbereitschaft","bereitschaft","24/7","notdienst"]],
      ["Reaktions- und Entstörzeiten",["reaktionszeit","entstör","störungsbeseitigung","sla"]],
      ["Erforderliche technische Qualifikationen",["facharbeiter","techniker","meister","sachkunde","qualifikation"]],
      ["Facility-Leistungsmengen",["menge","stück","anzahl","umfang"]],
      ["Facility-Einsatz- oder Leistungszeiten",["einsatzzeit","leistungszeit","betriebszeit","stunden"]]
    ];
    return definitions.filter(([,signals])=>signals.some(signal=>text.includes(signal))).map(([label])=>label);
  }
  const configured={cleaning:["Flächen","Reinigungsintervalle","Leistungszeiten","Glasflächen","Objektleitung"],security:["Bewachungszeiten","Postenanzahl","Einsatzorte","Erlaubnisse nach §34a GewO"],"facility-management":["Objektanzahl","Außenflächen","Einsatzintervalle","Winterdienstflächen"],sicherheitstechnik:["Anlagenumfang","Schnittstellen","Installationsorte","Wartungsumfang"],"emergency-services":["Einsatzzeiten","Qualifikationsniveau","Personalbedarf","medizinischer Leistungsumfang"]}[serviceLine]||[];
  const text=normalize(JSON.stringify(source));return configured.filter(question=>!text.includes(normalize(question)));
};

export const relevanceSnapshotHash=input=>crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
export const dedupeTenderFields=tender=>({...tender,cpv_codes:unique(tender.cpv_codes),regions:unique((tender.regions||[]).map(value=>String(value).toUpperCase()))});
