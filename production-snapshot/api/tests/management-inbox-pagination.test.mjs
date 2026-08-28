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
const exactBindingMigration=readFileSync(new URL("../migrations/152_management_inbox_exact_region_binding.sql",import.meta.url),"utf8");
const exactBindingRollback=readFileSync(new URL("../migrations/152_management_inbox_exact_region_binding.down.sql",import.meta.url),"utf8");

const tenant="11111111-1111-4111-8111-111111111111",securityCompany="22222222-2222-4222-8222-222222222222",cleaningCompany="33333333-3333-4333-8333-333333333333",securityProfile="44444444-4444-4444-8444-444444444444",cleaningProfile="55555555-5555-4555-8555-555555555555",tender="66666666-6666-4666-8666-666666666666";
const companies=[
  {tenant_id:tenant,company_id:securityCompany,legal_name:"WB-Security GmbH",sector_slug:"security",canonical_service:"security",service_line:"security",profile_id:securityProfile,active_region_version_id:"77777777-7777-4777-8777-777777777777",active_configuration_version_id:"99999999-9999-4999-8999-999999999999"},
  {tenant_id:tenant,company_id:cleaningCompany,legal_name:"WB-Cleaning GmbH",sector_slug:"cleaning",canonical_service:"cleaning",service_line:"cleaning",profile_id:cleaningProfile,active_region_version_id:"88888888-8888-4888-8888-888888888888",active_configuration_version_id:"99999999-9999-4999-8999-999999999999"},
  {tenant_id:tenant,company_id:"10000000-0000-4000-8000-000000000001",legal_name:"WB-Emergency Service GmbH",sector_slug:"emergency-services",canonical_service:"emergency_services",service_line:"emergency-services",profile_id:"20000000-0000-4000-8000-000000000001",active_region_version_id:null},
  {tenant_id:tenant,company_id:"10000000-0000-4000-8000-000000000002",legal_name:"WB-Facilitys GmbH",sector_slug:"facility-management",canonical_service:"facility_management",service_line:"facility-management",profile_id:"20000000-0000-4000-8000-000000000002",active_region_version_id:null},
  {tenant_id:tenant,company_id:"10000000-0000-4000-8000-000000000003",legal_name:"WB-Protect & Service GmbH",sector_slug:"security",canonical_service:"security",service_line:"security",profile_id:"20000000-0000-4000-8000-000000000003",active_region_version_id:null},
  {tenant_id:tenant,company_id:"10000000-0000-4000-8000-000000000004",legal_name:"WB-Sicherheitstechnik GmbH",sector_slug:"sicherheitstechnik",canonical_service:"sicherheitstechnik",service_line:"sicherheitstechnik",profile_id:"20000000-0000-4000-8000-000000000004",active_region_version_id:null},
];

