import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import Fastify from "fastify";
import {registerAutopilotRoutes} from "../platform/autopilot-routes.mjs";

const routes=readFileSync(new URL("../platform/autopilot-routes.mjs",import.meta.url),"utf8");
const managementRoute=routes.slice(routes.indexOf('"/api/management-inbox"'),routes.indexOf('"/api/management-inbox/region-detail'));
const detailRoute=routes.slice(routes.indexOf('"/api/management-inbox/region-detail'),routes.indexOf("const validateActionContext"));
const ui=readFileSync(new URL("../platform/assets/inbox-regions.js",import.meta.url),"utf8");
const pipeline=readFileSync(new URL("../platform/inbox-pipeline.mjs",import.meta.url),"utf8");
const configuration=readFileSync(new URL("../platform/configuration-admin.mjs",import.meta.url),"utf8");
const worker=readFileSync(new URL("../platform/region-recalculation-worker.mjs",import.meta.url),"utf8");
const migration=readFileSync(new URL("../migrations/097_management_inbox_pagination.sql",import.meta.url),"utf8");

const tenant="11111111-1111-4111-8111-111111111111",securityCompany="22222222-2222-4222-8222-222222222222",cleaningCompany="33333333-3333-4333-8333-333333333333",securityProfile="44444444-4444-4444-8444-444444444444",cleaningProfile="55555555-5555-4555-8555-555555555555",tender="66666666-6666-4666-8666-666666666666";
const companies=[
  {tenant_id:tenant,company_id:securityCompany,legal_name:"WB-Security GmbH",sector_slug:"security",canonical_service:"security",service_line:"security",profile_id:securityProfile,active_region_version_id:"77777777-7777-4777-8777-777777777777"},
  {tenant_id:tenant,company_id:cleaningCompany,legal_name:"WB-Cleaning GmbH",sector_slug:"cleaning",canonical_service:"cleaning",service_line:"cleaning",profile_id:cleaningProfile,active_region_version_id:"88888888-8888-4888-8888-888888888888"},
];

function fakePool({empty=false,filteredEmpty=false,delay=0,queryError=null}={}){
  const calls=[];
  return {calls,async query(sql,params=[]){
    const compact=String(sql).replace(/\s+/g," ").trim();calls.push({sql:compact,params});
    if(compact.startsWith("SELECT company.company_id,company.legal_name"))return {rows:companies};
    if(compact.startsWith("WITH active_scope AS")){
      if(queryError)throw queryError;
      if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
      if(empty)return {rows:[]};
      if(filteredEmpty)return {rows:[{tender_id:null,filtered_total:0,core_count:5,strategic_count:4,outside_count:3,excluded_count:2,unresolved_count:109,conflict_count:0,multi_review_count:0}]};
      const company=params[1]||securityCompany,scope=companies.find(item=>item.company_id===company)||companies[0];
      return {rows:[{tender_id:tender,company_id:scope.company_id,configuration_tenant_id:tenant,canonical_service:scope.canonical_service,active_profile_id:scope.profile_id,active_region_version_id:scope.active_region_version_id,active_configuration_version_id:"99999999-9999-4999-8999-999999999999",title:"Produktive Testausschreibung",publication_date:"2026-08-19",tender_created_at:"2026-08-19",buyer:"Stadt",regions:[],cpv_codes:[],detected_nuts:[],detected_states:[],classification:"REGION_UNRESOLVED",relevance_status:"RELEVANT",service_line:scope.service_line,lot_key:null,filtered_total:123,core_count:5,strategic_count:4,outside_count:3,excluded_count:2,unresolved_count:109,conflict_count:0,multi_review_count:0}]};
    }
    if(compact.startsWith("SELECT job.company_id,job.canonical_service"))return {rows:[]};
    if(compact.startsWith("SELECT tender_id,lot_key,status,last_checked_at"))return {rows:[]};
    if(compact.startsWith("SELECT t.id tender_id,t.external_id,t.notice_classification"))return {rows:[{tender_id:tender,external_id:"1",notice_classification:"COMPETITION",source_lifecycle_status:"ACTIVE",participation_status:"ELIGIBLE",participation_block_reason:null,notice_type_code:"cn-standard",notice_subtype:null,procedure_identifier:"PROC-1"}]};
    if(compact.startsWith("SELECT t.id tender_id,t.source_code"))return {rows:[{tender_id:tender,source_code:"TED",source_url:"https://ted.europa.eu/de/notice/-/detail/1",external_id:"1",normalized_data:{raw:{links:{html:{DEU:"https://ted.europa.eu/de/notice/-/detail/1"}}}},enrichment_id:null,enrichment_documents:[]}]};
    if(compact.startsWith("SELECT display_name,canonical_domain")||compact.startsWith("SELECT id,display_name,canonical_domain"))return {rows:[]};
    if(compact.startsWith("SELECT DISTINCT ON(e.tender_id) e.tender_id"))return {rows:[]};
    if(compact.startsWith("SELECT DISTINCT ON(event.tender_id,event.metadata->>'companyId')"))return {rows:[]};
    throw new Error(`unexpected query: ${compact.slice(0,180)}`);
  }};
}

