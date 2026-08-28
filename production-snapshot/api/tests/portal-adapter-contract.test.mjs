import test from "node:test";
import assert from "node:assert/strict";
import {
  GenericHttpConnector,SourceResolverConnector,PORTAL_ADAPTER_OPERATIONS,runPortalReadLifecycle,
  validatePortalAdapterContract,executePortalOperation,classifyPortalMembership
} from "../platform/portal-connector-platform.mjs";
import {PORTAL_ADAPTER_CATALOG,adapterCoverageMatrix} from "../platform/portal-adapter-catalog.mjs";
import {classifyDeutscheEvergabeWorkflow} from "../platform/semantic-browser-auth.mjs";

const profile={adapter_id:"test",adapter_version:"1",canonical_domain:"example.org",authentication_domains:[],download_domains:[],capabilities:[],enabled:true,validation_status:"LIVE_VALIDATED"};

test("every adapter exposes the universal lifecycle",()=>{
  const adapter=new GenericHttpConnector(profile),result=validatePortalAdapterContract(adapter);
  assert.equal(result.valid,true);assert.deepEqual(result.operations,PORTAL_ADAPTER_OPERATIONS);
});

test("participation is locked without exact board approval and release gates",async()=>{
  const adapter=new GenericHttpConnector(profile);
  await assert.rejects(adapter.PARTICIPATE({}),{code:"BOARD_APPROVAL_REQUIRED"});
  await assert.rejects(adapter.PARTICIPATE({approval:{status:"APPROVED",mfaVerified:true,payloadSha256:"a"},payloadSha256:"a",externalActionsEnabled:false,killSwitch:true}),{code:"EXTERNAL_ACTION_LOCKED"});
});

test("read lifecycle stops cleanly when credentials are absent",async()=>{
  const adapter=new GenericHttpConnector(profile);
  adapter.detectLoginForm=async()=>({username:"user",password:"password"});
  const result=await runPortalReadLifecycle(adapter,{url:"https://example.org/tender/1"});
  assert.equal(result.status,"CREDENTIALS_NOT_CONFIGURED");
  assert.deepEqual(result.trace.map(item=>item.operation),["DISCOVER","LOGIN"]);
});

test("public source resolvers do not invent a login requirement",async()=>{
  const adapter=new SourceResolverConnector({...profile,login_strategy:"SOURCE_RESOLVER"});
  adapter.openTenderSearch=async()=>true;adapter.locateTender=async()=>true;adapter.openTenderDetail=async()=>({id:"notice"});adapter.openDocumentArea=async()=>true;adapter.listDocuments=async()=>[];
  const result=await runPortalReadLifecycle(adapter,{url:"https://example.org/tender/1"});
  assert.equal(result.status,"DOCUMENT_TREE_EXPANDED");
});

test("paid membership is evaluated against the tender scope, not an upgrade banner",()=>{
  const base={sessionActive:true,authenticated:true,organizationMatches:true,subscriptionActive:true,subscriptionScopes:["BY"]};
  assert.equal(classifyPortalMembership({...base,targetScope:"BY",upgradeGate:true}),"ACTIVE_SUBSCRIPTION_SCOPE_MATCH");
  assert.equal(classifyPortalMembership({...base,targetScope:"BW",upgradeGate:true}),"ACTIVE_SUBSCRIPTION_SCOPE_MISMATCH");
  assert.equal(classifyPortalMembership({...base,targetScope:null,upgradeGate:true}),"ACTIVE_SUBSCRIPTION");
});

test("catalog never claims untested portals are live validated",()=>{
  assert.ok(PORTAL_ADAPTER_CATALOG.length>=15);
  assert.ok(adapterCoverageMatrix().every(item=>item.validationStatus==="LIVE_VALIDATION_REQUIRED"));
});

test("operation envelope is idempotent, audited and secret-safe",async()=>{
  const adapter=new GenericHttpConnector(profile);adapter.HEALTHCHECK=async()=>({healthy:true,token:"must-not-leak"});let audit;
  const first=await executePortalOperation(adapter,"HEALTHCHECK",{tenderId:"t1",lotKey:"l1",audit:value=>{audit=value}}),second=await executePortalOperation(adapter,"HEALTHCHECK",{tenderId:"t1",lotKey:"l1"});
  assert.equal(first.idempotencyKey,second.idempotencyKey);assert.equal(first.output.token,undefined);assert.equal(audit.idempotencyKey,first.idempotencyKey);
});

test("Deutsche eVergabe recognizes both productive document navigation paths",()=>{
  assert.equal(classifyDeutscheEvergabeWorkflow('<a href="/Workflow/WorkflowOpen/x?A=WF_VUDownload&C=WORKFLOW">Unterlagen</a>'),"WF_VU_DOWNLOAD");
  assert.equal(classifyDeutscheEvergabeWorkflow('<a href="/Workflow/WorkflowOpen/x?A=WF_EVALINK&C=WORKFLOW">Assistent</a>'),"WF_EVA_LINK");
  assert.equal(classifyDeutscheEvergabeWorkflow('<a href="/Workflow/WorkflowOpen/x?A=OTHER">Andere Aktion</a>'),"UNKNOWN");
});
