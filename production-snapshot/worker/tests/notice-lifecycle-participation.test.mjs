import assert from "node:assert/strict";
import test from "node:test";
import { classifyAndResolveNotice, classifyNotice, noticeRelationships, resolveNoticeLifecycle } from "../platform/notice-lifecycle.mjs";
import { buildParticipationReadiness } from "../platform/participation-readiness.mjs";
import { normalizeDoeRelease, normalizeTedNotice } from "../platform/source-ingestion.mjs";
import { readFileSync } from "node:fs";

const now=new Date("2026-08-20T12:00:00Z");

test("TED 574224-2026 is a result and contract duration is never a tender deadline",()=>{
  const notice=normalizeTedNotice({"publication-number":"574224-2026","publication-date":"2026-08-19","notice-title":{deu:"Wach- und Sicherheitsdienstleistungen 2026–2036"},"buyer-name":{deu:["Bezirk Oberfranken"]},"notice-type":"can-standard","notice-subtype":"29","procedure-identifier":"f020869e-5eed-4c0f-84c7-f095dc115b25","previous-notice-id-proc":["377489-2026"],links:{xml:{MUL:"https://ted.europa.eu/en/notice/574224-2026/xml"}}},now.toISOString());
  assert.equal(notice.noticeClassification,"RESULT");
  assert.equal(notice.sourceLifecycleStatus,"CLOSED");
  assert.equal(notice.participationStatus,"NOT_ELIGIBLE");
  assert.equal(notice.offerDeadline,null);
  assert.deepEqual(notice.previousNoticeIds,["377489-2026"]);
});

test("the original competition is active only while its explicit tender deadline is future",()=>{
  const open=classifyAndResolveNotice({sourceCode:"TED",noticeType:"cn-standard",offerDeadline:"2026-09-10T10:00:00Z",now});
  const expired=classifyAndResolveNotice({sourceCode:"TED",noticeType:"cn-standard",offerDeadline:"2026-07-08T10:00:00Z",now});
  assert.deepEqual([open.classification,open.sourceLifecycleStatus,open.participationStatus],["COMPETITION","ACTIVE","ELIGIBLE"]);
  assert.deepEqual([expired.sourceLifecycleStatus,expired.participationStatus],["EXPIRED","NOT_ELIGIBLE"]);
});

test("a result, cancellation, modification or newer terminal notice cannot become active through a future date",()=>{
  for(const classification of ["RESULT","CONTRACT_MODIFICATION","VOLUNTARY_EX_ANTE"]){
    const result=resolveNoticeLifecycle({classification,offerDeadline:"2036-09-30T12:00:00Z",now});
    assert.equal(result.sourceLifecycleStatus,"CLOSED");assert.equal(result.participationStatus,"NOT_ELIGIBLE");
  }
  assert.equal(resolveNoticeLifecycle({classification:"CANCELLATION",offerDeadline:"2036-09-30T12:00:00Z",now}).sourceLifecycleStatus,"WITHDRAWN");
  assert.equal(resolveNoticeLifecycle({classification:"COMPETITION",offerDeadline:"2026-09-30T12:00:00Z",newerTerminalNotice:{id:"result"},now}).sourceLifecycleStatus,"CLOSED");
});

test("unknown, prior information and competition without a deadline fail closed for participation",()=>{
  for(const input of [{classification:"UNKNOWN"},{classification:"PRIOR_INFORMATION"},{classification:"COMPETITION"}]){
    const result=resolveNoticeLifecycle({...input,now});assert.equal(result.sourceLifecycleStatus,"REVIEW_REQUIRED");assert.equal(result.participationStatus,"REVIEW_REQUIRED");
  }
});

test("DOE tags distinguish competition, award, amendment, planning and cancellation",()=>{
  const expected=new Map([["tender","COMPETITION"],["award","RESULT"],["tenderAmendment","CORRIGENDUM"],["planning","PRIOR_INFORMATION"],["tenderCancellation","CANCELLATION"]]);
  for(const [tag,classification] of expected)assert.equal(classifyNotice({sourceCode:"DOE",tags:[tag]}).classification,classification);
});

