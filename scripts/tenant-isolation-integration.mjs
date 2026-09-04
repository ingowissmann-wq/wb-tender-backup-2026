import pg from "pg";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { withTenantContext } from "../platform/tenant-context.mjs";

if (process.env.WB_TENDER_ISOLATION_TEST_DATABASE !== "true")
  throw new Error("refusing_non_test_database");
if (process.env.DATABASE_URL || process.env.TEST_DATABASE_ADMIN_URL) throw new Error("inline_database_secret_forbidden");
if (!process.env.DATABASE_URL_FILE) throw new Error("database_url_file_missing");
if (!process.env.TEST_DATABASE_ADMIN_URL_FILE) throw new Error("test_database_admin_url_file_missing");
const databaseUrl = readFileSync(process.env.DATABASE_URL_FILE, "utf8").trim();
const adminUrl = readFileSync(process.env.TEST_DATABASE_ADMIN_URL_FILE, "utf8").trim();

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const a = crypto.randomUUID(), b = crypto.randomUUID();
const insertTenant = (id, name) => withTenantContext(pool, { tenantId: id }, async (db) => {
  await db.query("INSERT INTO saas.tenants(id,slug,display_name,status,customer_identity_hash) VALUES($1,$2,$3,'ACTIVE',$4)", [id, `test-${id.slice(0,12)}`, name, crypto.createHash("sha256").update(id).digest("hex")]);
  await db.query("INSERT INTO saas.subscriptions(tenant_id,plan_code,status) VALUES($1,'CORE','ACTIVE')", [id]);
  await db.query("SELECT tenant_portal.provision_empty_tenant($1,$2)", [id, name]);
});
const scalar = (id, sql, params=[]) => withTenantContext(pool, { tenantId: id }, async (db) => Number((await db.query(sql, params)).rows[0].count));

