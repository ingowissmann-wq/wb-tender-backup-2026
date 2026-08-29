import crypto from "node:crypto";

export const SUBMISSION_STATES=Object.freeze([
  "NOT_READY","WAITING_FOR_PORTAL_ACCOUNT","WAITING_FOR_CREDENTIALS","WAITING_FOR_SESSION","WAITING_FOR_MFA",
  "SESSION_READY","SUBMISSION_AREA_READY","PACKAGE_MAPPING","PREFLIGHT_RUNNING","PREFLIGHT_BLOCKED","PREFLIGHT_PASSED",
  "READY_FOR_FINAL_SUBMISSION","FINAL_APPROVAL_REQUIRED","FINAL_APPROVED","SUBMITTING","SUBMITTED","RECEIPT_VERIFIED",
  "SUBMISSION_STATE_UNKNOWN","FAILED","EXPIRED"
]);

const transitions=Object.freeze({
  NOT_READY:["WAITING_FOR_PORTAL_ACCOUNT","WAITING_FOR_CREDENTIALS","WAITING_FOR_SESSION","EXPIRED"],
  WAITING_FOR_PORTAL_ACCOUNT:["WAITING_FOR_CREDENTIALS","EXPIRED"],
  WAITING_FOR_CREDENTIALS:["WAITING_FOR_SESSION","EXPIRED"],
  WAITING_FOR_SESSION:["WAITING_FOR_MFA","SESSION_READY","FAILED","EXPIRED"],
  WAITING_FOR_MFA:["SESSION_READY","FAILED","EXPIRED"],SESSION_READY:["SUBMISSION_AREA_READY","WAITING_FOR_SESSION","FAILED","EXPIRED"],
  SUBMISSION_AREA_READY:["PACKAGE_MAPPING","WAITING_FOR_SESSION","FAILED","EXPIRED"],PACKAGE_MAPPING:["PREFLIGHT_RUNNING","PREFLIGHT_BLOCKED","FAILED","EXPIRED"],
  PREFLIGHT_RUNNING:["PREFLIGHT_BLOCKED","PREFLIGHT_PASSED","WAITING_FOR_SESSION","FAILED","EXPIRED"],PREFLIGHT_BLOCKED:["PACKAGE_MAPPING","PREFLIGHT_RUNNING","WAITING_FOR_SESSION","EXPIRED"],
  PREFLIGHT_PASSED:["FINAL_APPROVAL_REQUIRED","PREFLIGHT_RUNNING","EXPIRED"],FINAL_APPROVAL_REQUIRED:["FINAL_APPROVED","PREFLIGHT_RUNNING","EXPIRED"],
  FINAL_APPROVED:["READY_FOR_FINAL_SUBMISSION","PREFLIGHT_RUNNING","EXPIRED"],READY_FOR_FINAL_SUBMISSION:["SUBMITTING","PREFLIGHT_RUNNING","EXPIRED"],
  SUBMITTING:["SUBMITTED","SUBMISSION_STATE_UNKNOWN","FAILED"],SUBMISSION_STATE_UNKNOWN:["SUBMITTED","FAILED"],SUBMITTED:["RECEIPT_VERIFIED","SUBMISSION_STATE_UNKNOWN"],
  RECEIPT_VERIFIED:[],FAILED:["WAITING_FOR_SESSION","PACKAGE_MAPPING","PREFLIGHT_RUNNING"],EXPIRED:[]
});

const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
export const submissionHash=value=>crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
export const submissionBinding=input=>Object.freeze({tenderId:input.tenderId??input.tender_id,lotKey:input.lotKey??input.lot_key??"",companyId:input.companyId??input.company_id,portalId:input.portalId??input.portal_id,portalAdapterId:input.portalAdapterId??input.portal_adapter_id,approvalRequestId:input.approvalRequestId??input.approval_request_id,bidPackageId:input.bidPackageId??input.bid_package_id,bidPackageVersion:Number(input.bidPackageVersion??input.bid_package_version),documentVersion:input.documentVersion??input.document_version,calculationVersion:Number(input.calculationVersion??input.calculation_version),managementVersion:Number(input.managementVersion??input.management_version),bidVersion:Number(input.bidVersion??input.bid_version),deadline:input.deadline});
export const submissionFingerprint=input=>submissionHash(submissionBinding(input));

export function assertTransition(from,to){if(!SUBMISSION_STATES.includes(from)||!SUBMISSION_STATES.includes(to)||!transitions[from]?.includes(to)){const error=new Error(`submission_transition_invalid:${from}:${to}`);error.code="SUBMISSION_TRANSITION_INVALID";throw error}return true}

export const SUBMISSION_ADAPTER_METHODS=Object.freeze(["buildInternalPackage","validateInternalPackage","mapInternalPackage","simulateSubmission","planPortalStaging","planFinalHandoff","pollReadOnlyFeedback","resolveSubmissionTarget","ensureAuthenticated","resolveTender","resolveLot","openSubmissionArea","inspectRequiredFields","inspectRequiredDocuments","mapBidPackage","uploadDocuments","fillPriceFields","fillPortalFields","validatePortalState","runPreflight","submit","captureReceipt","resumeAfterReauth"]);
export function validateSubmissionAdapter(adapter){const missing=SUBMISSION_ADAPTER_METHODS.filter(method=>typeof adapter?.[method]!=="function");if(missing.length){const error=new Error(`submission_adapter_contract_incomplete:${missing.join(",")}`);error.code="SUBMISSION_ADAPTER_CONTRACT_INCOMPLETE";throw error}return adapter}

