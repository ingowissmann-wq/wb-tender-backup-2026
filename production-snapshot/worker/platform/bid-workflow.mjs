import crypto from "node:crypto";

export const BID_APPROVAL_CONFIRMATION_PHRASE="Ich gebe diese konkrete Kalkulationsversion und das daraus erzeugte Angebot zur verbindlichen Teilnahme und Angebotsabgabe frei.";

const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
};

export const manifestHash = value => crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");

export const approvalBinding = input => {
  const normalized = {
    ...input,
    documentVersion: input.documentVersion ?? input.documentRevision,
    offerVersion: input.offerVersion ?? input.bidPackageVersion
  };
  const required = ["tenderId", "lotKey", "companyId", "portalAdapterId", "tenderVersionId", "documentVersion", "calculationId", "calculationVersion", "managementOutputId", "managementVersion", "offerVersion", "approverRole"];
  const missing = required.filter(key => normalized[key] === undefined || normalized[key] === null || normalized[key] === "");
  if (missing.length) return { status: "BID_SUBMISSION_BLOCKED", missing, binding: null, sha256: null };
  const core = Object.fromEntries(required.map(key => [key, normalized[key]]));
  const binding = {...core,auditId:normalized.auditId||`APR-${manifestHash(core).slice(0,32)}`};
  return { status: "APPROVAL_BINDING_READY", missing: [], binding, sha256: manifestHash(binding) };
};

export const evaluateSubmissionGate = input => {
  const reasons = [];
  const require = (condition, code, detail) => { if (!condition) reasons.push({ code, detail }); };
  require(input.publicReal === true, "REAL_TENDER_REQUIRED", "Fixtures, Szenarien und historische Datensätze sind ausgeschlossen.");
  require(input.tenderActive === true, "TENDER_NOT_ACTIVE", "Die Ausschreibung ist nicht aktiv oder nicht mehr angebotsfähig.");
  require(input.deadlineOpen === true, "DEADLINE_NOT_OPEN", "Die Angebotsfrist ist nicht nachweislich offen.");
  require(input.calculationStatus === "CALCULATED", "CALCULATION_NOT_REAL", "Eine vollständige reale Kalkulation fehlt.");
  require(input.managementOutputCurrent === true, "MANAGEMENT_OUTPUT_NOT_CURRENT", "Die Managementausgabe fehlt oder ist veraltet.");
  require(input.documentsVerified === true, "DOCUMENTS_NOT_VERIFIED", "Nicht alle kalkulationsrelevanten Dokumente sind Tender und Los verifiziert.");
  require(input.packageComplete === true, "BID_PACKAGE_INCOMPLETE", "Pflichtfelder, Dateien oder Nachweise fehlen.");
  require(input.approvalStatus === "APPROVED", "VERSION_BOUND_APPROVAL_MISSING", "Die konkrete Angebotsversion ist nicht freigegeben.");
  require(Boolean(input.bindingHash) && input.bindingHash === input.approvalPayloadHash, "APPROVAL_BINDING_MISMATCH", "Freigabe und aktueller Tender-/Dokument-/Kalkulationsstand stimmen nicht überein.");
  require(input.portalSessionValid === true, "PORTAL_SESSION_INVALID", "Die reguläre Portalsession ist nicht gültig.");
  require(input.mfaComplete === true, "MFA_REQUIRED", "Die erforderliche MFA ist nicht abgeschlossen.");
  require(input.perActionRelease === true, "EXTERNAL_ACTION_LOCKED", "Die einmalige tenderbezogene externe Freigabe ist nicht geöffnet.");
  require(input.alreadySubmitted !== true, "IDENTICAL_SUBMISSION_EXISTS", "Eine identische Abgabe ist bereits bestätigt.");
  return { status: reasons.length ? "BID_SUBMISSION_BLOCKED" : "BID_PACKAGE_READY_FOR_SUBMISSION", reasons, transmitted: false };
};

export const idempotencyKey = binding => manifestHash({
  tenderId: binding.tenderId,
  lotKey: binding.lotKey,
  portalAdapterId: binding.portalAdapterId,
  bidSubmissionApprovalId: binding.bidSubmissionApprovalId,
  calculationVersion: binding.calculationVersion,
  bidPackageVersion: binding.bidPackageVersion
});

export const assertExternalActionAllowed = gate => {
  if (gate?.status !== "BID_PACKAGE_READY_FOR_SUBMISSION") {
    const error = new Error("external_action_locked");
    error.code = "EXTERNAL_ACTION_LOCKED";
    error.statusCode = 423;
    throw error;
  }
  return true;
};
