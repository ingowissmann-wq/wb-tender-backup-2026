import crypto from "node:crypto";

export const RELEVANCE_STATUSES=Object.freeze(["RELEVANT","POTENTIALLY_RELEVANT","MANUAL_CLASSIFICATION_REQUIRED","NOT_RELEVANT","EXCLUDED","NOT_APPLICABLE"]);
export const TERMINAL_RELEVANCE=new Set(["NOT_RELEVANT","EXCLUDED","NOT_APPLICABLE"]);
export const PROCESSABLE_RELEVANCE=new Set(["RELEVANT","POTENTIALLY_RELEVANT","MANUAL_CLASSIFICATION_REQUIRED"]);

const TAXONOMY=Object.freeze({
  cleaning:{label:"Cleaning",keywords:["unterhaltsreinigung","gebäudereinigung","gebäudereinigungs","büroreinigung","glasreinigung","fensterreinigung","grundreinigung","bauzwischenreinigung","bauendreinigung","baureinigungsarbeiten","industriereinigung","hallenreinigung","logistikreinigung","treppenhausreinigung","praxisreinigung","sanitärreinigung","bodenreinigung","sonderreinigung","reinigungsdienst","reinigungsleistung","reinigungsarbeiten","fassadenreinigung","cleaning services","office cleaning","window cleaning","building cleaning","services de nettoyage","nettoyage de bâtiments","nettoyage de vitres"],cpv:["9090","9091","90911","909112","909113","90914","90919","909192","909193","9069"],exclusions:["abwasserreinigung","klärwerksbecken","kanalreinigung","straßenreinigung","wäscheleistung","feuerwehrtextilien","sewer cleaning","street cleaning"]},
  security:{label:"Security",keywords:["security","sicherheitsdienstleistungen","empfangs- und pfortendienst","objektschutz","werkschutz","bewachung","doorman","revierdienst","interventionsdienst","empfangsdienst","pfortendienst","baustellenbewachung","schließdienst","sicherheitsdienst","wachdienst","wachschutz","brandwachdienst","brandsicherheitswachdienst","guard services","security guard services","surveillance services","services de gardiennage","services de surveillance"],cpv:["7971","79711","79713","79714","79715"],exclusions:["it-sicherheit","it security","cyber-security","cyber security","cybersicherheit","informationssicherheit","information security","managed security services","crowdstrike","steinschlag","sicherheitsbeleuchtung"]},
  "facility-management":{label:"Facility Management",keywords:["hausmeisterservice","hausmeisterdienst","hausmeisterleistung","winterdienst","grünpflege","grünflächenpflege","grünanlagenpflege","gartenpflege","außenanlagenpflege","infrastrukturelles facility management","facility management","facilities management","objektkontrolle","gebäudemanagement","grounds maintenance","snow-clearing","entretien d'espaces verts","déneigement"],cpv:["79993","799931","5070","5071","5072","5073","7731","7734","9062","9834114"],exclusions:["sachverständigenprüfung","bauplanung","planungsleistung","objektplanung","architektur","ingenieurbüro","pflegekonzept","grünflächenkataster","winterdienstgerät","winterdienstausstattung","winterdienstanbaugerät","notstromversorgung","sap s4hana","softwarelizenz","neubau","rohbau"]},
  sicherheitstechnik:{label:"Sicherheitstechnik",keywords:["videoüberwachung","zutrittskontrolle","einbruchmeldeanlage","einbruchmeldetechnik","überfallmeldeanlage","gefahrenmeldeanlage","brandmeldeanlage","alarmtechnik","sicherheitssystem","überwachungstechnik","access control system","intruder alarm system","security cameras","contrôle d'accès","système d'alarme"],cpv:["35121","351217","351253","429611","5061","453121","453122","316252","316253"],exclusions:["sachverständigenprüfung","blitzschutzbau","sicherheitsbeleuchtung","allgemeine elektroinstallation","transformatorenbau","fahrstromtechnik","it-sicherheit","it security","cyber-security","cyber security","informationssicherheit"]},
  "emergency-services":{label:"Emergency Services",keywords:["betriebssanitäter","betriebssanitätsdienst","sanitätsdienst","sanitätswachdienst","medizinische absicherung","notfallmedizinische absicherung","rettungsfachpersonal","notfallrettung","krankentransport","interhospitaltransfer","durchführung von aufgaben des rettungsdienstes","durchführung der notärztlichen versorgung","werksanitätsdienst","betriebliches notfallmanagement","betriebliche notfallversorgung","ambulance services","rescue services","services ambulanciers","services de secours"],cpv:["85143"],exclusions:["dialyseausrüstung","medizinische geräte","medizinische warenlieferung","krankenhausgeräte","ärztliche leistung","feuerwehrfahrzeug"]}
});
const GLOBAL_NEGATIVE=["stromliefer","elektrizitätsliefer","erdgasbeliefer","rohbau","systemboden","systemböden","trockenbau","fensterbau","außentüren","architektur","ingenieurleistung","umweltanalytik","umweltschutzanalytik","abfalltransport","abfallverwertung","altpapiersammlung","dialyseausrüstung","ausrüstung für nierdialyse","feuerwehrfahrzeug","druckleistung","broschürenleistung","büromaschine","kopiersystem","drucksystem","archivumzug","abbrucharbeit","rückbauarbeit","warenlieferung","transformatorenbau","fahrstromtechnik","softwareentwicklung","softwarelieferung","it-sicherheit","it security","cyber security","cybersicherheit","informationssicherheit"];
const WB_CANDIDATE_CPV_DIVISIONS=new Set(["35","42","50","75","77","79","85","90"]);
const DEFINITELY_NON_WB_CPV_PREFIXES=["904","905","771","772","793","796","853"];
const SUPPLY_OR_PROJECT_TITLE_TERMS=["lieferung","ersatzbeschaffung","beschaffung eines","beschaffung einer","ausstattung","verbrauchsmaterial","kraftstoff","leasing","neubau","sanierung","planung","beratung"];
const SERVICE_TITLE_CONFLICTS=Object.freeze({
  cleaning:["gutachter","gutachten","reinigungskonzept"],
  security:["sicherungsleistungen s-bahn","sicherungsleistungen bahn","generalsanierung","talbremsen","bahnübergang","strecke 1810","gleisbau"],
  "facility-management":["bauleistung","herrichtung von","herstellung von rasenflächen","herstellung und überarbeitung von rasenflächen","pflanzung","winterdienstgerät","winterdienstausstattung","winterdienstanbaugerät"],
  sicherheitstechnik:["bodycam","bodycams","software-as-a-service","abhörgeschützter besprechungsraum","altpapier","recycling von siedlungsabfällen"],
  "emergency-services":["beschaffung von","ersatzbeschaffung","rahmenliefer","liefervereinbarung","rettungsdienstbekleidung","rettungsdienstkleidung","rettungsdienststiefel","mietwäsche","wäsche- und prüfservice","einsatzfahrzeug","krankentransportwagen","rettungswagen","medizintechnik","ekg-gerät","informationssystem","datenerfassung","einsatzabrechnung","arzneimittel","krankenhausübung","schulung","bistrobetrieb","notfallrettung kulturgut"]
});

