import crypto from "node:crypto";

export const REQUIRED_DOCUMENT_STATUSES = new Set([
  "MISSING","AVAILABLE","UPLOADED_PENDING_VALIDATION","MANUAL_REVIEW_REQUIRED",
  "VALIDATED","REJECTED","NOT_REQUIRED","SUPERSEDED",
]);

const meaningfulValue = (value) => Array.isArray(value)
  ? value.some(meaningfulValue)
  : typeof value === "string" ? value.trim().length > 0 : value === true;

export function materiallyEditedPdfWorkingCopy({ elements = [], sourceFields = [], fields = {} } = {}) {
  const meaningfulOverlay = Array.isArray(elements) && elements.some((element) =>
    element && (["mark"].includes(element.type) ||
      (element.type === "checkbox" && element.checked === true) ||
      (["text","note"].includes(element.type) && String(element.text || "").trim().length > 0)));
  if (meaningfulOverlay) return true;
  const original = new Map((sourceFields || []).filter((field) => field?.editable).map((field) => [field.name, field.value]));
  return Object.entries(fields || {}).some(([name, value]) => {
    if (!meaningfulValue(value) && !meaningfulValue(original.get(name))) return false;
    return JSON.stringify(value ?? null) !== JSON.stringify(original.get(name) ?? null);
  });
}

export function effectiveRequiredDocumentStatus(requirement = {}) {
  if (requirement.satisfaction_status !== "MISSING") return requirement.satisfaction_status;
  return requirement.working_copy_material === true ? "MANUAL_REVIEW_REQUIRED" : "MISSING";
}

export const isManuallyNotRequiredForSubmission = (requirement = {}) =>
  requirement.manual_submission_relevance_override === false;

export const isRequiredDocumentMissing = (requirement) =>
  requirement.mandatory && requirement.submission_relevant &&
  !isManuallyNotRequiredForSubmission(requirement) &&
  ["MISSING","REJECTED"].includes(requirement.satisfaction_status);

export const isRequiredDocumentBlocker = (requirement) =>
  requirement.mandatory && requirement.submission_relevant &&
  !isManuallyNotRequiredForSubmission(requirement) &&
  !["VALIDATED","NOT_REQUIRED","SUPERSEDED"].includes(requirement.satisfaction_status);

const textFromPdf = (buffer) => {
  const latin = buffer.toString("latin1");
  return [...latin.matchAll(/\(([^()]*)\)\s*Tj/g)].map((m) => m[1])
    .join(" ").replace(/\\[nrt]/g," ").replace(/\s+/g," ").trim();
};

