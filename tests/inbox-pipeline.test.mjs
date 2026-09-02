import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {classifyRegion,canonicalRegion,resolveTenderRegions} from "../platform/region-gate.mjs";
import {classifyTenderServices} from "../platform/service-relevance.mjs";
import {documentPipelineStatus,extractSourceLocations,inboxDecision,normalizeExactContextBindings} from "../platform/inbox-pipeline.mjs";
import {normalizeDoeRelease,normalizeTedNotice} from "../platform/source-ingestion.mjs";

const source=readFileSync(new URL("../platform/source-ingestion.mjs",import.meta.url),"utf8"),pipeline=readFileSync(new URL("../platform/inbox-pipeline.mjs",import.meta.url),"utf8"),routes=readFileSync(new URL("../platform/autopilot-routes.mjs",import.meta.url),"utf8");
const security={company_id:"00000000-0000-4000-8000-000000000001",legal_name:"WB Security",technical_key:"wb-security",sector_slug:"security",sector_status:"approved"};
const companies=[{company:security,parameters:[],profile:null},{company:{...security,company_id:"00000000-0000-4000-8000-000000000002",legal_name:"WB Cleaning",technical_key:"wb-cleaning",sector_slug:"cleaning"},parameters:[],profile:null}];
const region=(regions,locations=[])=>classifyRegion({company:security,tender:{id:"t",title:"Bewachung",description:"",regions,locations},config:{A08:"Karlsruhe",A09:"Baden-Württemberg",versionId:"v",versionNo:126},applicable:true});
const structuredBavaria={schema:"WB_CORE_REGIONS_V1",regions:[{id:"bavaria",type:"STATE",place:"Bayern",state:"Bayern",nutsCode:"DE2",validationStatus:"VALID"}]};
const structuredRegion=(locations,company=security,config={})=>classifyRegion({company,tender:{id:"structured",title:"Dienstleistung",description:"",regions:[],locations},config:{A08:structuredBavaria,structuredRegions:structuredBavaria,A09:"Baden-Württemberg",A10:"Berlin",versionId:"active",versionNo:140,regionProfileVersionId:"region-active",...config},applicable:true});