export const normalize=value=>String(value??"").normalize("NFKC").toLocaleLowerCase("de").replace(/[‐‑–—]/g,"-").replace(/\s+/g," ").trim();
export const unique=values=>[...new Set((values||[]).flat(Infinity).filter(value=>value!==null&&value!==undefined&&String(value).trim()).map(value=>String(value).trim()))];
const flatten=value=>{if(value===null||value===undefined)return[];if(Array.isArray(value))return value.flatMap(flatten);if(typeof value==="object")return Object.entries(value).flatMap(([key,item])=>[key,...flatten(item)]);return[String(value)]};
const values=(value,keys=[])=>{if(value===null||value===undefined)return[];if(keys.length&&typeof value==="object"&&!Array.isArray(value)){const picked=keys.flatMap(key=>flatten(value[key]));if(picked.length)return unique(picked)}return unique(flatten(value))};
const normalizeCpv=code=>{const digits=String(code??"").replace(/\D/g,"");return digits.length>=8?digits.slice(0,8):digits};
const canonicalCpvs=codes=>unique(codes).map(normalizeCpv).filter(code=>(/^\d{8}$/.test(code)||/^\d{2}$/.test(code))&&!code.startsWith("00")&&!code.startsWith("99")).map(code=>code.length===2?`${code}000000`:code);
const cpvMatch=(allowed,actual)=>allowed.some(prefix=>actual.some(code=>normalizeCpv(code).startsWith(String(prefix).replace(/\D/g,""))));
const termHits=(terms,text)=>unique(terms.map(normalize).filter(term=>term&&text.includes(term)));
const activeParameterMap=parameters=>Object.fromEntries((parameters||[]).filter(row=>!row.status||["ACTIVE","PROVIDED","VERIFIED","NONE_DECLARED","NOT_APPLICABLE","NOT_REQUIRED"].includes(String(row.status).toUpperCase())).map(row=>[row.parameter_key,row.new_value]));
const sectorFor=company=>company.sector_slug||({"wb-cleaning":"cleaning","wb-security":"security","wb-facilitys":"facility-management","wb-sicherheitstechnik":"sicherheitstechnik","wb-emergency-service":"emergency-services"}[company.technical_key]||([["cleaning","cleaning"],["security","security"],["facilitys","facility-management"],["sicherheitstechnik","sicherheitstechnik"],["emergency","emergency-services"]].find(([needle])=>normalize(company.legal_name).includes(needle))?.[1]||""));
const sourceText=({tender,lot,enrichment})=>normalize([tender.title,tender.description,tender.procurement_subject,tender.contract_type,lot?.title,lot?.description,enrichment?.structured_data?.title,enrichment?.structured_data?.description,enrichment?.structured_data?.scope,enrichment?.structured_data?.categories].map(x=>typeof x==="object"?JSON.stringify(x):x).filter(Boolean).join(" "));
const sourceTitle=({tender,lot,enrichment})=>normalize([tender.title,lot?.title,enrichment?.structured_data?.title].filter(Boolean).join(" "));
const sourceCpvs=({tender,lot,enrichment})=>unique([...(tender.cpv_codes||[]),...(lot?.cpv_codes||lot?.structured_data?.cpvCodes||[]),...(enrichment?.structured_data?.cpvCodes||[])]).map(x=>String(x).replace(/\D/g,""));
const configuredTerms=(p,key,names)=>values(p[key],names);

