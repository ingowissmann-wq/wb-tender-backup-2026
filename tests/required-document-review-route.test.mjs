import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import Fastify from "fastify";
import { registerAutopilotRoutes } from "../platform/autopilot-routes.mjs";

const tender="11111111-1111-4111-8111-111111111111",company="22222222-2222-4222-8222-222222222222",required="33333333-3333-4333-8333-333333333333",actor="44444444-4444-4444-8444-444444444444",workingId="55555555-5555-4555-8555-555555555555",sourceId="66666666-6666-4666-8666-666666666666",uploadId="77777777-7777-4777-8777-777777777777",workingSha="a".repeat(64),sourceSha="b".repeat(64);
const internalUrl=`/api/tenders/${tender}/required-documents/${required}/review`,publicUrl=`/api/tender/tenders/${tender}/required-documents/${required}/review`;
const payload=(version=2)=>({company,lot:"LOT-0001",decision:"VALIDATED",reason:"Synthetic human review note",target:{type:"WORKING_COPY",id:workingId,version,sha256:workingSha,sourceDocumentId:sourceId,sourceSha256:sourceSha}});

const authHooks={
  requirePermission:()=>async(req,reply)=>{if(req.headers["x-test-auth"]!=="yes")return reply.code(401).send({error:"authentication_required"});if(req.headers["x-test-permission"]!=="yes")return reply.code(403).send({error:"permission_forbidden"});req.identity={userId:actor,permissions:["tender.document.analyze"],companyIds:[company],sectorSlugs:[]}},
  csrf:async(req,reply)=>{if(req.headers["x-csrf-token"]!=="valid")return reply.code(403).send({error:"csrf_rejected"})},
  visibleTender:async()=>true,
};
const headers={"x-test-auth":"yes","x-test-permission":"yes","x-csrf-token":"valid"};