export function inspectUploadedDocument({ buffer, filename, mediaType, requirement }) {
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const lower = filename.toLowerCase();
  const pdf = buffer.subarray(0,5).toString("ascii") === "%PDF-";
  const zip = buffer[0] === 0x50 && buffer[1] === 0x4b;
  const detected = pdf ? "application/pdf" : zip ?
    (lower.endsWith(".docx") ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" :
      lower.endsWith(".xlsx") ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/zip") :
    "application/octet-stream";
  const accepted = requirement.accepted_formats || [];
  const text = pdf ? textFromPdf(buffer) : "";
  const errors = [], warnings = [];
  if (!buffer.length) errors.push("Die Datei ist leer.");
  if (/^\s*<(?:!doctype\s+html|html)/i.test(buffer.subarray(0,512).toString("utf8")))
    errors.push("Die Datei ist eine HTML-Seite und kein Nachweisdokument.");
  if (buffer.length > Number(requirement.max_file_size)) errors.push("Die zulässige Dateigröße wurde überschritten.");
  if (!accepted.includes(detected) && !accepted.includes(mediaType)) errors.push("Das Dateiformat ist für diese Anforderung nicht zugelassen.");
  if (mediaType && mediaType !== detected && detected !== "application/octet-stream") warnings.push("Dateiendung bzw. gemeldeter Medientyp weicht vom erkannten Format ab.");
  if (/javascript|\/JS\b|\/OpenAction\b|\/Launch\b/i.test(buffer.toString("latin1")))
    errors.push("Die PDF enthält aktive oder ausführbare Inhalte.");
  const normalized = `${filename} ${text}`.toLowerCase();
  let outcome = errors.length ? "REJECTED" : "MANUAL_REVIEW_REQUIRED";
  if (!errors.length && requirement.document_type === "OBJECT_INSPECTION_CERTIFICATE") {
    const typePlausible = /objekt.{0,20}(begeh|besichtig)|begehungs(?:bescheinigung|protokoll)/i.test(normalized);
    const datePresent = /\b(?:0?[1-9]|[12]\d|3[01])[.\/-](?:0?[1-9]|1[0-2])[.\/-](?:20)?\d{2}\b/.test(normalized);
    const signatures = (normalized.match(/unterschrift|gez\.|signatur|bestätigt/g) || []).length;
    if (!typePlausible) errors.push("Das Dokument ist nicht plausibel als Objektbegehungsbescheinigung erkennbar.");
    if (!datePresent) errors.push("Ein Begehungsdatum ist nicht erkennbar.");
    if (errors.length) outcome = "REJECTED";
    else if (signatures < 2) {
      warnings.push("Die geforderten Bestätigungen beider Parteien konnten nicht sicher festgestellt werden.");
      outcome = "MANUAL_REVIEW_REQUIRED";
    } else outcome = "MANUAL_REVIEW_REQUIRED"; // Visuelle Unterschriftenprüfung bleibt menschlich.
  }
  return { sha256, detectedMediaType: detected, extractedText: text.slice(0,20000), errors, warnings, outcome,
    malwareScanStatus: "NOT_AVAILABLE", readable: !errors.some((x)=>/leer|HTML|aktive/.test(x)) };
}

export const submissionDocumentsComplete = (requirements) =>
  requirements.filter((r)=>r.mandatory && r.submission_relevant && !isManuallyNotRequiredForSubmission(r))
    .every((r)=>["VALIDATED","NOT_REQUIRED","SUPERSEDED"].includes(r.satisfaction_status));

const requirementPatterns = [
  ["OBJECT_INSPECTION_CERTIFICATE","Objektbegehungsbescheinigung",/objekt(?:begehung|besichtigung)|begehungs(?:bescheinigung|protokoll)/i,false],
  ["INSURANCE_CERTIFICATE","Versicherungsnachweis",/versicherungs(?:nachweis|bestätigung)|betriebshaftpflicht/i,true],
  ["TRADE_REGISTER_EXTRACT","Handelsregisterauszug",/handelsregisterauszug/i,true],
  ["BUSINESS_REGISTRATION","Gewerbeanmeldung",/gewerbeanmeldung/i,true],
  ["REFERENCE_EVIDENCE","Referenznachweis",/referenz(?:nachweis|formular|bescheinigung)/i,false],
  ["SUBCONTRACTOR_DECLARATION","Nachunternehmererklärung",/nachunternehmer|unterauftragnehmer/i,false],
  ["MINIMUM_WAGE_DECLARATION","Mindestlohnerklärung",/mindestlohn(?:erklärung|gesetz)/i,false],
  ["LOYALTY_TO_COLLECTIVE_AGREEMENT","Tariftreueerklärung",/tariftreueerklärung/i,false],
  ["CONCEPT","Konzept",/konzept(?:vorlage|beschreibung)/i,false],
  ["CERTIFICATE","Zertifikat",/zertifikat|zertifizierung/i,true],
];
export function detectRequiredDocuments({text,sourceDocumentId=null,sourcePage=null,sourceReference="Vergabeunterlage"}){
  const normalized=String(text||"").replace(/\s+/g," "),mandatory=/(?:muss|sind|ist)\b.{0,100}(?:einzureichen|beizufügen|vorzulegen|hochzuladen)|zwingend|ausschluss/i;
  if(!mandatory.test(normalized))return [];
  return requirementPatterns.filter(([, ,pattern])=>pattern.test(normalized)).map(([code,title,,reusable])=>({requirementCode:code,requirementTitle:title,requirementDescription:normalized.slice(0,1200),sourceDocumentId,sourcePage,sourceReference,mandatory:true,submissionRelevant:true,reusableCompanyEvidence:reusable,sourceType:"TENDER_DOCUMENT"}));
}

export function requirementLabel(status) {
  return ({MISSING:"Einzureichendes Dokument fehlt",AVAILABLE:"Einzureichendes Dokument vorhanden",UPLOADED_PENDING_VALIDATION:"Dokument wurde gespeichert und wird geprüft",MANUAL_REVIEW_REQUIRED:"Dokument gespeichert – bereit zur fachlichen Prüfung",VALIDATED:"Dokument geprüft und vollständig",REJECTED:"Dokument passt nicht zur geforderten Unterlage",NOT_REQUIRED:"Nicht erforderlich",SUPERSEDED:"Durch neuere Anforderung ersetzt"})[status] || "Status nicht verfügbar";
}