function fakePool({empty=false,filteredEmpty=false,securityAcceptance=false,delay=0,queryError=null}={}){
  const calls=[];
  return {calls,async query(sql,params=[]){
    const compact=String(sql).replace(/\s+/g," ").trim();calls.push({sql:compact,params});
    if(compact.startsWith("SELECT company.company_id,company.legal_name"))return {rows:companies};
    if(compact.startsWith("WITH active_scope AS")){
      if(queryError)throw queryError;
      if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
      if(empty)return {rows:[]};
      if(filteredEmpty)return {rows:[{tender_id:null,base_total:123,filtered_total:0,core_count:5,strategic_count:4,outside_count:3,excluded_count:2,unresolved_count:109,conflict_count:0,multi_review_count:0,configuration_missing_count:0}]};
      const company=params[1]||securityCompany,scope=companies.find(item=>item.company_id===company)||companies[0];
      const configurationMissing=!scope.active_region_version_id;
      const base={company_id:scope.company_id,configuration_tenant_id:tenant,canonical_service:scope.canonical_service,active_profile_id:scope.profile_id,active_region_version_id:scope.active_region_version_id,active_configuration_version_id:configurationMissing?null:"99999999-9999-4999-8999-999999999999",title:"Produktive Testausschreibung",publication_date:"2026-08-19",tender_created_at:"2026-08-19",buyer:"Stadt",regions:[],cpv_codes:[],detected_nuts:[],detected_states:[],classification:configurationMissing?"REGION_CONFIGURATION_MISSING":"REGION_UNRESOLVED",region_configuration_status:configurationMissing?"REGION_CONFIGURATION_MISSING":"REGION_EVALUATION_MISSING",relevance_status:"RELEVANT",service_line:scope.service_line,lot_key:null};
      if(securityAcceptance){
        const offset=params[9],requested=params[5],available=Math.max(0,95-offset),returned=Math.min(requested,available);
        return {rows:Array.from({length:returned},(_,index)=>({...base,tender_id:`${String(offset+index+1).padStart(8,"0")}-6666-4666-8666-666666666666`,base_total:95,filtered_total:95,core_count:15,strategic_count:6,outside_count:59,excluded_count:0,unresolved_count:0,conflict_count:0,multi_review_count:15,configuration_missing_count:0}))};
      }
      if(configurationMissing)return {rows:[{...base,tender_id:tender,base_total:1,filtered_total:1,core_count:0,strategic_count:0,outside_count:0,excluded_count:0,unresolved_count:0,conflict_count:0,multi_review_count:0,configuration_missing_count:1,not_applicable_count:0}]};
      return {rows:[{...base,tender_id:tender,base_total:123,filtered_total:123,core_count:5,strategic_count:4,outside_count:3,excluded_count:2,unresolved_count:109,conflict_count:0,multi_review_count:0,configuration_missing_count:0}]};
    }
    if(compact.startsWith("SELECT job.company_id,job.canonical_service"))return {rows:[]};
    if(compact.startsWith("SELECT tender_id,lot_key,status,last_checked_at"))return {rows:[]};
    if(compact.startsWith("SELECT t.id tender_id,t.source_code"))return {rows:[{tender_id:tender,source_code:"TED",source_url:"https://ted.europa.eu/de/notice/-/detail/1",external_id:"1",normalized_data:{raw:{links:{html:{DEU:"https://ted.europa.eu/de/notice/-/detail/1"}}}},enrichment_id:null,enrichment_documents:[]}]};
    if(compact.startsWith("SELECT DISTINCT ON(event.tender_id,event.metadata->>'companyId')"))return {rows:[]};
    if(compact.startsWith("SELECT display_name,canonical_domain")||compact.startsWith("SELECT id,display_name,canonical_domain"))return {rows:[]};
    if(compact.startsWith("SELECT DISTINCT ON(e.tender_id) e.tender_id"))return {rows:[]};
    if(compact.startsWith("SELECT t.id tender_id,t.external_id,t.notice_classification"))return {rows:[{tender_id:tender,notice_classification:"COMPETITION",source_lifecycle_status:"ACTIVE",participation_status:"ELIGIBLE"}]};
    throw new Error(`unexpected query: ${compact.slice(0,180)}`);
  }};
}

