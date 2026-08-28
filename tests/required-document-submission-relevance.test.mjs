import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerAutopilotRoutes } from "../platform/autopilot-routes.mjs";

const tender="11111111-1111-4111-8111-111111111111",company="22222222-2222-4222-8222-222222222222",required="33333333-3333-4333-8333-333333333333",actor="44444444-4444-4444-8444-444444444444";
const url=`/api/tenders/${tender}/required-documents/${required}/submission-relevance`;
const headers={"x-test-auth":"yes","x-test-permission":"yes","x-csrf-token":"valid"};
const body=decision=>({company,lot:"LOT-0001",decision});
const hooks={
  requirePermission:()=>async(req,reply)=>{if(req.headers["x-test-auth"]!=="yes")return reply.code(401).send({error:"authentication_required"});if(req.headers["x-test-permission"]!=="yes")return reply.code(403).send({error:"forbidden"});req.identity={userId:actor,permissions:["tender.document.analyze"],companyIds:[company],sectorSlugs:[]}},
  csrf:async(req,reply)=>{if(req.headers["x-csrf-token"]!=="valid")return reply.code(403).send({error:"csrf_rejected"})},
  visibleTender:async()=>true,
};

function syntheticDb({status="MISSING",mandatory=true,submissionRelevant=true}={}){
  const evidence={audits:[],rechecks:[],preflightOverrides:[]};
  let requirement={id:required,tender_id:tender,company_id:company,lot_key:"LOT-0001",requirement_code:"SYNTHETIC_REQUIRED",requirement_classification:"BID_TIME_UPLOAD_EVIDENCE",satisfaction_status:status,mandatory,submission_relevant:submissionRelevant,manual_submission_relevance_override:null,approval_relevant:false,portal_upload_category:null};
  const unrelated={...requirement,id:"55555555-5555-4555-8555-555555555555",requirement_code:"OTHER",manual_submission_relevance_override:null};
  const client={release(){},async query(sql,params=[]){const compact=String(sql).replace(/\s+/g," ").trim();
    if(["BEGIN","COMMIT","ROLLBACK"].includes(compact))return {rows:[]};
    if(compact.startsWith("SELECT * FROM tender.required_documents WHERE id="))return {rows:[requirement]};
    if(compact.startsWith("UPDATE tender.required_documents SET manual_submission_relevance_override=")){requirement={...requirement,manual_submission_relevance_override:params[1]};return {rows:[requirement]}}
    if(compact.startsWith("SELECT * FROM tender.required_documents WHERE tender_id="))return {rows:[requirement,unrelated]};
    if(compact.startsWith("SELECT bp.* FROM tender.bid_packages"))return {rows:[]};
    if(compact.startsWith("UPDATE tender.final_preflight_requirements")){evidence.preflightOverrides.push(params[5]);return {rows:[{id:"66666666-6666-4666-8666-666666666666"}]}}
    if(compact.startsWith("UPDATE tender.final_preflight_user_actions"))return {rows:[]};
    if(compact.startsWith("UPDATE tender.final_preflight_contexts"))return {rows:[]};
    if(compact.startsWith("INSERT INTO tender.required_document_rechecks")){evidence.rechecks.push({status:params[2],gate:params[5],details:JSON.parse(params[6])});return {rows:[]}}
    if(compact.startsWith("INSERT INTO tender.audit_events")){evidence.audits.push({action:params[1]||compact.match(/VALUES\([^,]+,'([^']+)'/)?.[1],metadata:JSON.parse(params[3]||params[2])});return {rows:[]}}
    throw new Error(`unexpected synthetic query: ${compact}`);
  }};
  const pool={async connect(){return client},async query(sql){if(String(sql).startsWith("SELECT id,source_lifecycle_status,participation_status"))return {rows:[{id:tender,source_lifecycle_status:"ACTIVE",participation_status:"ELIGIBLE",participation_block_reason:null,notice_classification:"COMPETITION",offer_deadline:"2027-09-07T10:00:00.000Z"}]};if(String(sql).startsWith("SELECT lot_key,lifecycle_status,participation_status"))return {rows:[{lot_key:"LOT-0001",lifecycle_status:"ACTIVE",participation_status:"ELIGIBLE",participation_block_reason:null,offer_deadline:"2027-09-07T10:00:00.000Z"}]};if(String(sql).includes("current_registered_tender_company_portals"))return {rows:[{tender_id:tender,company_id:company,portal_id:"77777777-7777-4777-8777-777777777777"}]};throw new Error(`unexpected pool query: ${sql}`)}};
  return {pool,evidence,getRequirement:()=>requirement};
}
const appFor=pool=>{const app=Fastify({logger:false});registerAutopilotRoutes(app,{pool,...hooks,scanDocument:async()=>({status:"CLEAN"})});return app};

test("Nein creates the truthful manual non-required state, audit, and removes only that blocker",async t=>{
  const db=syntheticDb(),app=appFor(db.pool);t.after(()=>app.close());
  const response=await app.inject({method:"POST",url,headers,payload:body("NOT_REQUIRED")});
  assert.equal(response.statusCode,200,response.body);assert.equal(response.json().bidSubmissionRelevanceState,"MANUALLY_NOT_REQUIRED");assert.equal(response.json().status,"MISSING","missing evidence lifecycle remains truthful");assert.equal(response.json().recheck.complete,false,"unrelated blocker remains");
  assert.equal(db.getRequirement().manual_submission_relevance_override,false);assert.deepEqual(db.evidence.preflightOverrides,[false]);
  const audit=db.evidence.audits.find(x=>x.action==="REQUIRED_DOCUMENT_MANUALLY_EXCLUDED_FROM_SUBMISSION");assert.ok(audit);assert.equal(audit.metadata.previousStatus,"MISSING");assert.equal(audit.metadata.previousClassification,"BID_TIME_UPLOAD_EVIDENCE");assert.equal(audit.metadata.answer,"Nein");assert.equal(audit.metadata.reason,"MANUAL_BID_SUBMISSION_RELEVANCE_OVERRIDE");assert.ok(audit.metadata.decisionAt);
});

test("Ja leaves an active item required and restores an excluded item so its blocker returns",async t=>{
  const db=syntheticDb(),app=appFor(db.pool);t.after(()=>app.close());
  const unchanged=await app.inject({method:"POST",url,headers,payload:body("REQUIRED")});assert.equal(unchanged.statusCode,200);assert.equal(unchanged.json().changed,false);assert.equal(unchanged.json().recheck.complete,false);
  await app.inject({method:"POST",url,headers,payload:body("NOT_REQUIRED")});
  const restored=await app.inject({method:"POST",url,headers,payload:body("REQUIRED")});assert.equal(restored.statusCode,200,restored.body);assert.equal(restored.json().changed,true);assert.equal(restored.json().bidSubmissionRelevanceState,"REQUIRED");assert.equal(restored.json().recheck.complete,false);assert.equal(db.getRequirement().manual_submission_relevance_override,null);
  const audit=db.evidence.audits.find(x=>x.action==="REQUIRED_DOCUMENT_MANUAL_SUBMISSION_EXCLUSION_RESTORED");assert.ok(audit);assert.equal(audit.metadata.answer,"Ja");assert.equal(audit.metadata.previousManualSubmissionRelevanceOverride,false);
});

test("route fails closed for auth, CSRF, wrong scope, malformed decisions, and inactive states",async t=>{
  const db=syntheticDb(),app=appFor(db.pool);t.after(()=>app.close());
  assert.equal((await app.inject({method:"POST",url,payload:body("NOT_REQUIRED")})).statusCode,401);
  assert.equal((await app.inject({method:"POST",url,headers:{...headers,"x-csrf-token":""},payload:body("NOT_REQUIRED")})).statusCode,403);
  assert.equal((await app.inject({method:"POST",url,headers,payload:{...body("NOT_REQUIRED"),company:"88888888-8888-4888-8888-888888888888"}})).statusCode,403);
  assert.equal((await app.inject({method:"POST",url,headers,payload:body("CANCEL")})).statusCode,400);
  const inactive=syntheticDb({status:"NOT_REQUIRED",mandatory:false,submissionRelevant:false}),inactiveApp=appFor(inactive.pool);t.after(()=>inactiveApp.close());assert.equal((await inactiveApp.inject({method:"POST",url,headers,payload:body("REQUIRED")})).statusCode,409);assert.equal(inactive.evidence.audits.length,0);
});
