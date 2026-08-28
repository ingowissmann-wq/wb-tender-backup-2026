import crypto from "node:crypto";

export const GLOBAL_DOCUMENT_REQUEST_POLICY=Object.freeze({
  policyType:"GLOBAL_DOCUMENT_REQUEST_APPROVAL",
  status:"ACTIVE",
  scope:"ALL_CURRENT_AND_FUTURE_TENDERS",
  allowedActions:Object.freeze([
    "DOCUMENT_REQUEST","BIDDER_LIST_REGISTRATION_FOR_DOCUMENT_ACCESS",
    "INTEREST_LIST_REGISTRATION_FOR_DOCUMENT_ACCESS","PROCEDURE_MESSAGE_SUBSCRIPTION"
  ]),
  prohibitedActions:Object.freeze([
    "PAID_PURCHASE","TARIFF_UPGRADE","BID_UPLOAD","PRICE_TRANSMISSION",
    "BID_SUBMISSION","ELECTRONIC_SIGNATURE"
  ])
});

export const DOCUMENT_ACCESS_ACTION_CLASSES=new Set(GLOBAL_DOCUMENT_REQUEST_POLICY.allowedActions);
export const PROHIBITED_EXTERNAL_ACTION_CLASSES=new Set(GLOBAL_DOCUMENT_REQUEST_POLICY.prohibitedActions);

export function documentAccessIdempotencyKey({tenderId,lotKey="",portalAdapterId,externalDocumentRequestType}){
  for(const [key,value] of Object.entries({tenderId,portalAdapterId,externalDocumentRequestType}))if(!value)throw new Error(`${key}_required`);
  return crypto.createHash("sha256").update(JSON.stringify({tenderId:String(tenderId),lotKey:String(lotKey||""),portalAdapterId:String(portalAdapterId),externalDocumentRequestType:String(externalDocumentRequestType)})).digest("hex");
}

export function authorizeDocumentAccessRegistration(input,policy=GLOBAL_DOCUMENT_REQUEST_POLICY){
  const action=String(input.actionType||"");
  const denied=(reason,extra={})=>({authorized:false,httpStatus:423,reason,...extra});
  if(policy?.status!=="ACTIVE"||policy?.policyType!=="GLOBAL_DOCUMENT_REQUEST_APPROVAL")return denied("GLOBAL_POLICY_INACTIVE");
  if(PROHIBITED_EXTERNAL_ACTION_CLASSES.has(action)||!DOCUMENT_ACCESS_ACTION_CLASSES.has(action))return denied("ACTION_NOT_DOCUMENT_ACCESS");
  if(input.costKnown!==true)return denied("COST_MUST_BE_VERIFIED");
  if(Number(input.costAmount||0)>0||input.isPaid===true)return denied("PAID_ACTION_REQUIRES_SEPARATE_APPROVAL",{costAmount:Number(input.costAmount||0),currency:input.currency||null});
  if(input.organizationMatches!==true)return denied("ORGANIZATION_MISMATCH");
  if(input.sessionValid!==true)return denied("SESSION_INVALID");
  if(input.tenderContextMatches!==true||input.lotContextMatches!==true)return denied("TENDER_OR_LOT_CONTEXT_MISMATCH");
  if(input.isBidSubmission===true||input.transmitsPrice===true||input.uploadsBid===true||input.electronicSignature===true)return denied("BID_SUBMISSION_BOUNDARY");
  const idempotencyKey=documentAccessIdempotencyKey(input);
  return {authorized:true,httpStatus:200,policyType:policy.policyType,policyVersion:input.policyVersion||null,idempotencyKey,actionClass:"DOCUMENT_ACCESS_REGISTRATION",bidSubmissionAuthorized:false};
}