function syntheticDb({workingVersion=2}={}){
  const evidence={audit:[],preflightStatuses:[],statusUpdates:[],insertedUploads:0,rechecks:[]};
  const requirement={id:required,tender_id:tender,company_id:company,lot_key:"LOT-0001",requirement_code:"SYNTHETIC_REQUIRED",source_document_id:sourceId,current_upload_id:null,satisfaction_status:"MISSING",mandatory:true,submission_relevant:true,approval_relevant:false,portal_upload_category:null};
  const working={id:workingId,required_document_id:required,tender_id:tender,company_id:company,lot_key:"LOT-0001",source_document_id:sourceId,source_sha256:sourceSha,version:workingVersion,filename:"synthetic-working.pdf",media_type:"application/pdf",content:Buffer.from("synthetic material pdf"),sha256:workingSha,overlay_data:[{type:"mark",mark:"x"}],editor_provenance:{kind:"REQUIRED_SOURCE_PDF_OVERLAY"},prepared_by:actor,is_current:true};
  let updated={...requirement};
  const client={release(){},async query(sql,params=[]){const compact=String(sql).replace(/\s+/g," ").trim();
    if(["BEGIN","COMMIT","ROLLBACK"].includes(compact))return {rows:[]};
    if(compact.startsWith("SELECT * FROM tender.required_documents WHERE id="))return {rows:[requirement]};
    if(compact.startsWith("SELECT * FROM tender.required_document_uploads WHERE required_document_id="))return {rows:[]};
    if(compact.startsWith("SELECT * FROM tender.required_document_working_copies WHERE id="))return {rows:[working]};
    if(compact.startsWith("SELECT id,payload_sha256 FROM tender.enrichment_documents"))return {rows:[{id:sourceId,payload_sha256:sourceSha}]};
    if(compact.startsWith("SELECT coalesce(max(version),0)+1 version FROM tender.required_document_uploads"))return {rows:[{version:1}]};
    if(compact.startsWith("INSERT INTO tender.required_document_uploads")){evidence.insertedUploads++;return {rows:[{id:uploadId,required_document_id:required,version:1,sha256:workingSha,source_type:"REQUIRED_PDF_WORKING_COPY",source_working_copy_id:workingId,validation_status:"VALIDATED"}]}}
    if(compact.startsWith("UPDATE tender.required_documents SET current_upload_id=")){updated={...requirement,current_upload_id:uploadId,satisfaction_status:params[2]};evidence.statusUpdates.push(params[2]);return {rows:[updated]}}
    if(compact.startsWith("INSERT INTO tender.audit_events")){const literal=compact.match(/VALUES\(\$1,'([^']+)'/);evidence.audit.push({action:literal?.[1]||params[1],metadata:JSON.parse(literal?params[2]:params[3])});return {rows:[]}}
    if(compact.startsWith("SELECT * FROM tender.required_documents WHERE tender_id="))return {rows:[updated,{...updated,id:"88888888-8888-4888-8888-888888888888",satisfaction_status:"MISSING"}]};
    if(compact.startsWith("SELECT bp.* FROM tender.bid_packages"))return {rows:[]};
    if(compact.startsWith("UPDATE tender.final_preflight_requirements")){evidence.preflightStatuses.push(params[4]);return {rows:[{id:"99999999-9999-4999-8999-999999999999"}]}}
    if(compact.startsWith("UPDATE tender.final_preflight_user_actions"))return {rows:[]};
    if(compact.startsWith("UPDATE tender.final_preflight_contexts"))return {rows:[]};
    if(compact.startsWith("INSERT INTO tender.required_document_rechecks")){evidence.rechecks.push({status:params[2],gate:params[5]});return {rows:[]}}
    throw new Error(`unexpected synthetic client query: ${compact}`);
  }};
  const pool={async connect(){return client},async query(sql){if(String(sql).startsWith("SELECT id,source_lifecycle_status,participation_status"))return {rows:[{id:tender,source_lifecycle_status:"ACTIVE",participation_status:"ELIGIBLE",participation_block_reason:null,notice_classification:"COMPETITION",offer_deadline:"2027-09-07T10:00:00.000Z"}]};if(String(sql).startsWith("SELECT lot_key,lifecycle_status,participation_status"))return {rows:[{lot_key:"LOT-0001",lifecycle_status:"ACTIVE",participation_status:"ELIGIBLE",participation_block_reason:null,offer_deadline:"2027-09-07T10:00:00.000Z"}]};if(String(sql).includes("current_registered_tender_company_portals"))return {rows:[{tender_id:tender,company_id:company,portal_id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",credential_id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}]};throw new Error(`unexpected synthetic pool query: ${sql}`)}};
  return {pool,evidence};
}

function buildApp(pool){const app=Fastify({logger:false});registerAutopilotRoutes(app,{pool,...authHooks,scanDocument:async()=>({status:"CLEAN",engine:"synthetic"})});return app}

test("browser base path strips once to the POST review route and enforces auth plus CSRF",async t=>{
  const {pool}=syntheticDb(),app=buildApp(pool);await app.listen({host:"127.0.0.1",port:0});t.after(()=>app.close());
  const proxy=createServer(async(req,res)=>{if(!req.url.startsWith("/api/tender/")){res.statusCode=404;return res.end()}const chunks=[];for await(const chunk of req)chunks.push(chunk);const upstream=await fetch(`http://127.0.0.1:${app.server.address().port}/api/${req.url.slice("/api/tender/".length)}`,{method:req.method,headers:{"content-type":req.headers["content-type"]||"application/json","x-test-auth":req.headers["x-test-auth"]||"","x-test-permission":req.headers["x-test-permission"]||"","x-csrf-token":req.headers["x-csrf-token"]||""},body:["GET","HEAD"].includes(req.method)?undefined:Buffer.concat(chunks)});res.statusCode=upstream.status;res.setHeader("content-type",upstream.headers.get("content-type")||"application/json");res.end(Buffer.from(await upstream.arrayBuffer()))});
  await new Promise(resolve=>proxy.listen(0,"127.0.0.1",resolve));t.after(()=>proxy.close());const origin=`http://127.0.0.1:${proxy.address().port}`;
  assert.equal((await fetch(origin+publicUrl,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload())})).status,401);
  assert.equal((await fetch(origin+publicUrl,{method:"POST",headers:{...headers,"x-csrf-token":""},body:JSON.stringify(payload())})).status,403);
  assert.equal((await fetch(origin+publicUrl,{method:"GET",headers})).status,404);
});

test("explicit synthetic confirmation binds material working-copy v2, audits it and clears only its preflight blocker",async t=>{
  const {pool,evidence}=syntheticDb(),app=buildApp(pool);t.after(()=>app.close());const response=await app.inject({method:"POST",url:internalUrl,headers,payload:payload()});
  assert.equal(response.statusCode,200,response.body);assert.equal(response.json().status,"VALIDATED");assert.equal(response.json().reviewTarget.workingCopyId,workingId);assert.equal(response.json().recheck.complete,false,"the unrelated real blocker remains");assert.equal(response.json().recheck.gateStatus,"BLOCKED_REQUIRED_DOCUMENTS");
  assert.equal(evidence.insertedUploads,1);assert.deepEqual(evidence.statusUpdates,["VALIDATED"]);assert.deepEqual(evidence.preflightStatuses,["VALIDATED"]);assert.deepEqual(evidence.rechecks,[{status:"VALIDATED",gate:"BLOCKED_REQUIRED_DOCUMENTS"}]);
  const confirmation=evidence.audit.find(item=>item.action==="REQUIRED_DOCUMENT_CONFIRMED");assert.ok(confirmation);assert.equal(confirmation.metadata.reason,payload().reason);assert.equal(confirmation.metadata.workingCopyVersion,2);assert.equal(confirmation.metadata.workingCopySha256,workingSha);assert.equal(confirmation.metadata.sourceSha256,sourceSha);assert.equal(confirmation.metadata.explicitHumanConfirmation,true);assert.equal(confirmation.metadata.transmitted,false);
});

test("review fails closed for wrong scope, version and incomplete target body",async t=>{
  const {pool,evidence}=syntheticDb(),app=buildApp(pool);t.after(()=>app.close());
  const wrongScope=await app.inject({method:"POST",url:internalUrl,headers,payload:{...payload(),company:"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}});assert.equal(wrongScope.statusCode,403);
  const wrongVersion=await app.inject({method:"POST",url:internalUrl,headers,payload:payload(1)});assert.equal(wrongVersion.statusCode,409);assert.equal(wrongVersion.json().error,"required_document_review_target_changed");
  const wrongBody=await app.inject({method:"POST",url:internalUrl,headers,payload:{company,lot:"LOT-0001",decision:"VALIDATED",reason:"Synthetic human review note"}});assert.equal(wrongBody.statusCode,400);assert.equal(wrongBody.json().error,"required_document_review_contract_invalid");assert.equal(evidence.insertedUploads,0);assert.deepEqual(evidence.statusUpdates,[]);
});
