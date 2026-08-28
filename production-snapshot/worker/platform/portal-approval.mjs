import { EXTERNAL_ACTIONS, PORTAL_MODES, sha256 } from "./autopilot-core.mjs";
export function validatePortalAdapter(adapter) {
  if(!PORTAL_MODES.includes(adapter.mode))throw new Error("portal_mode_invalid");
  if(!adapter.killSwitch && adapter.mode==="APPROVED_WRITE")throw new Error("kill_switch_required");
  if(adapter.credentials || adapter.password || adapter.token)throw new Error("inline_secret_forbidden");
  return {...adapter,credentials:undefined};
}
export function secretReference(metadata) {
  if(!metadata.provider||!metadata.reference||!metadata.companyId||!metadata.portalId)throw new Error("secret_reference_incomplete");
  if(/password|token|secret=/i.test(metadata.reference))throw new Error("secret_reference_unsafe");
  return {provider:metadata.provider,reference:metadata.reference,companyId:metadata.companyId,portalId:metadata.portalId,rotatedAt:metadata.rotatedAt||null,revokedAt:metadata.revokedAt||null};
}
export function prepareExternalAction(input) {
  if(!EXTERNAL_ACTIONS.includes(input.actionType))throw new Error("action_invalid");
  const required=["tenderVersion","companyId","portalId","documentHashes","deadlineCheckedAt","requestedBy"];
  if(["PRICE_TRANSMISSION","BID_SUBMISSION"].includes(input.actionType))required.push("calculationVersion");
  const missing=required.filter((key)=>input[key]===undefined||input[key]===null);
  return {status:missing.length?"BLOCKED":"DRAFT",missing,payloadSha256:sha256(input),preview:input,transmissionEnabled:false};
}
export function approveAction(request,events,approval) {
  if(request.status==="BLOCKED")throw new Error("request_blocked");
  if(approval.mfaVerified!==true)throw new Error("mfa_required");
  if(approval.payloadSha256!==request.payloadSha256)throw new Error("payload_changed");
  if(!approval.authorized)throw new Error("permission_required");
  const priorApprovers=new Set(events.filter((x)=>x.decision==="APPROVED").map((x)=>x.actorId));
  if(priorApprovers.has(approval.actorId))throw new Error("duplicate_approver");
  const approvals=priorApprovers.size+1;
  const fourEyes=request.preview.actionType==="BID_SUBMISSION";
  const ingoApproved=events.some((x)=>x.decision==="APPROVED"&&x.isIngo)||approval.isIngo;
  const status=ingoApproved&&(!fourEyes||approvals>=2)?"READY_FOR_FINAL_CONFIRMATION":"AWAITING_APPROVAL";
  return {status,event:{...approval,decision:"APPROVED",occurredAt:new Date().toISOString()},transmissionEnabled:false};
}
export function transmitExternalAction(){throw new Error("external_transmission_disabled_manual_release_required")}