export function classifyCompanyService({tender,lot=null,enrichment=null,company,parameters=[],profile=null}){
  let sector=sectorFor(company),taxonomy=TAXONOMY[sector];const p=activeParameterMap(parameters),text=sourceText({tender,lot,enrichment}),titleText=sourceTitle({tender,lot,enrichment}),cpvCodes=sourceCpvs({tender,lot,enrichment});if(!taxonomy){const inferred=Object.entries(TAXONOMY).map(([key,value])=>({key,value,score:termHits(value.keywords,titleText).length+(cpvMatch(value.cpv,cpvCodes)?2:0)})).sort((a,b)=>b.score-a.score)[0];if(inferred?.score>0){sector=inferred.key;taxonomy=inferred.value}}
  const configuredPositive=unique([...configuredTerms(p,"A01",["activeServices","services","scope"]),...configuredTerms(p,"A05",["keywords"]),...configuredTerms(p,"A06",["synonyms"])]);
  const configuredCpvs=configuredTerms(p,"A03",["cpvCodes","codes"]);
  const configuredExcluded=unique([...configuredTerms(p,"A02",["inactiveServices","excluded","services"]),...configuredTerms(p,"A07",["exclusions","excluded","keywords"]),...configuredTerms(p,"A14",["exclusions","excluded","objects","customers"])]);
  const excludedCpvs=configuredTerms(p,"A04",["cpvCodes","excluded","codes"]),profileCapabilities=profile?.capabilities||{};
  const positiveTerms=unique([...(taxonomy?.keywords||[]),...configuredPositive,...(profileCapabilities.activeServices||[]),...(profileCapabilities.keywords||[]),...(profileCapabilities.synonyms||[])]);
  const positiveCpvs=unique([...(taxonomy?.cpv||[]),...configuredCpvs,...(profileCapabilities.cpvCodes||[])]);
  const exclusionTerms=unique([...(taxonomy?.exclusions||[]),...configuredExcluded,...(profileCapabilities.exclusions||[])]);
  const positives=termHits(positiveTerms,text),titlePositives=termHits(positiveTerms,titleText),exclusions=termHits(exclusionTerms,text),globalExclusions=termHits(GLOBAL_NEGATIVE,text),positiveCpv=cpvMatch(positiveCpvs,cpvCodes),excludedCpv=cpvMatch(excludedCpvs,cpvCodes),strongText=titlePositives.length>0||positives.length>=2;
  const protect=company.technical_key==="wb-protect-service"||company.sector_status==="manual-sector-approval-required",explicitA15=values(p.A15,["primaryCompanies","alternativeCompanies","allowedCompanies","assignments"]).map(normalize),a15Allowed=explicitA15.some(value=>value.includes(normalize(company.legal_name))||value.includes(normalize(company.technical_key))),titleProjectConflicts=termHits(SUPPLY_OR_PROJECT_TITLE_TERMS,titleText),serviceSpecificTitleConflicts=termHits(SERVICE_TITLE_CONFLICTS[sector]||[],titleText),serviceOnlyConflict=(["emergency-services","facility-management"].includes(sector)&&titleProjectConflicts.length>0)||serviceSpecificTitleConflicts.length>0;
  let status,gate,reason;
  if(protect&&!a15Allowed){status="NOT_APPLICABLE";gate="FAILED_NOT_RELEVANT";reason="Für WB-Protect & Service fehlt eine aktive eigene A15-Sektor- und Erlaubnisfreigabe."}
  else if(serviceOnlyConflict){status="EXCLUDED";gate="FAILED_EXCLUDED";reason=`Titel enthält einen geprüften fachlichen Konflikt zur operativen ${taxonomy?.label||sector}-Dienstleistung: ${unique([...titleProjectConflicts,...serviceSpecificTitleConflicts]).join(", ")}.`}
  else if(excludedCpv||exclusions.length){status="EXCLUDED";gate="FAILED_EXCLUDED";reason=`Aktiver Ausschluss für ${company.legal_name}: ${unique([...exclusions,...(excludedCpv?["A04-CPV"]:[])]).join(", ")}.`}
  else if(globalExclusions.length&&!strongText&&!positiveCpv){status="NOT_RELEVANT";gate="FAILED_NOT_RELEVANT";reason=`Fachfremder Vergabegegenstand: ${globalExclusions.join(", ")}.`}
  else if(strongText||positiveCpv){status="RELEVANT";gate="PASSED";reason=`Positiver ${taxonomy?.label||sector}-Scope: ${unique([...(titlePositives.length?titlePositives:positives),...(positiveCpv?["CPV"]:[])]).join(", ")}.`}
  else if(!text||text.length<24){status="MANUAL_CLASSIFICATION_REQUIRED";gate="REVIEW_REQUIRED";reason="Bekanntmachungsdaten reichen für eine sichere fachliche Zuordnung nicht aus."}
  else {status="NOT_APPLICABLE";gate="FAILED_NOT_RELEVANT";reason=`Keine positiven Leistungs- oder CPV-Signale für ${company.legal_name}.`}
  const score=(titlePositives.length*25)+(Math.max(0,positives.length-titlePositives.length)*5)+(positiveCpv?20:0)-(exclusions.length*30)-(excludedCpv?50:0)-(globalExclusions.length*10);
  return {companyId:company.company_id,companyName:company.legal_name,serviceLine:sector||"CONFIGURATION_REQUIRED",lotKey:lot?.lot_key||lot?.external_id||null,relevanceStatus:status,serviceScopeGate:gate,score,positiveSignals:positives,titlePositiveSignals:titlePositives,positiveCpv,exclusionSignals:unique([...exclusions,...globalExclusions]),cpvCodes,appliedRules:["A01","A02","A03","A04","A05","A06","A07","A14","A15"].map(key=>({key,active:p[key]!==undefined,value:p[key]??null})),reason,configurationRequired:!taxonomy||protect&&!a15Allowed,processable:PROCESSABLE_RELEVANCE.has(status)};
}

