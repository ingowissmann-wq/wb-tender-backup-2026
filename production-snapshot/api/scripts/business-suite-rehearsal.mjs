import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

if(process.env.WB_TENDER_ISOLATION_TEST_DATABASE!=="true")throw new Error("refusing_non_test_database");
if(!process.env.DATABASE_URL)throw new Error("database_url_missing");
if(process.env.EXTERNAL_SUBMISSION_ENABLED!=="false"||process.env.WB_TENDER_ALLOW_EXTERNAL_SUBMISSION!=="false")throw new Error("external_submission_flags_must_be_false");
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
const root=new URL('../',import.meta.url),internalTenant='00000000-0000-4000-8000-000000000085',wbRun='00000000-0000-4000-8000-000000000086',adminRun=process.env.REHEARSAL_ADMIN_RUN_ID||'00000000-0000-4000-8000-000000000087';
const sql=async(relative)=>readFile(new URL(relative,root),'utf8');
const execFile=async(relative)=>pool.query(await sql(relative));
const businessManifest=async()=>{const tables=(await pool.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN('app','audit','cms','crm','files','iam','integration','communication','recruiting','tender') ORDER BY 1,2")).rows;const counts={};for(const t of tables)counts[`${t.schemaname}.${t.tablename}`]=Number((await pool.query(`SELECT count(*) count FROM ${t.schemaname}.${t.tablename}`)).rows[0].count);return counts;};
try{
  const before=await businessManifest(),fingerprint=crypto.createHash('sha256').update(JSON.stringify(before)).digest('hex');
  for(const migration of ['migrations/080_saas_product_entitlements.sql','migrations/081_tenant_data_plane.sql','migrations/082_commercial_module_catalog.sql','migrations/083_real_admin_portal_tenant_columns.sql'])await execFile(migration);
  const companies=Number((await pool.query('SELECT count(*) count FROM tender.enterprise_company_links')).rows[0].count);
  await pool.query("SELECT set_config('app.tenant_id',$1,false),set_config('app.wb_tenant_display_name','WB Internal Rehearsal',false),set_config('app.wb_identity_hash',$2,false),set_config('app.wb_expected_companies',$3,false),set_config('app.wb_source_fingerprint',$2,false),set_config('app.wb_backfill_run_id',$4,false)",[internalTenant,fingerprint,String(companies),wbRun]);
  await execFile('deployment/backfill-wb-internal-tenant.sql');
  const manifestHash=(await pool.query("SELECT encode(digest(saas.admin_source_manifest()::text,'sha256'),'hex') hash")).rows[0].hash;
  await pool.query("SELECT set_config('app.wb_internal_tenant_id',$1,false),set_config('app.wb_admin_backfill_run_id',$2,false),set_config('app.wb_admin_source_manifest_sha256',$3,false),set_config('app.wb_admin_saas_enabled','false',false)",[internalTenant,adminRun,manifestHash]);
  await execFile('deployment/backfill-real-admin-internal-tenant.sql');
  await execFile('migrations/084_real_admin_portal_tenant_enforcement.sql'); await execFile('migrations/085_business_suite_trial_data_plane.sql');
  const forced=Number((await pool.query("SELECT count(*) count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('saas','tenant_portal','app','files','crm','audit','integration','communication') AND c.relrowsecurity AND c.relforcerowsecurity")).rows[0].count);
  const after=await businessManifest();for(const [table,count] of Object.entries(before))if(after[table]!==count)throw new Error(`business_row_count_changed_${table}_${count}_${after[table]}`);
  console.log(JSON.stringify({passed:true,phase:'apply',sourceFingerprint:fingerprint,internalTenant,companyCount:companies,forcedRlsTables:forced,businessTableCountsPreserved:Object.keys(before).length}));
}finally{await pool.end();}
