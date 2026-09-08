import pg from 'pg';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {runInboxPipeline} from '../platform/inbox-pipeline.mjs';
if(process.env.WB_TENDER_ROLLOUT_ISOLATED_TEST!=='true')throw new Error('isolated test marker required');
const client=new pg.Client({connectionString:(await fs.readFile(process.env.DATABASE_URL_FILE,'utf8')).trim()});
await client.connect();
// Every relation is session-local. No application schema or production row is changed.
const query=(sql,args)=>client.query(sql.replaceAll('tender.','pg_temp.'),args);
const adapter={query,connect:async()=>({query,release(){}})};
try{
await client.query(`
CREATE TEMP TABLE tenders(id uuid,raw_sha256 text,source_code text,external_id text,data_class text,source_lifecycle_status text,participation_status text,regions jsonb,title text,description text);
CREATE TEMP TABLE tender_versions(id uuid,tender_id uuid,version int,normalized_data jsonb);
CREATE TEMP TABLE service_relevance_evaluations(tender_id uuid,company_id uuid,lot_key text,evaluation_version int,snapshot_sha256 text,service_line text,relevance_status text,service_scope_gate text,reason text,primary_company boolean);
CREATE TEMP TABLE enterprise_company_links(company_id uuid,active boolean,legal_name text,technical_key text,sector_slug text,sector_status text,tender_profile_id uuid);
CREATE TEMP TABLE configuration_scopes(company_id uuid,tenant_id uuid,canonical_service text,profile_id uuid,active_region_version_id uuid);
CREATE TEMP TABLE configuration_active_parameters(company_id uuid,service_line text,parameter_key text,change_id uuid);
CREATE TEMP TABLE configuration_changes(id uuid,new_value jsonb,version_id uuid);
CREATE TEMP TABLE configuration_versions(id uuid,status text,tenant_id uuid,company_id uuid,canonical_service text,profile_id uuid,version_no int);
CREATE TEMP TABLE region_profile_versions(id uuid,status text,configuration_version_id uuid);
CREATE TEMP TABLE current_participation_eligible_lots(tender_id uuid,lot_key text);
CREATE TEMP TABLE lots(id uuid,tender_id uuid,external_id text,locations jsonb,source_reference_id uuid);
CREATE TEMP TABLE source_references(id uuid,tender_version_id uuid);
CREATE TEMP TABLE tender_tombstones(source_code text,external_id text,tombstone_status text);
CREATE TEMP TABLE enrichment_versions(id uuid,tender_id uuid,historical boolean);
CREATE TEMP TABLE enrichment_documents(enrichment_version_id uuid,fetch_status text,resolution_status text);
CREATE TEMP TABLE inbox_pipeline_runs(id uuid DEFAULT gen_random_uuid(),source_run_id uuid,run_kind text,status text,cutoff_at timestamptz,metadata jsonb,finished_at timestamptz,checked_count int,matched_count int,inbox_created_count int,region_created_count int,skipped_count int,error_count int,error_code text);
CREATE TEMP TABLE region_evaluation_batches(id uuid DEFAULT gen_random_uuid(),algorithm_version text,configuration_snapshot_sha256 text,input_snapshot_sha256 text,status text,completed_at timestamptz);
CREATE TEMP TABLE management_inbox(id uuid DEFAULT gen_random_uuid(),tender_id uuid,tender_version_id uuid,event_kind text,tenant_id uuid,company_id uuid,sector_slug text,service_line text,canonical_service text,profile_id uuid,region_profile_version_id uuid,decision text,hard_gates jsonb,missing_information jsonb,risks jsonb,recommended_next_step text,workflow_status text,responsible_user_id uuid,source_code text,source_run_id uuid,event_fingerprint text UNIQUE,created_at timestamptz DEFAULT now());
CREATE TEMP TABLE region_evaluations(id uuid DEFAULT gen_random_uuid(),batch_id uuid,tender_id uuid,inbox_id uuid,lot_id uuid,tenant_id uuid,company_id uuid,canonical_service text,profile_id uuid,region_profile_version_id uuid,evaluation_version int,classification text,detected_states jsonb,detected_nuts jsonb,source_data jsonb,parameter_key text,configuration_version_id uuid,configuration_version_no int,rule_snapshot jsonb,regional_decision text,matching_status text,explanation text,open_conditions jsonb,next_action text,
 UNIQUE NULLS NOT DISTINCT(batch_id,tender_id,company_id,lot_id),UNIQUE NULLS NOT DISTINCT(tender_id,company_id,lot_id,evaluation_version));
CREATE TEMP TABLE inbox_pipeline_items(run_id uuid,tender_id uuid,company_id uuid,lot_key text,classification_status text,region_status text,document_status text,matching_status text,inbox_status text,exclusion_reason text,pipeline_fingerprint text,location_evidence jsonb);
`);
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
await query("INSERT INTO tender.tenders VALUES($1,'raw','DOE','fixture','PUBLIC_REAL','ACTIVE','ELIGIBLE','[\"DE300\"]','Bewachung bundesweit','Berlin buyer')",[id(1)]);
const normalized={sourceCode:'DOE',lots:[{id:'L1',title:'Bewachung Karlsruhe'},{id:'L2',title:'Bewachung Berlin'}],locations:[{region:'DE300'}],raw:{tender:{items:[{relatedLot:'L1',deliveryAddress:{region:'DE122'}},{relatedLot:'L2',deliveryAddress:{region:'DE300'}}]}}};
await query('INSERT INTO tender.tender_versions VALUES($1,$2,1,$3)',[id(2),id(1),normalized]);
await query("INSERT INTO tender.enterprise_company_links VALUES($1,true,'WB Security','wb-security','security','approved',$2)",[id(3),id(4)]);
await query("INSERT INTO tender.configuration_scopes VALUES($1,$2,'security',$3,NULL)",[id(3),id(5),id(4)]);
await query("INSERT INTO tender.configuration_versions VALUES($1,'ACTIVE',$2,$3,'security',$4,1)",[id(6),id(5),id(3),id(4)]);
await query("INSERT INTO tender.configuration_changes VALUES($1,'\"Karlsruhe\"',$2)",[id(7),id(6)]);
await query("INSERT INTO tender.configuration_active_parameters VALUES($1,'security','A08',$2)",[id(3),id(7)]);
for(const [n,key] of [[11,'L1'],[12,'L2']]){
 await query("INSERT INTO tender.service_relevance_evaluations VALUES($1,$2,$3,1,$3,'security','RELEVANT','PASSED','fixture',true)",[id(1),id(3),key]);
 await query('INSERT INTO tender.current_participation_eligible_lots VALUES($1,$2)',[id(1),key]);
 await query("INSERT INTO tender.lots VALUES($1,$2,$3,'[]',NULL)",[id(n),id(1),key]);
}
let result=await runInboxPipeline(adapter,{tenderIds:[id(1)]});
assert.equal(result.checked,2);assert.equal(result.inboxCreated,2);assert.equal(result.core,1);assert.equal(result.outside,1);
let rows=(await query('SELECT lot_id,classification FROM tender.region_evaluations ORDER BY lot_id')).rows;
assert.deepEqual(rows,[{lot_id:id(11),classification:'CORE_REGION'},{lot_id:id(12),classification:'OUTSIDE_CORE_REGION'}]);
result=await runInboxPipeline(adapter,{tenderIds:[id(1)]});assert.equal(result.inboxCreated,0);assert.equal(result.regionCreated,0);
await query("UPDATE tender.management_inbox SET workflow_status='DECIDED',responsible_user_id=$1 WHERE id IN(SELECT inbox_id FROM tender.region_evaluations WHERE lot_id=$2)",[id(20),id(11)]);
await query('INSERT INTO tender.tender_versions VALUES($1,$2,2,$3)',[id(21),id(1),normalized]);
result=await runInboxPipeline(adapter,{tenderIds:[id(1)]});assert.equal(result.inboxCreated,2);
rows=(await query('SELECT evaluation.lot_id,inbox.workflow_status,inbox.responsible_user_id FROM tender.region_evaluations evaluation JOIN tender.management_inbox inbox ON inbox.id=evaluation.inbox_id WHERE inbox.tender_version_id=$1 ORDER BY evaluation.lot_id',[id(21)])).rows;
assert.deepEqual(rows,[{lot_id:id(11),workflow_status:'DECIDED',responsible_user_id:id(20)},{lot_id:id(12),workflow_status:'NEW',responsible_user_id:null}]);
console.log(JSON.stringify({result:'PASS',temporaryTablesOnly:true,realPostgres:true,lots:2,independentRegions:true,idempotentReimport:true,manualDecisionPreservedForExactLot:true}));
}finally{await client.end();}