test("a DOE award without a tender deadline is closed and never participation eligible",()=>{
  const row=normalizeDoeRelease({id:"award-1",uri:"https://oeffentlichevergabe.de/api/notices/award-1?format=ocds",date:now.toISOString(),tag:["award"],buyer:{name:"Buyer"},tender:{title:"Ergebnis",items:[],lots:[]}});
  assert.equal(row.noticeClassification,"RESULT");assert.equal(row.sourceLifecycleStatus,"CLOSED");assert.equal(row.participationStatus,"NOT_ELIGIBLE");
});

test("authoritative previous notice identifiers create auditable relations",()=>{
  assert.deepEqual(noticeRelationships({sourceCode:"TED",externalId:"574224-2026",procedureIdentifier:"procedure",previousNoticeIds:["377489-2026","377489-2026","574224-2026"]}),[{sourceCode:"TED",sourceExternalId:"574224-2026",relatedExternalId:"377489-2026",procedureIdentifier:"procedure",relationshipType:"PREVIOUS_NOTICE"}]);
});

test("participation wizard exposes all fourteen steps and keeps external submission locked",()=>{
  const result=buildParticipationReadiness({tender:{id:"tender",source_code:"TED",source_lifecycle_status:"ACTIVE",participation_status:"ELIGIBLE",notice_classification:"COMPETITION",offer_deadline:"2026-09-10T10:00:00Z"},lotLifecycle:{lot_key:"LOT-1",lifecycle_status:"ACTIVE",participation_status:"ELIGIBLE",offer_deadline:"2026-09-10T10:00:00Z",deadline_quality:"EXACT"},company:{id:"company",name:"WB-Cleaning"},serviceLine:"cleaning",region:{status:"CORE_REGION",version:3},lotKey:"LOT-1"},now.toISOString());
  assert.equal(result.steps.length,14);assert.equal(result.steps[0].status,"COMPLETE");assert.equal(result.steps[3].status,"BLOCKED");assert.equal(result.steps[13].evidence.httpStatus,423);assert.equal(result.externalSubmission,false);
});

test("result notice wizard has no participation path",()=>{
  const result=buildParticipationReadiness({tender:{id:"result",source_code:"TED",source_lifecycle_status:"CLOSED",participation_status:"NOT_ELIGIBLE",notice_classification:"RESULT",participation_block_reason:"NOTICE_RESULT"},company:{id:"company",name:"WB-Security"},serviceLine:"security"},now.toISOString());
  assert.equal(result.eligible,false);assert.equal(result.steps[0].status,"BLOCKED");assert.match(result.steps[0].result,/NOTICE_RESULT/);
});

test("review-required notice never exposes an eligible participation wizard",()=>{
  const result=buildParticipationReadiness({tender:{id:"review",source_code:"DOE",source_lifecycle_status:"REVIEW_REQUIRED",participation_status:"REVIEW_REQUIRED",notice_classification:"COMPETITION",participation_block_reason:"FUTURE_TENDER_DEADLINE_REQUIRED"},company:{id:"company",name:"WB-Facilitys"},serviceLine:"facility-management"},now.toISOString());
  assert.equal(result.eligible,false);assert.equal(result.steps[0].status,"BLOCKED");assert.match(result.steps[0].result,/FUTURE_TENDER_DEADLINE_REQUIRED/);
});

test("migration 104 is additive and preserves all business records",()=>{
  const sql=readFileSync(new URL("../migrations/104_notice_lifecycle_participation.sql",import.meta.url),"utf8");
  assert.match(sql,/BEGIN;[\s\S]*COMMIT;/);assert.match(sql,/ADD COLUMN IF NOT EXISTS notice_classification/);assert.match(sql,/REFERENCES tender\.tenders\(id\)/);
  assert.doesNotMatch(sql,/\b(?:DELETE|TRUNCATE)\b/i);assert.doesNotMatch(sql,/ON DELETE CASCADE/i);assert.doesNotMatch(sql,/UPDATE tender\./i);
});

test("migration 104 has an explicit non-cascade down migration",()=>{
  const sql=readFileSync(new URL("../migrations/104_notice_lifecycle_participation.down.sql",import.meta.url),"utf8");
  assert.match(sql,/correction run not rolled back/);assert.match(sql,/DROP VIEW IF EXISTS tender\.current_participation_eligible_lots/);
  assert.match(sql,/DROP TABLE tender\.notice_lifecycle_transitions/);assert.doesNotMatch(sql,/\bCASCADE\b/i);
});