function appFor(pool){
  const app=Fastify({logger:false});
  registerAutopilotRoutes(app,{pool,requirePermission:()=>async req=>{req.identity={userId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",permissions:["tender.admin"],companyIds:companies.map(item=>item.company_id),sectorSlugs:[]}},csrf:async()=>{},visibleTender:async()=>true});
  return app;
}

test("management inbox resolves current relevance by active tender and indexed company scope before DB pagination",()=>{
  assert.doesNotMatch(routes,/FROM tender\.current_service_relevance r JOIN active_scope/);
  assert.match(managementRoute,/active_lots AS MATERIALIZED\(/);
  assert.match(managementRoute,/FROM tender\.tender_lot_lifecycles eligible/);
  assert.match(managementRoute,/candidate\.id=eligible\.tender_id AND candidate\.data_class='PUBLIC_REAL'/);
  assert.match(managementRoute,/candidate\.notice_classification IN\('COMPETITION','CORRIGENDUM'\)/);
  assert.match(managementRoute,/eligible\.is_current AND eligible\.lifecycle_status='ACTIVE' AND eligible\.participation_status='ELIGIBLE'/);
  assert.match(managementRoute,/eligible\.deadline_quality='EXACT' AND eligible\.offer_deadline>now\(\)/);
  assert.doesNotMatch(managementRoute,/current_participation_eligible_lots/);
  assert.match(managementRoute,/active_tenders AS MATERIALIZED\(/);
  assert.match(managementRoute,/CROSS JOIN active_tenders tender/);
  assert.match(managementRoute,/current_relevance AS MATERIALIZED\(/);
  assert.match(managementRoute,/JOIN LATERAL\([\s\S]*SELECT DISTINCT ON\(candidate\.lot_key\) candidate\.\*/);
  assert.match(managementRoute,/candidate\.company_id=scope\.company_id AND candidate\.service_line=scope\.service_line/);
  assert.match(managementRoute,/candidate\.tender_id=tender\.id/);
  assert.match(managementRoute,/candidate\.evaluation_version DESC,candidate\.created_at DESC,candidate\.id DESC/);
  assert.match(managementRoute,/\(r\.lot_key IS NULL OR EXISTS[\s\S]*\)\s+AND \(\$7::boolean OR r\.primary_company\)/);
  assert.doesNotMatch(managementRoute,/current_registered_tender_company_portals registered/);
  assert.match(managementRoute,/bool_or\(r\.primary_company\) OVER\(PARTITION BY r\.tender_id,r\.lot_key\) has_primary/);
  assert.doesNotMatch(managementRoute,/NOT EXISTS\(SELECT 1 FROM tender\.service_relevance_evaluations newer/);
  assert.match(routes,/base_candidates AS MATERIALIZED/);
  assert.match(routes,/filtered_candidates AS MATERIALIZED/);
  assert.match(routes,/paged AS MATERIALIZED\([\s\S]*LIMIT \$6 OFFSET \$10/);
  assert.ok(routes.indexOf("paged AS MATERIALIZED")<routes.indexOf("LEFT JOIN paged p ON true"));
  assert.doesNotMatch(managementRoute,/LIMIT 5000/);
});

test("management inbox and detail bind the exact active region scope without a pipeline-version shortcut",()=>{
  assert.doesNotMatch(managementRoute,/source_data->>'pipelineVersion'/);
  assert.doesNotMatch(detailRoute,/source_data->>'pipelineVersion'/);
  for(const binding of ["e.tenant_id=scope.tenant_id","e.company_id=scope.company_id","e.canonical_service=scope.canonical_service","e.profile_id=scope.profile_id","e.region_profile_version_id=scope.active_region_version_id","e.configuration_version_id=scope.active_configuration_version_id"])assert.ok(managementRoute.includes(binding),binding);
  assert.match(managementRoute,/e\.evaluation_version DESC,e\.created_at DESC,e\.id DESC/);
  assert.match(detailRoute,/region\.evaluation_version DESC,region\.created_at DESC,region\.id DESC/);
  assert.match(managementRoute,/LEFT JOIN tender\.lots canonical_lot ON canonical_lot\.tender_id=r\.tender_id AND canonical_lot\.external_id=r\.lot_key/);
  assert.match(managementRoute,/e\.lot_id IS NOT DISTINCT FROM canonical_lot\.id/);
  assert.match(detailRoute,/canonical_lot\.external_id=coalesce\(nullif\(\$3,''\),r\.lot_key\)/);
  assert.match(detailRoute,/region\.lot_id IS NOT DISTINCT FROM canonical_lot\.id/);
  assert.doesNotMatch(managementRoute,/e\.lot_id IS NULL/);
  assert.doesNotMatch(detailRoute,/region\.lot_id IS NULL/);
});

test("detail accepts a listed tender without legacy region materialization and remains fail-closed per lot",()=>{
  assert.match(detailRoute,/LEFT JOIN LATERAL\(SELECT region\.\* FROM tender\.region_evaluations/);
  assert.match(detailRoute,/coalesce\(e\.classification,'REGION_UNRESOLVED'\)/);
  assert.match(detailRoute,/current_participation_eligible_lots selected_lot/);
  assert.match(detailRoute,/coalesce\(nullif\(\$3,''\),r\.lot_key\) relevance_lot_key/);
  assert.match(detailRoute,/tender_lot_lifecycles life/);
});

test("tender-wide relevance requires explicit eligible lot selection before scoped actions",()=>{
  assert.match(ui,/if\(!item\.lot_key&&!item\.noticeLifecycle\)/);
  assert.match(ui,/Teilnahmefähiges Los auswählen/);
  assert.match(ui,/data-select-participation-lot/);
  assert.match(ui,/portalAccess = c\.lot_key\?/);
  assert.match(ui,/participationAction=contextReady\?/);
});

test("category counters come from the shared base before the selected region filter",()=>{
  assert.ok(managementRoute.indexOf("category_counts AS")>managementRoute.indexOf("base_candidates AS MATERIALIZED"));
  assert.ok(managementRoute.indexOf("filtered_candidates AS MATERIALIZED")>managementRoute.indexOf("category_counts AS"));
  assert.match(managementRoute,/FROM category_counts CROSS JOIN filtered_count LEFT JOIN paged p ON true/);
});

test("current regions use exact tenant/company/service/profile/version identity and linked inbox decisions",()=>{
  for(const token of ["scope.tenant_id","scope.canonical_service","scope.profile_id","active_version.id active_configuration_version_id"])assert.ok(managementRoute.includes(token),token);
  assert.doesNotMatch(managementRoute,/unambiguous_scope|stable_canonical_service/);
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

test("WB-Security acceptance fixture returns 15/6/59/0/0/15 = 95 with pages 50 plus 45",async t=>{
  const pool=fakePool({securityAcceptance:true}),app=appFor(pool);t.after(()=>app.close());
  const first=await app.inject({method:"GET",url:`/api/management-inbox?company=${securityCompany}&serviceLine=security&page=1&pageSize=50`});
  const second=await app.inject({method:"GET",url:`/api/management-inbox?company=${securityCompany}&serviceLine=security&page=2&pageSize=50`});
  for(const response of [first,second])assert.equal(response.statusCode,200,response.body);
  assert.equal(first.json().items.length,50);assert.equal(first.json().hasMore,true);
  assert.equal(second.json().items.length,45);assert.equal(second.json().hasMore,false);
  assert.deepEqual(first.json().counts,{CORE_REGION:15,STRATEGIC_REGION:6,OUTSIDE_CORE_REGION:59,EXCLUDED_REGION:0,REGION_UNRESOLVED:0,REGION_CONFIG_CONFLICT:0,MULTI_REGION_REVIEW:15,REGION_CONFIGURATION_MISSING:0,NOT_APPLICABLE:0});
  assert.equal(first.json().contextCount,95);assert.equal(first.json().statusTotal,95);
});

test("all four companies without authoritative regions fail closed without cross-company defaults",async t=>{
  const pool=fakePool(),app=appFor(pool);t.after(()=>app.close());
  for(const company of companies.filter(item=>!item.active_region_version_id)){
    const response=await app.inject({method:"GET",url:`/api/management-inbox?company=${company.company_id}&serviceLine=${company.service_line}`});
    assert.equal(response.statusCode,200,`${company.legal_name}: ${response.body}`);
    const body=response.json();assert.equal(body.items[0].classification,"REGION_CONFIGURATION_MISSING",company.legal_name);
    assert.equal(body.counts.REGION_CONFIGURATION_MISSING,1,company.legal_name);assert.equal(body.statusTotal,body.contextCount,company.legal_name);
  }
});

test("an unconfigured company with zero candidates still reports REGION_CONFIGURATION_MISSING",async t=>{
  const pool=fakePool({empty:true}),app=appFor(pool);t.after(()=>app.close());
  const company=companies.find(item=>item.legal_name.includes("Protect"));
  const response=await app.inject({method:"GET",url:`/api/management-inbox?company=${company.company_id}&serviceLine=${company.service_line}`});
  assert.equal(response.statusCode,200,response.body);assert.equal(response.json().items.length,0);
  assert.equal(response.json().regionConfigurationStatus,"REGION_CONFIGURATION_MISSING");
  assert.equal(response.json().configurationIssues.some(item=>item.company===company.legal_name),true);
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
  assert.equal(response.json().items[0].linkEvidence.missingReasons.procurementPortal,"Kein autoritatives Vergabeportal ermittelt – Portalzuordnung prüfen");
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

test("portal-access control is a semantic server-targeted navigation without secret data attributes",()=>{
  const render=ui.slice(ui.indexOf("const portalManageButton"),ui.indexOf("const renderTenderLinkEvidence"));
  assert.match(render,/<a class="button-link"/);
  assert.match(render,/href="\$\{esc\(target\)\}"/);
  assert.match(render,/item\?\.portal_navigation_href/);
  assert.doesNotMatch(render,/<button|onclick|data-open-portal-access/);
  assert.doesNotMatch(render,/data-(?:username|account-label|responsible|login-status|mfa|notes)/);
});

test("portal-access dialog renders only masked credential metadata and safe links",()=>{
  const handler=ui.slice(ui.indexOf('const base = location.port'));
  for(const field of ["usernameMasked","internalLabel","contactPerson","registrationStatus","loginStatus","mfaRequired","lastManualCheckAt"])assert.match(handler,new RegExp(field));
  assert.doesNotMatch(handler,/credential\.(?:ciphertext|iv|auth_tag|password|totpSeed|recoveryCodes)/);
  assert.match(handler,/url\.protocol !== "https:"/);
  assert.match(handler,/target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(ui,/disabled aria-disabled="true" title="Das Vergabeportal konnte nicht eindeutig ermittelt werden/);
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

test("the repair reads the exact current region materialization and its linked inbox row",()=>{
  assert.doesNotMatch(managementRoute,/wb-daily-inbox-pipeline\/1\.0\.0/);
  assert.match(routes,/x\.id=p\.region_inbox_id/);
  assert.match(routes,/region_recalculation_status,r\.region_recalculation_processed,r\.region_recalculation_total/);
  assert.match(ui,/letzte vollständig berechnete Inbox-Version/);
});

test("configuration gaps and multi-region reviews are independent fail-closed statuses",()=>{
  assert.match(managementRoute,/THEN 'REGION_CONFIGURATION_MISSING'/);
  assert.match(managementRoute,/configuration_missing_count/);
  assert.match(managementRoute,/contextCount,statusTotal/);
  assert.match(ui,/<option value="MULTI_REGION_REVIEW">Mehrere Regionen – Einzelprüfung<\/option>/);
  assert.match(ui,/<option value="REGION_CONFIGURATION_MISSING">Regionskonfiguration fehlt<\/option>/);
  assert.match(ui,/role="alert"><strong>REGION_CONFIGURATION_MISSING<\/strong>/);
  assert.match(ui,/region-configuration-missing/);
  assert.match(ui,/Teilnahme \/ Submission<\/dt><dd>Gesperrt/);
  assert.doesNotMatch(ui,/REGION_UNRESOLVED,REGION_CONFIG_CONFLICT,MULTI_REGION_REVIEW/);
  assert.match(managementRoute,/regionConfigurationStatus,configurationIssues/);
  assert.match(ui,/data\.regionConfigurationStatus==="REGION_CONFIGURATION_MISSING"/);
});

test("supporting indexes cover current relevance, pagination detail contexts and are rollbackable",()=>{
  for(const index of ["service_relevance_current_filter_idx","management_inbox_active_page_idx","calculations_context_version_idx","approval_requests_context_latest_idx","autopilot_queue_context_latest_idx"])assert.ok(migration.includes(index),index);
  assert.match(migration,/CREATE INDEX CONCURRENTLY/);
});

test("exact region binding index is additive, deterministic and rollbackable",()=>{
  for(const column of ["tenant_id","company_id","canonical_service","profile_id","region_profile_version_id","configuration_version_id","tender_id","lot_id","evaluation_version DESC","created_at DESC","id DESC"])assert.ok(exactBindingMigration.includes(column),column);
  assert.match(exactBindingMigration,/CREATE INDEX CONCURRENTLY IF NOT EXISTS region_evaluations_management_inbox_exact_idx/);
  assert.doesNotMatch(exactBindingMigration,/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/);
  assert.match(exactBindingRollback,/DROP INDEX CONCURRENTLY IF EXISTS tender\.region_evaluations_management_inbox_exact_idx/);
});