test("new Security tender in configured Karlsruhe core region is eligible for inbox",()=>{const result=region(["DE122"]);assert.equal(result.classification,"CORE_REGION");assert.equal(inboxDecision(result).decision,"PRELIMINARY_GO")});
test("Security tender outside the configured region is not marked core",()=>assert.equal(region(["DE300"]).classification,"OUTSIDE_CORE_REGION"));
test("Security aliases map canonically",()=>{for(const alias of ["Security","Sicherheitsdienst","Sicherheitsdienstleistungen","Bewachung","Objektschutz","Wachschutz","Empfangs- und Pfortendienst"]){const result=classifyTenderServices({tender:{id:alias,title:alias,description:"Operative Dienstleistung",cpv_codes:[]},companies});assert.equal(result.primary?.serviceLine,"security",alias)}});
test("Security CPV is classified without a text shortcut",()=>assert.equal(classifyTenderServices({tender:{id:"cpv",title:"Dienstleistung",description:"Leistungsumfang",cpv_codes:["79710000"]},companies}).primary?.serviceLine,"security"));
test("unrelated IT security remains excluded",()=>assert.notEqual(classifyTenderServices({tender:{id:"it",title:"IT Security",description:"Cyber security",cpv_codes:["72000000"]},companies}).primary?.serviceLine,"security"));
test("TED NUTS location remains canonical",()=>{const row=normalizeTedNotice({"publication-number":"1-2026","publication-date":"2026-08-18","notice-title":{deu:"Bewachung"},"buyer-name":{deu:["Stadt"]},"classification-cpv":["79710000"],"place-of-performance":["DE122"],links:{html:{DEU:"https://ted.europa.eu/1"}}},"2026-08-19T00:00:00Z");assert.deepEqual(row.regions,["DE122"])});
test("DOE location keeps region locality and supplied postcode",()=>{const row=normalizeDoeRelease({id:"d",date:"2026-08-18T00:00:00Z",buyer:{name:"Stadt"},tender:{title:"Bewachung",items:[{classification:{id:"79710000"},deliveryAddress:{region:"DE122",locality:"Karlsruhe",postalCode:"76131"}}]}});assert.deepEqual(row.locations,[{region:"DE122",nuts:null,locality:"Karlsruhe",postalCode:"76131",country:null}])});
test("missing postcode is never invented",()=>{const locations=extractSourceLocations({source_code:"DOE"},{sourceCode:"DOE",raw:{tender:{items:[{deliveryAddress:{locality:"Karlsruhe"}}]}}});assert.equal(locations[0].postalCode,null)});
test("multi-lot DOE locations remain bound to their authoritative lot",()=>{
  const normalized={sourceCode:"DOE",raw:{tender:{items:[
    {id:"LOT-CORE",deliveryAddress:{region:"DE271",locality:"Augsburg",postalCode:"86150"}},
    {id:"LOT-OUTSIDE",deliveryAddress:{region:"DE300",locality:"Berlin",postalCode:"10115"}},
  ]}}};
  assert.deepEqual(extractSourceLocations({source_code:"DOE"},normalized,"LOT-CORE"),[{region:"DE271",nuts:null,locality:"Augsburg",postalCode:"86150",country:null,latitude:null,longitude:null}]);
  assert.deepEqual(extractSourceLocations({source_code:"DOE"},normalized,"LOT-OUTSIDE"),[{region:"DE300",nuts:null,locality:"Berlin",postalCode:"10115",country:null,latitude:null,longitude:null}]);
});
test("unknown DOE lot fails closed instead of borrowing another lot location",()=>{
  const normalized={sourceCode:"DOE",raw:{tender:{items:[{id:"LOT-1",deliveryAddress:{region:"DE271"}}]}}};
  assert.deepEqual(extractSourceLocations({source_code:"DOE"},normalized,"LOT-MISSING"),[]);
});
test("multiple locations retain evidence but are routed to review instead of core",()=>{const result=region([], [{region:"DE122"},{region:"DE111"}]);assert.equal(result.classification,"MULTI_REGION_REVIEW");assert.equal(resolveTenderRegions({regions:[],locations:[{region:"DE122"},{region:"DE111"}]}).nuts.length,2)});
test("active structured configuration yields core, strategic, excluded, outside and unresolved fixtures",()=>{assert.equal(structuredRegion([{region:"DE271"},{region:"DEU"}]).classification,"CORE_REGION");assert.equal(structuredRegion([{region:"DE146"},{region:"DEU"}]).classification,"STRATEGIC_REGION");assert.equal(structuredRegion([{region:"DE300"},{region:"DEU"}]).classification,"EXCLUDED_REGION");assert.equal(structuredRegion([{region:"DE712"},{region:"DEU"}]).classification,"OUTSIDE_CORE_REGION");assert.equal(structuredRegion([{region:"DEU"}]).classification,"REGION_UNRESOLVED")});
test("structured classification remains company-profile isolated",()=>{const cleaning={...security,company_id:"00000000-0000-4000-8000-000000000002",legal_name:"WB Cleaning"},baden={schema:"WB_CORE_REGIONS_V1",regions:[{id:"baden",type:"STATE",place:"Baden-Württemberg",state:"Baden-Württemberg",nutsCode:"DE1",validationStatus:"VALID"}]};assert.equal(structuredRegion([{region:"DE271"}],cleaning).classification,"CORE_REGION");assert.equal(structuredRegion([{region:"DE271"}],security,{A08:baden,structuredRegions:baden,A09:null,A10:null}).classification,"OUTSIDE_CORE_REGION")});
test("Karlsruhe is normalized as the configured DE12 administrative region",()=>assert.equal(canonicalRegion("Karlsruhe"),"DE12"));
test("daily import invokes the full inbox pipeline before success",()=>{assert.match(source,/await runInboxPipeline/);assert.match(source,/downstreamFailed = !inboxPipeline\.passed/);assert.match(source,/passed: status === "SUCCESS"/)});
test("duplicate source records re-enter the idempotent downstream pipeline after a prior partial failure",()=>{assert.match(source,/if \(result\.tenderId\) pipelineTenderIds\.push\(result\.tenderId\)/);assert.match(source,/pipelineTenderIds = unique\(pipelineTenderIds\)/);assert.match(source,/runInboxPipeline\(pool, \{ tenderIds: pipelineTenderIds/)});
test("duplicate records with incomplete classification are retried",()=>{assert.match(source,/needsClassification: prior\.classification_status !== "CLASSIFIED"/);assert.match(source,/result\.kind !== "duplicate" \|\| result\.needsClassification/)});
test("download failure is reviewable and does not become not relevant",()=>assert.equal(documentPipelineStatus([{fetch_status:"DOWNLOAD_FEHLGESCHLAGEN"}]),"DOWNLOAD_FAILED_REVIEWABLE"));
test("inbox materialization is idempotent",()=>assert.match(pipeline,/ON CONFLICT\(event_fingerprint\) DO NOTHING/));
test("identical completed region batches are reused idempotently",()=>{assert.match(pipeline,/SELECT id FROM tender\.region_evaluation_batches WHERE algorithm_version=.*status='COMPLETED'/);assert.match(pipeline,/batchId=completedBatch\?\.id\|\|/)});
test("canonical lot rematerialization has a new authoritative pipeline identity",()=>{assert.match(pipeline,/wb-daily-inbox-pipeline\\/2\\.3\\.0-selected-lot-direct-binding/);assert.match(pipeline,/pipelineFingerprint:fingerprint/)});
test("region materialization preserves one context per company and canonical lot",()=>{
  assert.match(pipeline,/DISTINCT ON\(t\.id,r\.company_id,eligible_lot\.lot_key\)/);
  assert.match(pipeline,/FROM tender\.current_participation_eligible_lots eligible/);
  assert.match(pipeline,/FROM tender\.tender_lot_selections selection/);
  assert.match(pipeline,/JOIN tender\.lots canonical_lot ON canonical_lot\.tender_id=t\.id AND canonical_lot\.external_id=eligible_lot\.lot_key/);
  assert.match(pipeline,/lot_id IS NOT DISTINCT FROM \$6::uuid/);
  assert.match(pipeline,/INSERT INTO tender\.region_evaluations\(batch_id,tender_id,inbox_id,lot_id/);
  assert.match(pipeline,/\[batchId,row\.id,inboxId,row\.canonical_lot_id,/);
  assert.doesNotMatch(pipeline,/DISTINCT ON\(t\.id,r\.company_id\) /);
});
test("repair materialization accepts only unique exact company tender and lot bindings",()=>{
  const binding={tenderId:"11111111-1111-4111-8111-111111111111",companyId:"22222222-2222-4222-8222-222222222222",lotKey:"LOT-1"};
  assert.deepEqual(normalizeExactContextBindings([binding]),[{tender_id:binding.tenderId,company_id:binding.companyId,lot_key:"LOT-1"}]);
  assert.throws(()=>normalizeExactContextBindings([{...binding,lotKey:""}]),error=>error.code==="EXACT_CONTEXT_BINDING_INVALID");
  assert.throws(()=>normalizeExactContextBindings([binding,binding]),error=>error.code==="EXACT_CONTEXT_BINDING_DUPLICATE");
  assert.match(pipeline,/jsonb_to_recordset\(\$6::jsonb\) binding\(tender_id uuid,company_id uuid,lot_key text\)/);
  assert.match(pipeline,/EXACT_CONTEXT_BINDING_TARGET_MISMATCH/);
});
test("existing user workflow decisions are not overwritten",()=>{assert.doesNotMatch(pipeline,/ON CONFLICT\(event_fingerprint\).*DO UPDATE/s);assert.match(pipeline,/prior\?\.workflow_status\|\|"NEW"/);assert.match(pipeline,/prior\?\.responsible_user_id\|\|null/);assert.match(pipeline,/SELECT id FROM tender\.management_inbox WHERE event_fingerprint/)});
test("expired and tombstoned tenders are excluded",()=>{assert.match(pipeline,/source_lifecycle_status='ACTIVE'/);assert.match(pipeline,/tombstone_status='DELETED'/)});
test("tenant isolation remains based on accessible companies",()=>{assert.match(routes,/const companies = await accessibleCompanies\(req\.identity\)/);assert.match(routes,/r\.company_id=ANY\(\$1::uuid\[\]\)/)});
test("inbox visibility no longer depends on portal credentials while portal fields remain scoped",()=>{assert.match(routes,/LEFT JOIN tender\.current_registered_tender_company_portals registered/);assert.match(routes,/registered\.tender_id=r\.tender_id AND registered\.company_id=r\.company_id/)});
test("API and UI use the same management inbox endpoint",()=>{const ui=readFileSync(new URL("../platform/assets/inbox-regions.js",import.meta.url),"utf8");assert.match(ui,/\/management-inbox\?/);assert.match(routes,/"\/api\/management-inbox"/)});

test("explicit selected-lot repair is independent of discovery lifecycle gates",()=>{
  assert.match(pipeline,/async function selectedTargetRows/);
  assert.match(pipeline,/FROM jsonb_to_recordset\(\$1::jsonb\)/);
  assert.match(pipeline,/JOIN tender\.tender_lot_selections selection/);
  assert.match(pipeline,/LEFT JOIN LATERAL\(/);
  assert.match(pipeline,/return selectedTargetRows\(client,scope,contextBindings\)/);
  assert.doesNotMatch(
    pipeline.match(/async function selectedTargetRows[\s\S]*?async function targetRows/)?.[0]||"",
    /relevance_status='RELEVANT'|service_scope_gate='PASSED'|primary_company=true/
  );
});