test("correction plan is hash-bound, fully typed and reports initial classification writes",()=>{
  const source=readFileSync(new URL("../scripts/reclassify-notice-lifecycle.mjs",import.meta.url),"utf8");
  assert.match(source,/EXPECTED_PLAN_SHA256 !== plan\.planSha256/);
  assert.match(source,/NOTICE_LIFECYCLE_AS_OF is required for a deterministic apply plan/);
  assert.match(source,/buildLifecyclePlan/);
  assert.match(source,/jsonb_build_object\('planSha256'/);
  assert.match(source,/fromClassification !== row\.classification/);
  assert.match(source,/fromParticipation !== row\.toParticipation/);
  assert.match(source,/physicalDeletes: 0/);
  assert.match(source,/notice_lifecycle_correction_rows/);
  assert.match(source,/physicallyChangedRows/);
  assert.match(source,/canonicalPlanSchema/);
});

test("correction rollback is run-bound, conflict-checked and never performs a database restore",()=>{
  const source=readFileSync(new URL("../scripts/rollback-notice-lifecycle-correction.mjs",import.meta.url),"utf8");
  assert.match(source,/NOTICE_LIFECYCLE_CORRECTION_RUN_ID/);assert.match(source,/EXPECTED_PLAN_SHA256/);
  assert.match(source,/conflicts/);assert.match(source,/DELETE FROM tender\.notice_lifecycle_transitions WHERE correction_run_id/);
  assert.doesNotMatch(source,/pg_restore|DROP DATABASE|TRUNCATE/i);
});

test("active inboxes, regions and session fanout use the same fail-closed participation scope",()=>{
  for(const file of ["../platform/inbox-pipeline.mjs","../platform/region-recalculation-worker.mjs","../platform/verified-session-fanout.mjs"]){const source=readFileSync(new URL(file,import.meta.url),"utf8");assert.match(source,/PARTIALLY_ELIGIBLE/);assert.match(source,/current_participation_eligible_lots/)}
});

test("API and worker reject processing for a non-participation notice before external work",()=>{
  const routes=readFileSync(new URL("../platform/autopilot-routes.mjs",import.meta.url),"utf8"),worker=readFileSync(new URL("../platform/autopilot-pipeline-worker.mjs",import.meta.url),"utf8");
  assert.match(routes,/requireParticipationEligible/);assert.match(routes,/participation-readiness/);assert.match(worker,/PARTICIPATION_BLOCKED/);assert.match(worker,/TENDER_NOT_PARTICIPATION_ELIGIBLE/);
});

test("participation readiness loads and requires the exact selected lot lifecycle",()=>{
  const routes=readFileSync(new URL("../platform/autopilot-routes.mjs",import.meta.url),"utf8"),readiness=readFileSync(new URL("../platform/participation-readiness.mjs",import.meta.url),"utf8");
  assert.match(routes,/SELECT lot_key,lifecycle_status,participation_status,participation_block_reason,offer_deadline,deadline_quality FROM tender\.tender_lot_lifecycles WHERE tender_id=\$1 AND lot_key=\$2 AND is_current/);
  assert.match(routes,/lotLifecycle:lotLifecycleResult\.rows\[0\]\|\|null/);
  assert.match(readiness,/lot\?\.deadline_quality === "EXACT"/);
});

test("offer-document listing scopes company through its calculation and selected lot",()=>{
  const routes=readFileSync(new URL("../platform/autopilot-routes.mjs",import.meta.url),"utf8");
  assert.match(routes,/generated_documents generated JOIN tender\.calculations calculation ON calculation\.id=generated\.calculation_id/);
  assert.match(routes,/calculation\.company_id=\$2 AND calculation\.lot_key=\$3/);
  assert.doesNotMatch(routes,/generated_documents WHERE tender_id=\$1 AND company_id=\$2/);
});

test("UI exposes one central participation action, a completed view and separate platform/portal labels",()=>{
  const navigation=readFileSync(new URL("../platform/assets/autopilot-navigation.js",import.meta.url),"utf8"),inbox=readFileSync(new URL("../platform/assets/inbox-regions.js",import.meta.url),"utf8");
  assert.match(navigation,/Teilnahme vorbereiten/);assert.match(navigation,/Abgeschlossene Verfahren/);assert.match(navigation,/Externe Abgabe bleibt HTTP 423 gesperrt/);
  assert.match(inbox,/Veröffentlichungsplattform/);assert.match(inbox,/Teilnahme-\/Abgabeportal/);assert.match(inbox,/route\("participation"\)/);
});
