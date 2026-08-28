import test from "node:test";
import assert from "node:assert/strict";
import {
  effectiveRequiredDocumentStatus,
  isRequiredDocumentBlocker,
  isRequiredDocumentMissing,
  materiallyEditedPdfWorkingCopy,
  requirementLabel,
  submissionDocumentsComplete,
} from "../platform/required-documents.mjs";
import { evaluatePackageReadiness } from "../platform/generic-final-preflight.mjs";

const required = (status) => ({ mandatory:true, submission_relevant:true, satisfaction_status:status });

test("material PDF content transitions missing to review-ready without claiming validation", () => {
  assert.equal(materiallyEditedPdfWorkingCopy({elements:[{type:"text",text:"   "}]}),false);
  assert.equal(materiallyEditedPdfWorkingCopy({elements:[{type:"checkbox",checked:false}]}),false);
  assert.equal(materiallyEditedPdfWorkingCopy({elements:[{type:"text",text:"synthetic answer"}]}),true);
  assert.equal(materiallyEditedPdfWorkingCopy({elements:[{type:"mark",mark:"x"}]}),true);
  assert.equal(materiallyEditedPdfWorkingCopy({sourceFields:[{name:"Synthetic",editable:true,value:""}],fields:{Synthetic:"partial"}}),true);
  assert.equal(effectiveRequiredDocumentStatus({satisfaction_status:"MISSING",working_copy_material:true}),"MANUAL_REVIEW_REQUIRED");
  assert.match(requirementLabel("MANUAL_REVIEW_REQUIRED"),/bereit zur fachlichen Prüfung/);
});

test("review-ready is present but remains a validation blocker; completed passes", () => {
  const review=required("MANUAL_REVIEW_REQUIRED"),complete=required("VALIDATED");
  assert.equal(isRequiredDocumentMissing(review),false);
  assert.equal(isRequiredDocumentBlocker(review),true);
  assert.equal(submissionDocumentsComplete([review]),false);
  assert.equal(isRequiredDocumentBlocker(complete),false);
  assert.equal(submissionDocumentsComplete([complete]),true);
  for(const status of ["MISSING","REJECTED","UPLOADED_PENDING_VALIDATION","MANUAL_REVIEW_REQUIRED"])
    assert.equal(submissionDocumentsComplete([required(status)]),false,status);
});

test("manual submission relevance exclusion is non-blocking without pretending validation and is reversible", () => {
  const missing=required("MISSING"),excluded={...missing,manual_submission_relevance_override:false};
  assert.equal(isRequiredDocumentMissing(excluded),false);
  assert.equal(isRequiredDocumentBlocker(excluded),false);
  assert.equal(submissionDocumentsComplete([excluded]),true);
  assert.equal(excluded.satisfaction_status,"MISSING");
  assert.equal(submissionDocumentsComplete([{...excluded,manual_submission_relevance_override:null}]),false);
  assert.equal(submissionDocumentsComplete([{...excluded,satisfaction_status:"NOT_REQUIRED",manual_submission_relevance_override:null}]),true);
  assert.equal(submissionDocumentsComplete([{...excluded,satisfaction_status:"SUPERSEDED",manual_submission_relevance_override:null}]),true);
});

test("generic readiness distinguishes review from missing and preserves other blockers", () => {
  const base={bindingValid:true,portalSchemaAuthoritative:false,portalMappingComplete:true,bidPackage:"synthetic",activeCompanyProfile:true,approvalValid:true,submissionContextValid:true};
  const review=evaluatePackageReadiness({...base,requirements:[{mandatory:true,submission_relevant:true,status:"MANUAL_REVIEW_REQUIRED",requirement_kind:"REQUIRED_DOCUMENT",human_action_required:false}]});
  assert.equal(review.status,"WAITING_FOR_USER_INPUT");
  assert.equal(review.requiredDocumentsComplete,false);
  const completed=evaluatePackageReadiness({...base,requirements:[{mandatory:true,submission_relevant:true,status:"VALIDATED",requirement_kind:"REQUIRED_DOCUMENT",human_action_required:false}]});
  assert.equal(completed.status,"PREFLIGHT_READY");
  assert.equal(completed.requiredDocumentsComplete,true);
  const legal=evaluatePackageReadiness({...base,requirements:[{mandatory:true,submission_relevant:true,status:"USER_CONFIRMATION_REQUIRED",requirement_kind:"SIGNATURE",human_action_required:true,legal_confirmation_required:true}]});
  assert.equal(legal.status,"WAITING_FOR_USER_INPUT");
});
