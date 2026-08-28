import crypto from "node:crypto";
import { assertTransition, submissionHash } from "./submission-framework.mjs";

export const INBOUND_EVENT_TYPES = Object.freeze([
  "RECEIPT", "STATUS", "MESSAGE", "AMENDMENT", "DEADLINE_CHANGE", "AWARD", "REJECTION", "CANCELLATION",
]);
export const TERMINAL_MONITORING_STATES = Object.freeze(["AWARDED", "REJECTED", "CANCELLED", "CLOSED"]);
export const RECONCILIATION_JOB_KINDS = Object.freeze(["READ_ONLY_STATUS_POLL","RECEIPT_RECONCILIATION","MESSAGE_POLL","AMENDMENT_POLL","DEADLINE_POLL","OUTCOME_POLL"]);
export const BINDING_EXECUTION_LOCK = Object.freeze({
  external_submission_enabled: false, transmitted: false, httpStatus: 423,
  code: "EXTERNAL_SUBMISSION_LOCKED",
});

const INBOUND_EVENT_LABELS = Object.freeze({
  RECEIPT:"Empfangsbeleg", STATUS:"Portalstatus", MESSAGE:"Portalnachricht",
  AMENDMENT:"Nachtrag", DEADLINE_CHANGE:"Friständerung", AWARD:"Zuschlag", REJECTION:"Absage", CANCELLATION:"Aufhebung",
});
const plainText = (value, maxLength = 500) => (value != null && typeof value !== "object" ? String(value) : "")
  .replace(/&(?:nbsp|#160);/gi, " ")
  .replace(/&(?:amp|#38);/gi, "&")
  .replace(/&(?:lt|#60);/gi, "<")
  .replace(/&(?:gt|#62);/gi, ">")
  .replace(/&(?:quot|#34);/gi, '"')
  .replace(/&#(?:39|x27);/gi, "'")
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/[\u0000-\u001f\u007f]+/g, " ")
  .replace(/\s+/g, " ").trim().slice(0, maxLength);
const MONITORING_STATUS_LABELS = Object.freeze({
  REVIEW_REQUIRED:"Prüfung erforderlich", RECEIVED:"Empfangen", PUBLISHED:"Veröffentlicht",
  AWARDED:"Zuschlag erteilt", REJECTED:"Abgelehnt", CANCELLED:"Aufgehoben", CLOSED:"Abgeschlossen",
  MONITORING:"Wird überwacht", READ:"Gelesen", UNREAD:"Ungelesen",
});
const readableStatus = value => MONITORING_STATUS_LABELS[String(value).toUpperCase()] || plainText(value, 120).toLocaleLowerCase("de-DE")
  .replaceAll("_", " ").replace(/(^|\s)\p{L}/gu, letter => letter.toLocaleUpperCase("de-DE"));
const firstText = (payload, keys, maxLength) => {
  for (const key of keys) {
    const text = plainText(payload?.[key], maxLength);
    if (text) return text;
  }
  return null;
};

export function monitoringEventPresentation(event = {}) {
  const type = String(event.event_type || event.type || "").toUpperCase(), payload = event.payload || {}, dueAt=firstText(payload, ["deadline","dueAt","effectiveAt"], 80);
  return Object.freeze({
    label: INBOUND_EVENT_LABELS[type] || "Portalereignis",
    title: firstText(payload, ["subject","title","documentName","filename"], 180),
    summary: firstText(payload, ["message","summary","description","note","statusText"], 500),
    statusLabel: firstText(payload, ["statusLabel","decisionLabel","resultLabel"], 120) || (payload.status || payload.decision || payload.result ? readableStatus(payload.status || payload.decision || payload.result) : null),
    reference: firstText(payload, ["receiptNumber","reference","noticeNumber","externalReference"], 160),
    dueAt: dueAt && !Number.isNaN(Date.parse(dueAt)) ? new Date(dueAt).toISOString() : null,
  });
}

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const exactScope = value => ({
  tenderId: String(value?.tenderId || ""), companyId: String(value?.companyId || ""),
  lotKey: String(value?.lotKey || ""), portalId: String(value?.portalId || ""),
  credentialId: value?.credentialId ? String(value.credentialId) : null,
});
const sameExactScope = (left, right) => {
  const a=exactScope(left),b=exactScope(right);
  return a.tenderId===b.tenderId&&a.companyId===b.companyId&&a.lotKey===b.lotKey&&a.portalId===b.portalId&&a.credentialId===b.credentialId;
};
const required = (condition, code) => { if (!condition) { const error = new Error(code); error.code = code; throw error; } };

export function canonicalPackageManifest({ scope, approval, documents, createdAt, schemaVersion = 1 }) {
  const boundScope = exactScope(scope);
  required(boundScope.tenderId && boundScope.companyId && boundScope.portalId, "PACKAGE_SCOPE_INCOMPLETE");
  required(approval?.id && /^[a-f0-9]{64}$/i.test(String(approval.payloadSha256 || "")), "PACKAGE_APPROVAL_BINDING_INVALID");
  const normalizedDocuments = [...(documents || [])].map(document => {
    required(document.id && document.filename && /^[a-f0-9]{64}$/i.test(String(document.sha256 || "")), "PACKAGE_DOCUMENT_INVALID");
    required(Number.isSafeInteger(Number(document.sizeBytes)) && Number(document.sizeBytes) >= 0, "PACKAGE_DOCUMENT_SIZE_INVALID");
    return { id:String(document.id), category:String(document.category || "OTHER"), filename:String(document.filename), mediaType:String(document.mediaType || "application/octet-stream"), sizeBytes:Number(document.sizeBytes), sha256:String(document.sha256).toLowerCase(), version:Number(document.version || 1) };
  }).sort((a, b) => a.category.localeCompare(b.category) || a.filename.localeCompare(b.filename) || a.id.localeCompare(b.id));
  required(normalizedDocuments.length > 0, "PACKAGE_DOCUMENTS_REQUIRED");
  const body = { schemaVersion, scope:boundScope, approval:{ id:String(approval.id), payloadSha256:String(approval.payloadSha256).toLowerCase(), approvedVersion:Number(approval.approvedVersion || 1) }, documents:normalizedDocuments, createdAt:new Date(createdAt || Date.now()).toISOString(), transmitted:false };
  return Object.freeze({ ...body, manifestSha256:submissionHash(body) });
}

export function verifyPackageManifest(manifest) {
  if (!manifest || manifest.transmitted !== false || !Array.isArray(manifest.documents)) return false;
  const { manifestSha256, ...body } = manifest;
  return /^[a-f0-9]{64}$/i.test(String(manifestSha256 || "")) && crypto.timingSafeEqual(Buffer.from(manifestSha256, "hex"), Buffer.from(submissionHash(body), "hex"));
}

export function lockedBindingExecution(action = "SUBMISSION") {
  const error = new Error(`${action.toLowerCase()}_not_released`);
  Object.assign(error, BINDING_EXECUTION_LOCK, { action });
  throw error;
}

export function normalizeInboundEvent(input, { now = () => new Date() } = {}) {
  const type = String(input?.type || "").toUpperCase(), scope = exactScope(input?.scope);
  required(INBOUND_EVENT_TYPES.includes(type), "PORTAL_EVENT_TYPE_INVALID");
  required(scope.tenderId && scope.companyId && scope.portalId, "PORTAL_EVENT_SCOPE_INCOMPLETE");
  required(input?.externalEventId && String(input.externalEventId).length <= 200, "PORTAL_EVENT_ID_INVALID");
  required(input?.observedAt && !Number.isNaN(Date.parse(input.observedAt)), "PORTAL_EVENT_TIME_INVALID");
  const receivedAt = now().toISOString(), payload = stable(input.payload || {}), sourceMode=String(input.sourceMode || "READ_ONLY_POLL");
  required(["READ_ONLY_POLL","VERIFIED_WEBHOOK","MANUAL_VERIFIED_IMPORT","ACCEPTANCE_SANDBOX"].includes(sourceMode),"PORTAL_EVENT_SOURCE_MODE_INVALID");
  const event = { schemaVersion:1, externalEventId:String(input.externalEventId), type, scope, observedAt:new Date(input.observedAt).toISOString(), receivedAt, payload, sourceMode, externalWrite:false, transmitted:false };
  return Object.freeze({ ...event, eventSha256:submissionHash(event), idempotencyKey:submissionHash({ scope, externalEventId:event.externalEventId, type }) });
}

export function verifyWebhookEnvelope({ rawBody, timestamp, signature, secret, now = Date.now(), toleranceMs = 300_000 } = {}) {
  required(Buffer.isBuffer(rawBody) && rawBody.length > 0 && rawBody.length <= 2_000_000, "WEBHOOK_BODY_INVALID");
  required(typeof secret === "string" && secret.length >= 32, "WEBHOOK_SECRET_INVALID");
  const observed=Date.parse(timestamp);required(Number.isFinite(observed) && Math.abs(Number(now)-observed)<=toleranceMs,"WEBHOOK_TIMESTAMP_INVALID");
  const expected=crypto.createHmac("sha256",secret).update(`${new Date(observed).toISOString()}.`).update(rawBody).digest("hex"),supplied=String(signature||"").replace(/^sha256=/i,"");
  required(/^[a-f0-9]{64}$/i.test(supplied) && crypto.timingSafeEqual(Buffer.from(expected,"hex"),Buffer.from(supplied,"hex")),"WEBHOOK_SIGNATURE_INVALID");
  return { verified:true, payloadSha256:crypto.createHash("sha256").update(rawBody).digest("hex"), replayKey:submissionHash({timestamp:new Date(observed).toISOString(),signature:supplied.toLowerCase()}), externalWrite:false, transmitted:false };
}

export function reconcilePortalHistory(events = []) {
  const unique = new Map();
  for (const raw of events) {
    const event = raw.eventSha256 ? raw : normalizeInboundEvent(raw);
    if (!unique.has(event.idempotencyKey)) unique.set(event.idempotencyKey, event);
  }
  const ordered = [...unique.values()].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.idempotencyKey.localeCompare(b.idempotencyKey));
  let status = "MONITORING", receipt = null;
  for (const event of ordered) {
    if (event.type === "RECEIPT") receipt = { eventId:event.externalEventId, sha256:event.eventSha256, verified:event.payload?.verified === true };
    if (event.type === "AWARD") status = "AWARDED";
    else if (event.type === "REJECTION") status = "REJECTED";
    else if (event.type === "CANCELLATION") status = "CANCELLED";
    else if (event.type === "STATUS" && TERMINAL_MONITORING_STATES.includes(event.payload?.status)) status = event.payload.status;
  }
  return { status, terminal:TERMINAL_MONITORING_STATES.includes(status), receipt, events:ordered, duplicates:events.length - ordered.length, transmitted:false };
}

export function retryDecision({ attempt = 0, errorClass = "UNKNOWN", deadline, now = Date.now(), maxAttempts = 6 } = {}) {
  const terminal = new Set(["AUTHORIZATION", "SCOPE_MISMATCH", "PAYLOAD_INVALID", "POLLER_RESULT_INVALID", "POLLER_SOURCE_MODE_INVALID", "CAPABILITY_UNSUPPORTED", "BINDING_ACTION_LOCKED"]);
  if (terminal.has(errorClass) || attempt >= maxAttempts || (deadline && Date.parse(deadline) <= Number(now))) return { action:"DEAD_LETTER", retryAt:null, transmitted:false };
  const delayMs = Math.min(15 * 60_000, 5_000 * (2 ** Math.max(0, attempt))) + Math.floor((attempt * 7919) % 1000);
  return { action:"RETRY", retryAt:new Date(Number(now) + delayMs).toISOString(), delayMs, transmitted:false };
}

export async function runReconciliationJob(job, { poll, now = () => new Date() } = {}) {
  required(RECONCILIATION_JOB_KINDS.includes(job?.jobKind),"RECONCILIATION_JOB_KIND_INVALID");
  required(typeof poll === "function","READ_ONLY_POLLER_REQUIRED");
  try {
    const scope=exactScope(job.scope),observations=await poll(Object.freeze({scope,jobKind:job.jobKind,readOnly:true,externalWrite:false,transmitted:false}));
    required(Array.isArray(observations),"POLLER_RESULT_INVALID");
    const events=observations.map(item=>{
      required(item?.externalWrite!==true&&item?.transmitted!==true,"BINDING_ACTION_LOCKED");
      required(!item?.sourceMode||item.sourceMode==="READ_ONLY_POLL","POLLER_SOURCE_MODE_INVALID");
      required(sameExactScope(scope,item?.scope),"SCOPE_MISMATCH");
      return normalizeInboundEvent({...item,sourceMode:"READ_ONLY_POLL"},{now});
    });
    return {status:"SUCCEEDED",events,retry:null,externalWrite:false,transmitted:false};
  } catch(error) {
    const retry=retryDecision({attempt:Number(job.attempt||0),maxAttempts:Number(job.maxAttempts||6),deadline:job.deadline,errorClass:String(error.code||"UNKNOWN"),now:now().getTime()});
    return {status:retry.action==="RETRY"?"RETRY_WAIT":"DEAD_LETTER",events:[],errorClass:String(error.code||"UNKNOWN"),retry,externalWrite:false,transmitted:false};
  }
}

export function advanceSubmissionState(current, next, event = {}) {
  required(current.transmitted !== true && event.transmitted !== true, "TRANSMISSION_STATE_FORBIDDEN");
  const idempotencyKey = submissionHash({ contextId:current.contextId, from:current.status, to:next, reason:event.reason || "", bindingSha256:current.bindingSha256 });
  if ((current.processedKeys || []).includes(idempotencyKey)) return { ...current, idempotent:true };
  assertTransition(current.status, next);
  return { ...current, status:next, processedKeys:[...(current.processedKeys || []), idempotencyKey], lastEvent:{ ...event, idempotencyKey }, transmitted:false, idempotent:false };
}

export function acceptanceSandboxAdapter() {
  const result = operation => async input => ({ operation, scope:exactScope(input?.scope), environment:"ISOLATED_ACCEPTANCE", realPortalVerified:false, externalWrite:false, transmitted:false });
  return Object.freeze({ adapterKind:"SAFE_ACCEPTANCE_SANDBOX", productionValidated:false, realPortalVerified:false, inspect:result("INSPECT"), preflight:result("PREFLIGHT"), poll:result("POLL"), submit:async()=>lockedBindingExecution("SUBMISSION") });
}
