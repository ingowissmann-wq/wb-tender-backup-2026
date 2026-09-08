import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import pg from 'pg';
import {enterpriseRecords} from '../platform/tenant-enterprise-api.mjs';
if(process.env.WB_TENDER_ROLLOUT_ISOLATED_TEST!=='true')throw Error('isolated_test_required');
const url=new URL((await fs.readFile(process.env.DATABASE_URL_FILE,'utf8')).trim());if(url.hostname!=='127.0.0.1'||!['5432','15432'].includes(url.port))throw Error('isolated_local_postgres_required');
const database='wb_api_test_'+crypto.randomBytes(8).toString('hex'),admin=new pg.Client({connectionString:url.href});await admin.connect();let fixture,runtime,created=false;
try{
 await admin.query('CREATE DATABASE '+database);created=true;url.pathname='/'+database;fixture=new pg.Client({connectionString:url.href});await fixture.connect();
 const role=(await fixture.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='wb_tender_api_login'")).rows[0];assert.ok(role&&!role.rolsuper&&!role.rolbypassrls);
 await fixture.query(`CREATE SCHEMA saas;CREATE SCHEMA tenant_portal;
 CREATE FUNCTION saas.tenant_matches(candidate uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT candidate=NULLIF(current_setting('app.tenant_id',true),'')::uuid$$;
 CREATE TABLE saas.tenant_companies(id uuid PRIMARY KEY,tenant_id uuid,display_name text,status text,created_at timestamptz DEFAULT now());
 CREATE TABLE tenant_portal.lot_assignment_versions(id uuid PRIMARY KEY,tenant_id uuid,workspace_id uuid,source_version_id uuid,lot_key text,version integer,assignment_kind text,company_id uuid,profile_id uuid,snapshot_sha256 text,created_at timestamptz DEFAULT now());
 CREATE TABLE tenant_portal.lot_calculation_versions(id uuid PRIMARY KEY,tenant_id uuid,assignment_id uuid,version integer,status text,result jsonb,created_at timestamptz DEFAULT now());
 CREATE TABLE tenant_portal.offer_packages(id uuid PRIMARY KEY,tenant_id uuid,calculation_id uuid,document_review_id uuid,version integer,manifest_sha256 text,created_at timestamptz DEFAULT now());
 CREATE TABLE saas.audit_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,tenant_id uuid,actor_user_id uuid,action text,target_type text,metadata jsonb,occurred_at timestamptz DEFAULT now());
 GRANT USAGE ON SCHEMA saas,tenant_portal TO wb_tender_api_login;GRANT SELECT ON ALL TABLES IN SCHEMA saas,tenant_portal TO wb_tender_api_login;GRANT INSERT ON saas.audit_events TO wb_tender_api_login;GRANT USAGE ON ALL SEQUENCES IN SCHEMA saas TO wb_tender_api_login;`);
 for(const table of ['saas.tenant_companies','tenant_portal.lot_assignment_versions','tenant_portal.lot_calculation_versions','tenant_portal.offer_packages','saas.audit_events'])await fixture.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;CREATE POLICY own_tenant ON ${table} USING(saas.tenant_matches(tenant_id)) WITH CHECK(saas.tenant_matches(tenant_id));`);
 runtime=new pg.Pool({connectionString:url.href,max:2});const pool={connect:async()=>{const client=await runtime.connect();await client.query('SET ROLE wb_tender_api_login');return client}},own={id:crypto.randomUUID(),actorUserId:crypto.randomUUID()},foreign={id:crypto.randomUUID(),actorUserId:crypto.randomUUID()};
 const ids=[crypto.randomUUID(),crypto.randomUUID(),crypto.randomUUID()].sort();for(const id of ids)await fixture.query("INSERT INTO saas.tenant_companies(id,tenant_id,display_name,status) VALUES($1,$2,'Own synthetic company','ACTIVE')",[id,own.id]);await fixture.query("INSERT INTO saas.tenant_companies(id,tenant_id,display_name,status) VALUES($1,$2,'Foreign company','ACTIVE')",[crypto.randomUUID(),foreign.id]);
 const first=await enterpriseRecords(pool,own,'companies',{limit:2});assert.deepEqual(first.items.map(x=>x.id),ids.slice(0,2));assert.equal(first.nextCursor,ids[1]);const last=await enterpriseRecords(pool,own,'companies',{limit:2,cursor:first.nextCursor});assert.deepEqual(last.items.map(x=>x.id),ids.slice(2));assert.equal(last.nextCursor,null);assert.equal(first.tenantId,own.id);assert.equal(first.currentReadinessAssessed,false);
 for(const [resource,table] of [['lot-assignments','lot_assignment_versions'],['calculations','lot_calculation_versions'],['offer-packages','offer_packages']]){await fixture.query(`INSERT INTO tenant_portal.${table}(id,tenant_id) VALUES($1,$2),($3,$4)`,[crypto.randomUUID(),own.id,crypto.randomUUID(),foreign.id]);assert.equal((await enterpriseRecords(pool,own,resource)).items.length,1);}
 assert.equal(Number((await fixture.query("SELECT count(*) FROM saas.audit_events WHERE tenant_id=$1 AND action='ENTERPRISE_API_READ'",[own.id])).rows[0].count),5);
 console.log(JSON.stringify({passed:true,realPostgres:true,forcedRls:true,allFourResourcesOwnTenantOnly:true,paginationNoDuplicate:true,readAudit:true,noCurrentApprovalClaim:true}));
}finally{if(runtime)await runtime.end();if(fixture)await fixture.end();if(created)await admin.query('DROP DATABASE '+database);await admin.end();}