function appFor(pool){
  const app=Fastify({logger:false});
  registerAutopilotRoutes(app,{pool,requirePermission:()=>async req=>{req.identity={userId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",permissions:["tender.admin"],companyIds:companies.map(item=>item.company_id),sectorSlugs:[]}},csrf:async()=>{},visibleTender:async()=>true});
  return app;
}

test("management inbox performs current-row filtering before DB pagination and expensive detail joins",()=>{
  assert.doesNotMatch(routes,/FROM tender\.current_service_relevance r JOIN active_scope/);
  assert.match(routes,/current_relevance AS MATERIALIZED/);
  assert.match(routes,/SELECT DISTINCT ON\(evaluation\.tender_id,evaluation\.company_id,evaluation\.lot_key\)/);
  assert.match(routes,/current_primary_context AS MATERIALIZED/);
  assert.match(managementRoute,/primary_relevance\.primary_company=true/);
  assert.match(managementRoute,/WHERE NOT \$7::boolean AND \$3::text\[\] IS NOT NULL AND r\.relevance_status=ANY\(\$3\)/);
  assert.match(managementRoute,/evaluation\.id relevance_id/);
  assert.match(managementRoute,/JOIN tender\.service_relevance_evaluations relevance_detail ON relevance_detail\.id=r\.relevance_id/);
  assert.match(managementRoute,/WHERE \$7::boolean/);
  assert.doesNotMatch(managementRoute,/EXISTS\(SELECT 1 FROM tender\.service_relevance_evaluations primary_relevance/);
  assert.match(routes,/base_candidates AS MATERIALIZED/);
  assert.match(routes,/filtered_candidates AS MATERIALIZED/);
  assert.match(routes,/paged AS MATERIALIZED\([\s\S]*LIMIT \$6 OFFSET \$10/);
  assert.ok(routes.indexOf("paged AS MATERIALIZED")<routes.indexOf("LEFT JOIN paged p ON true"));
  assert.ok(managementRoute.indexOf("LEFT JOIN paged p ON true")<managementRoute.indexOf("current_registered_tender_company_portals x"));
  assert.doesNotMatch(managementRoute,/current_registered_tender_company_portals registered ON registered\.tender_id=r\.tender_id/);
  assert.doesNotMatch(managementRoute,/LIMIT 5000/);
});

test("management inbox uses the last consistent pre-regression region materialization",()=>{
  assert.match(managementRoute,/region\.source_data->>'pipelineVersion'='wb-daily-inbox-pipeline\/1\.0\.0'/);
  assert.doesNotMatch(managementRoute,/region\.source_data->>'pipelineVersion'='wb-daily-inbox-pipeline\/2\.0\.0-structured-regions'/);
  assert.match(detailRoute,/(?:e|region)\.source_data->>'pipelineVersion'='wb-daily-inbox-pipeline\/1\.0\.0'/);
  assert.match(detailRoute,/SELECT count\(\*\) FROM tender\.configuration_scopes candidate WHERE candidate\.company_id=scope\.company_id\)=1/);
});

test("REVIEW_REQUIRED tenders remain visible in both list and detail",()=>{
  assert.match(managementRoute,/t\.source_lifecycle_status='REVIEW_REQUIRED' AND t\.participation_status='REVIEW_REQUIRED'/);
  assert.match(detailRoute,/t\.source_lifecycle_status='REVIEW_REQUIRED' AND t\.participation_status='REVIEW_REQUIRED'/);
});

test("automatic lot selection never binds an enrichment or lifecycle id as a canonical lot",()=>{
  assert.match(detailRoute,/l\.id canonical_lot_id,coalesce\(l\.id,enriched\.id,life\.id\) id/);
  assert.match(detailRoute,/lot\.rows\[0\]\?\.canonical_lot_id/);
  assert.doesNotMatch(detailRoute,/lot\.rows\[0\]\.id,requestedLot/);
});

test("category counters come from the shared base before the selected region filter",()=>{
  assert.ok(managementRoute.indexOf("category_counts AS")>managementRoute.indexOf("base_candidates AS MATERIALIZED"));
  assert.ok(managementRoute.indexOf("filtered_candidates AS MATERIALIZED")>managementRoute.indexOf("category_counts AS"));
  assert.match(managementRoute,/FROM category_counts CROSS JOIN filtered_count LEFT JOIN paged p ON true/);
});

test("legacy regions use one canonical company scope and decisions only use region inbox linkage",()=>{
  for(const token of ["scope.tenant_id","scope.canonical_service","scope.profile_id","active_version.id active_configuration_version_id"])assert.ok(managementRoute.includes(token),token);
  assert.match(managementRoute,/unambiguous_scope AS\([\s\S]*GROUP BY company_id HAVING count\(\*\)=1/);
  assert.match(routes,/unambiguous_scope scope[\s\S]*scope\.company_id=region\.company_id/);
  assert.match(managementRoute,/scope\.canonical_service=r\.canonical_service/);
  assert.match(managementRoute,/SELECT x\.\* FROM tender\.management_inbox x WHERE x\.id=p\.region_inbox_id/);
  assert.doesNotMatch(managementRoute,/x\.tenant_id=p\.configuration_tenant_id/);
});

test("all productive service lines remain the closed supported set",()=>{
  for(const service of ["security","cleaning","facility_management","sicherheitstechnik","emergency_services"])assert.ok(routes.includes(`"${service}"`),service);
  assert.match(migration,/canonical_service text NOT NULL CHECK\(canonical_service IN\('security','cleaning','facility_management','sicherheitstechnik','emergency_services'\)\)/);
});

test("API page and pageSize are bounded and passed as LIMIT plus OFFSET",async t=>{
  const pool=fakePool(),app=appFor(pool);t.after(()=>app.close());
  const response=await app.inject({method:"GET",url:`/api/management-inbox?company=${securityCompany}&serviceLine=security&page=2&pageSize=25`});
  assert.equal(response.statusCode,200,response.body);const body=response.json();
  assert.equal(body.page,2);assert.equal(body.pageSize,25);assert.equal(body.total,123);assert.equal(body.items.length,1);assert.equal(body.items[0].company_id,securityCompany);assert.equal(body.items[0].canonical_service,"security");
  const main=pool.calls.find(call=>call.sql.startsWith("WITH active_scope AS"));assert.equal(main.params[1],securityCompany);assert.equal(main.params[3],"security");assert.equal(main.params[5],26);assert.equal(main.params[9],25);
});

test("empty scoped results return an empty list instead of a gateway-style error",async t=>{
  const pool=fakePool({empty:true}),app=appFor(pool);t.after(()=>app.close());
  const response=await app.inject({method:"GET",url:`/api/management-inbox?company=${securityCompany}&serviceLine=security&page=1&pageSize=50`});
  assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json().items,[]);assert.equal(response.json().total,0);assert.equal(response.json().hasMore,false);
});

test("an empty selected category keeps the unfiltered category counters visible",async t=>{
  const pool=fakePool({filteredEmpty:true}),app=appFor(pool);t.after(()=>app.close());
  const response=await app.inject({method:"GET",url:`/api/management-inbox?company=${securityCompany}&serviceLine=security&regionClass=CORE_REGION&page=1&pageSize=50`});
  assert.equal(response.statusCode,200,response.body);const body=response.json();
  assert.deepEqual(body.items,[]);assert.equal(body.total,0);assert.equal(body.counts.CORE_REGION,5);assert.equal(body.counts.REGION_UNRESOLVED,109);
});

test("database timeout returns a bounded retryable API error and never a proxy 504",async t=>{
  const error=Object.assign(new Error("synthetic statement timeout"),{code:"57014"}),pool=fakePool({queryError:error}),app=appFor(pool);t.after(()=>app.close());
  const response=await app.inject({method:"GET",url:`/api/management-inbox?company=${securityCompany}&serviceLine=security`});
  assert.equal(response.statusCode,503);assert.equal(response.headers["retry-after"],"5");assert.equal(response.json().error,"management_inbox_query_timeout");
});

test("unexpected database errors are safe 500 responses without leaking query text",async t=>{
  const pool=fakePool({queryError:Object.assign(new Error("secret SQL detail"),{code:"XX000"})}),app=appFor(pool);t.after(()=>app.close());
  const response=await app.inject({method:"GET",url:`/api/management-inbox?company=${securityCompany}&serviceLine=security`});
  assert.equal(response.statusCode,500);assert.equal(response.json().error,"management_inbox_query_failed");assert.doesNotMatch(response.body,/secret SQL detail/);
});

test("company and service mismatch fails before any inbox query",async t=>{
  const pool=fakePool(),app=appFor(pool);t.after(()=>app.close());
  const response=await app.inject({method:"GET",url:`/api/management-inbox?company=${securityCompany}&serviceLine=cleaning`});
  assert.equal(response.statusCode,422);assert.equal(pool.calls.some(call=>call.sql.startsWith("WITH active_scope AS")),false);
});

test("simultaneous company requests cannot cross-contaminate response scopes",async t=>{
  const pool=fakePool({delay:15}),app=appFor(pool);t.after(()=>app.close());
  const [security,cleaning]=await Promise.all([
    app.inject({method:"GET",url:`/api/management-inbox?company=${securityCompany}&serviceLine=security`}),
    app.inject({method:"GET",url:`/api/management-inbox?company=${cleaningCompany}&serviceLine=cleaning`}),
  ]);
  assert.equal(security.json().items[0].company_id,securityCompany);assert.equal(security.json().items[0].canonical_service,"security");
  assert.equal(cleaning.json().items[0].company_id,cleaningCompany);assert.equal(cleaning.json().items[0].canonical_service,"cleaning");
});

test("browser aborts superseded requests and ignores stale responses during rapid filter changes",()=>{
  assert.match(ui,/inboxRequestController\?\.abort\(\)/);
  assert.match(ui,/requestSequence!==inboxRequestSequence/);
  assert.match(ui,/page=\$\{encodeURIComponent\(state\.page\)\}/);
  assert.match(ui,/state\.page = 1/);
});

test("API and UI expose typed safe link evidence and do not mask missing document work as zero",async t=>{
  const pool=fakePool(),app=appFor(pool);t.after(()=>app.close());
  const response=await app.inject({method:"GET",url:`/api/management-inbox?company=${securityCompany}&serviceLine=security`});
  assert.equal(response.statusCode,200,response.body);
  assert.equal(response.json().items[0].linkEvidence.originalNotice.targetType,"ORIGINAL_NOTICE");
  assert.equal(response.json().items[0].linkEvidence.missingReasons.procurementPortal,"Vergabeportal in der Quelle nicht angegeben");
  assert.match(ui,/evidence\.originalNotice/);
  assert.match(ui,/evidence\.technicalSource/);
  assert.match(ui,/Beim Vergabeportal anmelden/);
  assert.match(ui,/Beim Vergabeportal registrieren/);
  assert.match(ui,/Portalzugang verwalten/);
  assert.doesNotMatch(ui,/DOE_QUELLPAYLOAD|TED_QUELLPAYLOAD|ENRICHMENT_DOCUMENT/);
  assert.match(ui,/target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(ui,/Dokumente gefunden \/ geladen \/ analysiert/);
  assert.match(ui,/Portalzugangsstatus konnte nicht geladen werden/);
  assert.match(ui,/loadError:error\.message/);
});

test("portal-access button is explicitly scoped and its delegated click opens a resilient live dialog",()=>{
  const handler=ui.slice(ui.indexOf('const base = location.port'));
  for(const attribute of ["data-tender","data-company","data-lot"])assert.match(ui,new RegExp(attribute));
  assert.match(ui,/portalManageUrl = \(item, portalId\).*tender=.*lot=.*company=.*portal=/);
  assert.match(ui,/data-portal-navigation/);
  assert.match(ui,/\/admin\/ausschreibungen\/portalzugaenge/);
  assert.match(ui,/data-open-portal-access/);
  assert.match(ui,/event\.preventDefault\(\)/);
  assert.match(handler,/const escapeHtml/);
  assert.doesNotMatch(handler,/\besc\(/);
  assert.match(handler,/dialogFrame\('<p class="status-message" role="status">Portalzugang wird geladen/);
  assert.match(handler,/portal-access\/for-tender\/\$\{encodeURIComponent\(tenderId\)\}/);
  assert.match(handler,/credentials: "same-origin"/);
  assert.match(handler,/401: "Portalzugang konnte nicht geladen werden/);
  assert.match(handler,/403: "Sie besitzen keine Berechtigung/);
  assert.match(handler,/data-retry-portal-access/);
  assert.match(handler,/Loginseite noch nicht verifiziert/);
  assert.match(handler,/Registrierungsseite noch nicht verifiziert/);
  assert.match(handler,/document\.querySelector\("#portal-access-dialog"\)/);
});

test("portal-access dialog renders only masked credential metadata and safe links",()=>{
  const handler=ui.slice(ui.indexOf('const base = location.port'));
  for(const field of ["usernameMasked","internalLabel","contactPerson","registrationStatus","loginStatus","mfaRequired","lastManualCheckAt"])assert.match(handler,new RegExp(field));
  assert.doesNotMatch(handler,/credential\.(?:ciphertext|iv|auth_tag|password|totpSeed|recoveryCodes)/);
  assert.match(handler,/url\.protocol !== "https:"/);
  assert.match(handler,/target="_blank" rel="noopener noreferrer"/);
  assert.match(ui,/portal_navigation_mode \|\| \(portal\?\.portalId/);
  assert.match(ui,/\? "edit" : "search"/);
});

test("region activation queues one idempotent background job and GET never executes the pipeline",()=>{
  assert.match(configuration,/INSERT INTO tender\.region_recalculation_jobs/);
  assert.match(configuration,/ON CONFLICT\(idempotency_key\) DO NOTHING/);
  assert.doesNotMatch(routes,/runInboxPipeline/);
  assert.match(worker,/runInboxPipeline\(pool/);
  assert.match(worker,/FOR UPDATE OF job SKIP LOCKED/);
  assert.match(worker,/INBOX_PIPELINE_LEASE_HELD/);
});

test("background recomputation is scoped, progressive, idempotent and preserves decisions",()=>{
  for(const token of ["scope.companyId","scope.canonicalService","scope.tenantId","scope.profileId"])assert.ok(pipeline.includes(token),token);
  assert.match(pipeline,/ON CONFLICT\(event_fingerprint\) DO NOTHING/);
  assert.match(pipeline,/prior\?\.workflow_status\|\|"NEW"/);
  assert.match(pipeline,/prior\?\.responsible_user_id\|\|null/);
  assert.match(worker,/processed_count=\$2/);
  assert.match(migration,/idempotency_key text NOT NULL UNIQUE/);
});

test("the repair reads the last consistent region materialization and its linked inbox row",()=>{
  assert.match(routes,/region\.source_data->>'pipelineVersion'='wb-daily-inbox-pipeline\/1\.0\.0'/);
  assert.match(routes,/x\.id=p\.region_inbox_id/);
  assert.match(routes,/region_recalculation_status,r\.region_recalculation_processed,r\.region_recalculation_total/);
  assert.match(ui,/letzte vollständig berechnete Inbox-Version/);
});

test("supporting indexes cover current relevance, pagination detail contexts and are rollbackable",()=>{
  for(const index of ["service_relevance_current_filter_idx","management_inbox_active_page_idx","calculations_context_version_idx","approval_requests_context_latest_idx","autopilot_queue_context_latest_idx"])assert.ok(migration.includes(index),index);
  assert.match(migration,/CREATE INDEX CONCURRENTLY/);
});
