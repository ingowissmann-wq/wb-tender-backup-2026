import crypto from "node:crypto";

const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

// Classifiers label source evidence; they never create requirements on their own.
const classifiers = [
  ["REQUIRED_DOCUMENT", "MISSING_DOCUMENT", "INSURANCE", /versicherungs(?:nachweis|bestätigung)|betriebshaftpflicht/i],
  ["REQUIRED_DOCUMENT", "MISSING_DOCUMENT", "REGISTER", /handelsregisterauszug|gewerbeanmeldung/i],
  ["REFERENCE", "COMPANY_INPUT", "REFERENCE", /referenz(?:nachweis|formular|bescheinigung|projekt)/i],
  ["CONCEPT", "CONCEPT", "CONCEPT", /\bkonzept(?:e|es|vorlage|beschreibung)?\b/i],
  ["SIGNATURE", "SIGNATURE", "SIGNATURE", /unterschrift|signatur|textform|126b\s*bgb|erklärende person/i],
  ["PRICE_FIELD", "PRICE_CALCULATION", "PRICE", /preisblatt|kalkulationsvorlage|einheitspreis|gesamtpreis|preisposition/i],
  ["PORTAL_FORM", "PORTAL_FORM", "DECLARATION", /eigenerklärung|formblatt|kriterienkatalog/i],
  ["REQUIRED_DOCUMENT", "MISSING_DOCUMENT", "CERTIFICATE", /zertifikat|bescheinigung|nachweis|protokoll|erklärung/i],
];
const normative = /\b(?:muss|müssen|ist|sind)\b.{0,180}\b(?:einzureichen|beizufügen|vorzulegen|auszufüllen|anzugeben|hochzuladen|zu bestätigen|zu unterzeichnen)|\b(?:zwingend|required|pflicht(?:feld|angabe|unterlage)?|ausschlusskriterium)\b/i;

export function discoverSourceRequirements({ pages, sourceDocumentId, sourceReference, lotKey, deadline }) {
  const found = [];
  for (const page of pages || []) {
    const text = clean(typeof page === "string" ? page : page?.text);
    if (!text) continue;
    const sentences = text.split(/(?<=[.!?;:])\s+(?=[A-ZÄÖÜ0-9])/);
    for (let index = 0; index < sentences.length; index += 1) {
      const excerpt = clean(sentences.slice(Math.max(0,index-1), index+2).join(" ")).slice(0,1800);
      if (!normative.test(excerpt)) continue;
      const match = classifiers.find((entry) => entry[3].test(excerpt));
      if (!match) continue;
      const [kind, actionGroup, category] = match;
      const evidenceHash = hash(`${sourceDocumentId}|${page?.page || page?.pageNumber || index + 1}|${excerpt}`);
      found.push({
        requirementKey: `${kind}:${category}:${evidenceHash.slice(0,20)}`,
        requirementKind: kind,
        title: titleFor(kind, category, excerpt), description: excerpt,
        sourceType: "TENDER_DOCUMENT", sourceDocumentId,
        sourcePage: Number(page?.page || page?.pageNumber || index + 1),
        sourceReference, sourceExcerpt: excerpt, sourceEvidenceSha256: evidenceHash,
        scopeType: lotKey ? "LOT" : "PROCEDURE", category, mandatory: true,
        submissionRelevant: true,
        humanActionRequired: ["SIGNATURE","CONCEPT","REFERENCE"].includes(kind),
        legalConfirmationRequired: kind === "SIGNATURE" || /eigenerklärung|bestätigen/i.test(excerpt),
        actionGroup, status: kind === "SIGNATURE" ? "USER_CONFIRMATION_REQUIRED" :
          ["CONCEPT","REFERENCE"].includes(kind) ? "MANAGEMENT_REVIEW_REQUIRED" : "MISSING",
        dueAt: deadline || null,
      });
    }
  }
  // One human action represents one semantic obligation on one source page. OCR
  // sentence windows frequently overlap and must not multiply board work.
  const canonical = new Map();
  for (const item of found) {
    const key=[item.sourceDocumentId,item.sourcePage,item.requirementKind,item.category,item.scopeType,lotKey||'PROCEDURE'].join('|');
    const prior=canonical.get(key);
    if (!prior || item.sourceExcerpt.length>prior.sourceExcerpt.length) canonical.set(key,item);
  }
  return [...canonical.values()];
}

