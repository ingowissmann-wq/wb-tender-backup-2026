import crypto from "node:crypto";

const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
export const REQUIREMENT_CLASSIFIER_VERSION = "wb-bid-time-requirement/1.0.0";

const BID_TIME = /\b(?:mit|zusammen\s+mit)\s+(?:dem\s+)?angebot\b|\b(?:dem\s+)?angebot\s+(?:beizufügen|beizulegen)|\bbei\s+(?:der\s+)?angebotsabgabe\b|\bbis\s+(?:zum\s+)?ablauf\s+der\s+angebotsfrist\b/i;
const POST_AWARD = /\b(?:nach|unverzüglich\s+nach)\s+(?:der\s+)?zuschlag(?:s|-?serteilung)?\b|\bnach\s+auftragserteilung\b/i;
const PERFORMANCE_TIME = /\b(?:spätestens\s+\d+\s+(?:tage|wochen)\s+)?vor\s+(?:dem|der)\s+(?:geplanten?\s+)?(?:erst)?einsatz\b|\bvor\s+(?:aufnahme|beginn)\s+(?:der\s+)?(?:leistung|tätigkeit|dienstleistung)|\bwährend\s+(?:der\s+)?vertragslaufzeit\b|\bbei\s+(?:der\s+)?ausführung\b/i;
const FILLABLE = /\b(?:vom\s+bieter\s+)?auszufüllen\b|\bformblatt\b.{0,120}\b(?:ausfüllen|vervollständigen)\b|\[(?:\s|x)?\].{0,500}\bnur\s+eine\s+antwort\s+wählbar\b|\b(?:mussangabe|pflichtfeld)\b.{0,500}\[(?:\s|x)?\]/i;
const CONTRACT_CONTEXT = /\b(?:dienstleistungsvertrag|leistungsbeschreibung|auftragnehmer|\bAN\b)\b/i;

export function classifyRequirementEvidence(value) {
  const text = clean(value);
  if (POST_AWARD.test(text)) return {
    classification: "POST_AWARD_EVIDENCE",
    eligible: false,
    actionType: "NONE",
    reason: "Nachweis ist ausdrücklich erst nach Zuschlag oder Auftragserteilung vorzulegen.",
    rule: "POST_AWARD_EXPLICIT",
  };
  if (BID_TIME.test(text) && FILLABLE.test(text)) return {
    classification: "FILLABLE_BIDDER_FORM",
    eligible: true,
    actionType: "PDF_EDITOR",
    reason: "Bieterformular ist ausdrücklich mit oder bis zur Angebotsabgabe auszufüllen.",
    rule: "BID_TIME_FILLABLE_EXPLICIT",
  };
  if (BID_TIME.test(text)) return {
    classification: "BID_TIME_UPLOAD_EVIDENCE",
    eligible: true,
    actionType: "UPLOAD",
    reason: "Nachweis ist ausdrücklich mit dem Angebot oder bis zur Angebotsfrist einzureichen.",
    rule: "BID_TIME_UPLOAD_EXPLICIT",
  };
  if (FILLABLE.test(text)) return {
    classification: "FILLABLE_BIDDER_FORM",
    eligible: true,
    actionType: "PDF_EDITOR",
    reason: "Die Fundstelle enthält eindeutig vom Bieter zu bearbeitende Formularfelder.",
    rule: "BIDDER_FORM_FIELDS_EXPLICIT",
  };
  if (PERFORMANCE_TIME.test(text) || (CONTRACT_CONTEXT.test(text) && /\b(?:hat|verpflichtet|vorzulegen|nachzuweisen|zu\s+übergeben)\b/i.test(text))) return {
    classification: "CONTRACT_PERFORMANCE_CLAUSE",
    eligible: false,
    actionType: "NONE",
    reason: "Pflicht betrifft Vertragsdurchführung oder Personal-/Leistungseinsatz, nicht die Angebotsabgabe.",
    rule: PERFORMANCE_TIME.test(text) ? "PERFORMANCE_TIME_EXPLICIT" : "CONTRACT_OBLIGATION_CONTEXT",
  };
  return {
    classification: "INFORMATIONAL_TEXT",
    eligible: false,
    actionType: "NONE",
    reason: "Keine eindeutige bid-time Einreichungs- oder auszufüllende Bieterpflicht belegt.",
    rule: "NO_BID_TIME_EVIDENCE",
  };
}

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
      const evidenceClassification = classifyRequirementEvidence(excerpt);
      if (!evidenceClassification.eligible) continue;
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
        requirementClassification: evidenceClassification.classification,
        classificationReason: evidenceClassification.reason,
        classificationProvenance: {
          classifierVersion: REQUIREMENT_CLASSIFIER_VERSION,
          rule: evidenceClassification.rule,
          sourceEvidenceSha256: evidenceHash,
          deterministic: true,
        },
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
  const open = requirements.filter((item) => item.submission_relevant && item.mandatory && item.manual_submission_relevance_override !== false && !["VALIDATED","NOT_REQUIRED","SUPERSEDED"].includes(item.status));
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