export function classifyTenderServices({tender,lot=null,enrichment=null,companies=[]}){
  const evaluations=companies.map(item=>classifyCompanyService({tender,lot,enrichment,...item})),eligible=evaluations.filter(x=>x.relevanceStatus==="RELEVANT").sort((a,b)=>b.score-a.score||a.companyName.localeCompare(b.companyName,"de"));
  const primary=eligible[0]||null;
  for(const evaluation of evaluations){evaluation.primaryCompany=Boolean(primary&&evaluation.companyId===primary.companyId);evaluation.alternativeCompany=false;if(primary&&evaluation!==primary&&!(["EXCLUDED","NOT_RELEVANT"].includes(evaluation.relevanceStatus)))evaluation.relevanceStatus="NOT_APPLICABLE",evaluation.serviceScopeGate="FAILED_NOT_RELEVANT",evaluation.reason=`Primärgesellschaft ist ${primary.companyName}; keine aktive A15-Alternativfreigabe für ${evaluation.companyName}.`,evaluation.processable=false}
  if(primary){
    const basis=primary.positiveCpv?"CPV":"TEXT_RULE";
    return {evaluations,primary,alternatives:[],overallStatus:"RELEVANT",decision:{wbRelevanceStatus:"RELEVANT",serviceLine:primary.serviceLine,confidence:"HIGH",basis,ruleId:`WB_${basis}_${primary.serviceLine}`,reason:primary.reason,score:primary.score}};
  }
  const cpvs=canonicalCpvs(evaluations.flatMap(item=>item.cpvCodes)),candidateCpv=cpvs.some(code=>WB_CANDIDATE_CPV_DIVISIONS.has(code.slice(0,2))),allCpvsDefinitelyOutside=cpvs.length>0&&cpvs.every(code=>!WB_CANDIDATE_CPV_DIVISIONS.has(code.slice(0,2))||DEFINITELY_NON_WB_CPV_PREFIXES.some(prefix=>code.startsWith(prefix))),negative=evaluations.find(item=>["EXCLUDED","NOT_RELEVANT"].includes(item.relevanceStatus));
  if(allCpvsDefinitelyOutside||negative){
    const ruleId=negative?"WB_EXPLICIT_EXCLUSION":candidateCpv?"WB_CPV_SPECIFIC_OUTSIDE_SCOPE":"WB_CPV_DIVISION_OUTSIDE_SCOPE";
    const reason=negative?negative.reason:candidateCpv?`Alle belastbaren spezifischen CPV-Codes liegen in fachlich ausgeschlossenen Leistungsfamilien (${unique(cpvs.map(code=>code.slice(0,3))).join(", ")}).`:`Alle belastbaren CPV-Hauptgruppen liegen außerhalb des konfigurierten WB-Leistungsspektrums (${unique(cpvs.map(code=>code.slice(0,2))).join(", ")}).`;
    return {evaluations,primary:null,alternatives:[],overallStatus:"NOT_RELEVANT",decision:{wbRelevanceStatus:"NOT_RELEVANT",serviceLine:null,confidence:"HIGH",basis:negative?"EXCLUSION_RULE":candidateCpv?"CPV_SPECIFIC":"CPV_DIVISION",ruleId,reason,score:negative?.score??0}};
  }
  const review=evaluations.find(item=>item.configurationRequired)||evaluations[0];
  if(review){review.relevanceStatus="MANUAL_CLASSIFICATION_REQUIRED";review.serviceScopeGate="REVIEW_REQUIRED";review.serviceLine="review";review.reason=cpvs.length?"WB-naher CPV-Bereich ohne hinreichend eindeutiges Gewerkssignal; Zuordnung zur Prüfgruppe.":"Keine belastbare CPV- oder Textgrundlage für eine sichere WB-Relevanzentscheidung; Zuordnung zur Prüfgruppe.";review.processable=true;review.primaryCompany=false;}
  const reason=review?.reason||"Keine belastbare Klassifizierungsgrundlage.";
  return {evaluations,primary:null,alternatives:[],overallStatus:"MANUAL_CLASSIFICATION_REQUIRED",decision:{wbRelevanceStatus:"REVIEW_REQUIRED",serviceLine:null,confidence:"REVIEW",basis:cpvs.length?"ADJACENT_CPV":"INSUFFICIENT_EVIDENCE",ruleId:cpvs.length?"WB_ADJACENT_CPV_REVIEW":"WB_INSUFFICIENT_EVIDENCE_REVIEW",reason,score:0}};
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