export function explicitDocumentLotKeys(value) {
  const text=String(value||'');
  const found=new Set();
  for (const match of text.matchAll(/(?:\blos\s*|\blot[-_\s]*|[_-]l)(\d{1,4})\b/gi)) found.add(`LOT-${String(Number(match[1])).padStart(4,'0')}`);
  return [...found];
}

function titleFor(kind, category, excerpt) {
  if (kind === "SIGNATURE") return "Erklärung oder Signatur bestätigen";
  if (kind === "PRICE_FIELD") return "Preis- oder Kalkulationsangabe vervollständigen";
  if (kind === "CONCEPT") return "Gefordertes Konzept prüfen";
  if (kind === "REFERENCE") return "Referenzanforderung erfüllen";
  if (kind === "PORTAL_FORM") return "Gefordertes Formular vervollständigen";
  const noun = excerpt.match(/(?:einzureichende[nrms]?|beizufügende[nrms]?|vorzulegende[nrms]?|erforderliche[nrms]?|zwingende[nrms]?)\s+([^,.;:]{3,100})/i)?.[1];
  return noun ? clean(noun).slice(0,120) : ({INSURANCE:"Versicherungsnachweis",REGISTER:"Register- oder Gewerbenachweis",CERTIFICATE:"Geforderter Nachweis"}[category] || "Geforderte Unterlage");
}

export function extractPages(extractedData) {
  const value = typeof extractedData === "string" ? JSON.parse(extractedData) : extractedData || {};
  if (Array.isArray(value.pages)) return value.pages;
  if (Array.isArray(value.documents)) return value.documents.flatMap((document) => document.pages || []);
  if (value.text) return [{ page: 1, text: value.text }];
  return [];
}

export function evaluatePackageReadiness({ bindingValid, requirements, portalSchemaAuthoritative, portalMappingComplete, bidPackage, activeCompanyProfile, approvalValid, submissionContextValid }) {
  const open = requirements.filter((item) => item.submission_relevant && item.mandatory && !["VALIDATED","NOT_REQUIRED"].includes(item.status));
  const human = open.filter((item) => item.human_action_required || ["USER_CONFIRMATION_REQUIRED","MANAGEMENT_REVIEW_REQUIRED","MANUAL_REVIEW_REQUIRED"].includes(item.status));
  const blockers = [];
  if (!bindingValid) blockers.push({type:"CURRENT_CONTEXT_BINDING",message:"Aktuelle Versionen sind nicht durchgängig gebunden."});
  if (!activeCompanyProfile) blockers.push({type:"ACTIVE_COMPANY_PROFILE",message:"Eine aktive, freigegebene Gesellschaftsprofilversion ist nicht gebunden."});
  if (!bidPackage) blockers.push({type:"BID_PACKAGE",message:"Aktuelles Bid Package fehlt."});
  if (!approvalValid) blockers.push({type:"APPROVAL",message:"Die aktuelle Paket- und Kalkulationsversion ist nicht gültig freigegeben."});
  if (!submissionContextValid) blockers.push({type:"SUBMISSION_CONTEXT",message:"Der aktuelle Abgabekontext hat den verbindlichen Preflight nicht bestanden."});
  if (open.length) blockers.push({type:"OPEN_REQUIREMENTS",count:open.length,message:"Konkrete Anforderungen sind noch offen."});
  if (portalSchemaAuthoritative && !portalMappingComplete) blockers.push({type:"PORTAL_MAPPING",message:"Portalzuordnung ist noch unvollständig."});
  const status = !bindingValid || !activeCompanyProfile || !bidPackage || !approvalValid || !submissionContextValid || open.length || (portalSchemaAuthoritative && !portalMappingComplete)
    ? (human.length ? "WAITING_FOR_USER_INPUT" : "PACKAGE_INCOMPLETE") : "PREFLIGHT_READY";
  return { status, blockers, requiredDocumentsComplete: !open.some((x) => x.requirement_kind === "REQUIRED_DOCUMENT"), humanActionsComplete: human.length === 0 };
}