export function mapBidPackage({documents=[],requirements=[]}){const byCategory=new Map(documents.map(document=>[document.category,document]));return requirements.map(requirement=>{const document=byCategory.get(requirement.category);return {category:requirement.category,label:requirement.label,required:requirement.required!==false,portalTarget:requirement.portalTarget||requirement.category,documentId:document?.id||null,filename:document?.filename||document?.storage_key||null,format:document?.format||null,sizeBytes:document?.output_size_bytes??null,sha256:document?.sha256||null,uploadStatus:document?"NOT_UPLOADED":"MISSING"}})}

export function evaluateEnterprisePreflight(input){const blockers=[],check=(ok,code,message)=>{if(!ok)blockers.push({code,message})};
  check(input.managementApprovalValid===true,"MANAGEMENT_APPROVAL_INVALID","Die Managementfreigabe ist nicht gültig oder nicht aktuell.");
  check(input.bidPackageReady===true,"BID_PACKAGE_NOT_READY","Das kanonische Bid Package ist nicht vollständig.");
  check(input.portalSupportsSubmission===true,"PORTAL_SUBMISSION_UNAVAILABLE","Das Portal ist keine Plattform für Angebotsabgaben.");
  check(input.autopilotSupportsSubmission===true,"AUTOPILOT_SUBMISSION_NOT_IMPLEMENTED","Der Submission-Adapter ist noch nicht produktiv implementiert.");
  check(input.portalAccountPresent===true,"PORTAL_ACCOUNT_REQUIRED","Für dieses Portal ist ein Bieterkonto erforderlich.");
  check(input.credentialsPresent===true,"PORTAL_CREDENTIALS_REQUIRED","Für dieses Portal fehlen Zugangsdaten.");
  if(input.credentialsPresent===true)check(input.credentialsSubmissionCapable===true,"PORTAL_ACCOUNT_READ_ONLY","Der hinterlegte Portalzugang ist nur für lesende Zugriffe freigegeben.");
  check(input.portalSessionValid===true,"PORTAL_SESSION_REQUIRED","Die Portalsitzung ist nicht gültig.");
  check(input.mfaComplete===true,"MFA_REQUIRED","Die erforderliche MFA ist noch nicht abgeschlossen.");
  check(input.targetResolved===true,"SUBMISSION_TARGET_UNRESOLVED","Verfahren, Los oder Bieterbereich konnten nicht autoritativ aufgelöst werden.");
  check(input.deadlineOpen===true,"DEADLINE_CLOSED","Die Angebotsfrist ist nicht offen.");
  check(input.packageMapped===true,"PACKAGE_MAPPING_INCOMPLETE","Das Bid Package ist nicht vollständig auf die Portalanforderungen gemappt.");
  check(input.requiredDocumentsComplete===true,"REQUIRED_DOCUMENTS_MISSING","Pflichtdokumente fehlen.");
  check(input.formatsAccepted===true,"DOCUMENT_FORMAT_INVALID","Mindestens ein Dateiformat wird vom Portal nicht akzeptiert.");
  check(input.sizesAccepted===true,"DOCUMENT_SIZE_INVALID","Mindestens eine Datei überschreitet die Portallimits.");
  check(input.requiredFieldsComplete===true,"PORTAL_FIELDS_INCOMPLETE","Portalpflichtfelder sind nicht vollständig.");
  check(input.signatureRequirementKnown===true,"SIGNATURE_REQUIREMENT_UNKNOWN","Die Signaturanforderung des konkreten Verfahrens ist noch nicht autoritativ geprüft.");
  if(input.signatureRequirementKnown===true&&input.signatureRequired===true)check(input.signatureSatisfied===true,"SIGNATURE_REQUIRED","Die erforderliche Signatur ist nicht erfüllt.");
  check(input.amendmentsChecked===true,"AMENDMENTS_NOT_CHECKED","Neue Nachrichten oder Nachträge wurden nicht abschließend geprüft.");
  check(input.versionBindingValid===true,"SUBMISSION_VERSION_CHANGED","Die freigegebene Angebotsversion stimmt nicht mehr mit dem aktuellen Stand überein.");
  check(input.portalValidationPassed===true,"PORTAL_VALIDATION_FAILED","Die Portalvalidierung ist nicht bestanden.");
  return {status:blockers.length?"PREFLIGHT_BLOCKED":"PREFLIGHT_PASSED",blockers,checkedAt:new Date().toISOString(),transmitted:false};
}

export function finalSubmissionGate(input){const preflight=evaluateEnterprisePreflight(input),blockers=[...preflight.blockers];if(input.externalActionReleaseValid!==true)blockers.push({code:"EXTERNAL_ACTION_RELEASE_REQUIRED",message:"Die einmalige externe Aktionsfreigabe fehlt."});if(input.finalUserConfirmationValid!==true)blockers.push({code:"FINAL_USER_CONFIRMATION_REQUIRED",message:"Die letzte verbindliche Benutzerbestätigung fehlt."});if(input.alreadyTransmitted===true)blockers.push({code:"IDENTICAL_SUBMISSION_EXISTS",message:"Diese Angebotsversion wurde bereits übermittelt."});return {status:blockers.length?"FINAL_APPROVAL_REQUIRED":"READY_FOR_FINAL_SUBMISSION",blockers,transmitted:false}}

export const safeRetryStep=step=>["ensureAuthenticated","resolveSubmissionTarget","resolveTender","resolveLot","openSubmissionArea","inspectRequiredFields","inspectRequiredDocuments","mapBidPackage","uploadDocuments","fillPriceFields","fillPortalFields","validatePortalState","runPreflight","resumeAfterReauth"].includes(step);