try {
  await insertTenant(a, "Synthetic Tenant A");
  await insertTenant(b, "Synthetic Tenant B");
  for (const id of [a,b]) {
    for (const table of ["crm_accounts","csm_customers","blocks","employee_profiles","files","tasks","tender_workspaces"])
      if (await scalar(id, `SELECT count(*) FROM tenant_portal.${table}`) !== 0) throw new Error(`onboarding_not_empty_${table}`);
  }
  await withTenantContext(pool, { tenantId: a }, (db) => db.query("SELECT tenant_portal.enable_synthetic_demo($1)", [a]));
  if (await scalar(a,"SELECT count(*) FROM tenant_portal.crm_accounts WHERE synthetic") !== 1) throw new Error("demo_a_missing");
  if (await scalar(b,"SELECT count(*) FROM tenant_portal.crm_accounts") !== 0) throw new Error("demo_leaked_to_b");
  const csm = await withTenantContext(pool, { tenantId: a }, async (db) => (await db.query("INSERT INTO tenant_portal.csm_customers(tenant_id,name,health,status,lifecycle_stage) VALUES($1,'A Customer','GREEN','ACTIVE','ADOPTION') RETURNING id",[a])).rows[0]);
  const serviceCase = await withTenantContext(pool, { tenantId: a }, async (db) => (await db.query("INSERT INTO tenant_portal.csm_service_cases(tenant_id,customer_id,title) VALUES($1,$2,'A Case') RETURNING id",[a,csm.id])).rows[0]);
  if (await scalar(b,"SELECT count(*) FROM tenant_portal.csm_customers WHERE id=$1",[csm.id]) !== 0 || await scalar(b,"SELECT count(*) FROM tenant_portal.csm_service_cases WHERE id=$1",[serviceCase.id]) !== 0) throw new Error("csm_cross_tenant_read_allowed");
  const employee = await withTenantContext(pool, { tenantId: a }, async (db) => (await db.query("INSERT INTO tenant_portal.employee_profiles(tenant_id,display_name,employment_status,team_name) VALUES($1,'A Employee','ONBOARDING','A Team') RETURNING id",[a])).rows[0]);
  const onboarding = await withTenantContext(pool, { tenantId: a }, async (db) => (await db.query("INSERT INTO tenant_portal.people_onboarding_tasks(tenant_id,employee_id,title) VALUES($1,$2,'A Onboarding') RETURNING id",[a,employee.id])).rows[0]);
  if (await scalar(b,"SELECT count(*) FROM tenant_portal.employee_profiles WHERE id=$1",[employee.id]) !== 0 || await scalar(b,"SELECT count(*) FROM tenant_portal.people_onboarding_tasks WHERE id=$1",[onboarding.id]) !== 0) throw new Error("people_cross_tenant_read_allowed");
  const fileId=crypto.randomUUID();
  await withTenantContext(pool,{tenantId:a},(db)=>db.query("INSERT INTO tenant_portal.files(id,tenant_id,storage_key,filename,media_type,size_bytes,sha256) VALUES($1,$2,$3,'a.txt','text/plain',1,$4)",[fileId,a,`${a}/${fileId}`,crypto.createHash('sha256').update('a').digest('hex')]));
  if(await scalar(b,"SELECT count(*) FROM tenant_portal.files WHERE id=$1",[fileId])!==0)throw new Error("docs_cross_tenant_metadata_read_allowed");
  await withTenantContext(pool,{tenantId:b},async(db)=>{for(const statement of ["UPDATE tenant_portal.csm_customers SET name='stolen' WHERE id=$1","DELETE FROM tenant_portal.employee_profiles WHERE id=$1","DELETE FROM tenant_portal.files WHERE id=$1"]){const result=await db.query(statement,[statement.includes('csm_')?csm.id:statement.includes('employee_')?employee.id:fileId]);if(result.rowCount!==0)throw new Error('cross_tenant_mutation_allowed');}});
  const task = await withTenantContext(pool, { tenantId: a }, async (db) => (await db.query("INSERT INTO tenant_portal.tasks(tenant_id,title) VALUES($1,'A only') RETURNING id",[a])).rows[0]);
  if (await scalar(b,"SELECT count(*) FROM tenant_portal.tasks WHERE id=$1",[task.id]) !== 0) throw new Error("cross_tenant_read_allowed");
  await withTenantContext(pool, { tenantId: b }, async (db) => {
    let denied=false; try { await db.query("INSERT INTO tenant_portal.tasks(tenant_id,title) VALUES($1,'wrong tenant')",[a]); } catch { denied=true; }
    if (!denied) throw new Error("cross_tenant_write_allowed");
  });
  await withTenantContext(pool, { tenantId: a }, (db) => db.query("INSERT INTO saas.tenant_module_entitlements(tenant_id,module_key,enabled,source) VALUES($1,'crm',true,'DIRECT')", [a]));
  const crmA = await withTenantContext(pool, { tenantId: a }, async (db) => (await db.query("SELECT saas.module_entitled($1,'crm') allowed", [a])).rows[0].allowed);
  const crmB = await withTenantContext(pool, { tenantId: b }, async (db) => (await db.query("SELECT saas.module_entitled($1,'crm') allowed", [b])).rows[0].allowed);
  if (!crmA || crmB) throw new Error("tenant_module_entitlement_leak");
  const job = await withTenantContext(pool, { tenantId: a }, async (db) => (await db.query("INSERT INTO tenant_portal.jobs(tenant_id,module_key,job_type) VALUES($1,'crm','SYNTHETIC_TEST') RETURNING id", [a])).rows[0]);
  await withTenantContext(pool, { tenantId: a }, (db) => db.query("SELECT (tenant_portal.claim_module_job($1,$2)).id", [a, job.id]));
  const crossJob = await scalar(b, "SELECT count(*) FROM tenant_portal.jobs WHERE id=$1", [job.id]);
  if (crossJob !== 0) throw new Error("tenant_job_leak");
  await withTenantContext(pool, { tenantId: b }, (db) => db.query("SELECT saas.configure_commercial_entitlements($1,'MODULES',ARRAY['tender_autopilot'])", [b]));
  const dependency = await withTenantContext(pool, { tenantId: b }, async (db) => (await db.query(`SELECT
    saas.module_entitled($1,'tender_autopilot') autopilot,
    saas.module_entitled($1,'tender_scout') scout,
    saas.module_entitled($1,'docs') docs,
    saas.module_capability_allowed($1,'tender_autopilot','tender.public_discovery') discovery_capability,
    saas.module_capability_allowed($1,'tender_autopilot','docs.object_storage') docs_capability`, [b])).rows[0]);
  if (!dependency.autopilot || dependency.scout || dependency.docs || !dependency.discovery_capability || !dependency.docs_capability)
    throw new Error("hidden_dependency_contract_failed");
  await withTenantContext(pool, { tenantId: a }, (db) => db.query("SELECT saas.configure_commercial_entitlements($1,'SUITE','{}'::text[])", [a]));
  const suiteCount = await withTenantContext(pool, { tenantId: a }, async (db) => Number((await db.query("SELECT count(*) FROM saas.modules WHERE saas.module_entitled($1,module_key)", [a])).rows[0].count));
  if (suiteCount !== 10) throw new Error("suite_entitlement_incomplete");
  const revokedJob = await withTenantContext(pool, { tenantId: a }, async (db) => (await db.query("INSERT INTO tenant_portal.jobs(tenant_id,module_key,job_type) VALUES($1,'crm','REVOCATION_TEST') RETURNING id", [a])).rows[0]);
  await withTenantContext(pool, { tenantId: a }, (db) => db.query("UPDATE saas.tenant_module_entitlements SET enabled=false,updated_at=now() WHERE tenant_id=$1 AND module_key='crm'", [a]));
  const crmRevoked = await withTenantContext(pool, { tenantId: a }, async (db) => (await db.query("SELECT saas.module_entitled($1,'crm') allowed", [a])).rows[0].allowed);
  if (crmRevoked) throw new Error("suite_module_revocation_failed");
  await withTenantContext(pool, { tenantId: a }, async (db) => {
    let denied=false; try { await db.query("SELECT (tenant_portal.claim_module_job($1,$2)).id", [a, revokedJob.id]); } catch (error) { denied=/module_entitlement_required/.test(error.message); }
    if (!denied) throw new Error("revoked_job_claim_allowed");
  });
  await withTenantContext(pool, { tenantId: b }, (db) => db.query(`UPDATE saas.subscriptions SET status='TRIAL_ACTIVE',trial_started_at=now()-interval '15 days',trial_ends_at=now()-interval '1 day',trial_claimed_at=now()-interval '15 days' WHERE tenant_id=$1`, [b]));
  const expiredAccess = await withTenantContext(pool, { tenantId: b }, async (db) => (await db.query("SELECT saas.module_entitled($1,'tender_autopilot') allowed", [b])).rows[0].allowed);
  if (expiredAccess) throw new Error("expired_trial_module_allowed");
  for(const table of ["tasks","csm_customers","csm_service_cases","employee_profiles","people_onboarding_tasks","files"]){const missing=await pool.query(`SELECT count(*) FROM tenant_portal.${table}`);if(Number(missing.rows[0].count)!==0)throw new Error(`missing_context_did_not_fail_closed_${table}`);}
  console.log(JSON.stringify({passed:true,tenantA:a,tenantB:b,externalSubmissionEnabled:false}));
} finally {
  const admin=new pg.Pool({connectionString:adminUrl,max:1});
  for (const id of [a,b]) { await admin.query("DELETE FROM saas.audit_events WHERE tenant_id=$1",[id]).catch(()=>{}); await admin.query("DELETE FROM saas.tenants WHERE id=$1 AND slug LIKE 'test-%'",[id]).catch(()=>{}); }
  await admin.end();
  await pool.end();
}
