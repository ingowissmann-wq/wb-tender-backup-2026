import pg from "pg";
import { readFile } from "node:fs/promises";
if(process.env.WB_TENDER_ISOLATION_TEST_DATABASE!=="true")throw new Error('refusing_non_test_database');
if(!process.env.DATABASE_URL)throw new Error('database_url_missing');
if(process.env.EXTERNAL_SUBMISSION_ENABLED!=="false"||process.env.WB_TENDER_ALLOW_EXTERNAL_SUBMISSION!=="false")throw new Error('external_submission_flags_must_be_false');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1}),root=new URL('../',import.meta.url),internalTenant='00000000-0000-4000-8000-000000000085',wbRun='00000000-0000-4000-8000-000000000086',adminRun=process.env.REHEARSAL_ADMIN_RUN_ID||'00000000-0000-4000-8000-000000000087';
const execFile=async(relative)=>pool.query(await readFile(new URL(relative,root),'utf8'));
const businessManifest=async()=>{const tables=(await pool.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN('app','audit','cms','crm','files','iam','integration','communication','recruiting','tender') ORDER BY 1,2")).rows;const counts={};for(const t of tables)counts[`${t.schemaname}.${t.tablename}`]=Number((await pool.query(`SELECT count(*) count FROM ${t.schemaname}.${t.tablename}`)).rows[0].count);return counts;};
try{
  const before=await businessManifest();
  await pool.query("SELECT set_config('app.wb_internal_tenant_id',$1,false),set_config('app.wb_admin_backfill_run_id',$2,false),set_config('app.wb_admin_saas_enabled','false',false),set_config('app.tenant_id',$1,false),set_config('app.wb_backfill_run_id',$3,false)",[internalTenant,adminRun,wbRun]);
  for(const file of ['deployment/rollback-business-suite-trial-data-plane.sql','deployment/rollback-real-admin-tenant-enforcement.sql','deployment/rollback-real-admin-internal-tenant-backfill.sql','deployment/rollback-wb-internal-tenant-backfill.sql'])await execFile(file);
  const after=await businessManifest();
  for(const [table,count] of Object.entries(before))if(after[table]!==count)throw new Error(`rollback_business_row_count_changed_${table}`);
  console.log(JSON.stringify({passed:true,phase:'rollback',businessTableCountsPreserved:Object.keys(before).length,auditTriggerEnabled:(await pool.query("SELECT tgenabled='O' enabled FROM pg_trigger WHERE tgname='audit_append_only'")).rows[0]?.enabled===true}));
}finally{await pool.end();}
