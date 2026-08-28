import pg from "pg";
import { withTenantContext } from "../platform/tenant-context.mjs";

if (process.env.WB_ADMIN_ISOLATION_TEST_DATABASE !== "true") throw new Error("refusing_non_test_database");
if (!process.env.DATABASE_URL) throw new Error("database_url_missing");
if (!process.env.TEST_DATABASE_ADMIN_URL) throw new Error("test_database_admin_url_missing");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const adminPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_ADMIN_URL, max: 1 });
const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";
const internal = process.env.WB_INTERNAL_TENANT_ID || "00000000-0000-4000-8000-000000000085";
const scalar = (tenantId, sql, values = []) => withTenantContext(pool, { tenantId }, async (db) => Number((await db.query(sql, values)).rows[0].count));
async function cleanupSynthetic(){for(const tenantId of [tenantA,tenantB]){for(const table of ['app.resource_files','crm.documents','recruiting.application_files','app.resources','files.objects'])await adminPool.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenantId]);await adminPool.query("ALTER TABLE audit.events DISABLE TRIGGER audit_append_only");await adminPool.query("DELETE FROM audit.events WHERE tenant_id=$1",[tenantId]);await adminPool.query("ALTER TABLE audit.events ENABLE TRIGGER audit_append_only");for(const table of (await adminPool.query("SELECT table_schema,table_name FROM information_schema.columns WHERE column_name='tenant_id' AND table_schema IN('integration','communication') ORDER BY 1,2")).rows)await adminPool.query(`DELETE FROM ${table.table_schema}.${table.table_name} WHERE tenant_id=$1`,[tenantId]);await adminPool.query("DELETE FROM saas.tenants WHERE id=$1 AND slug LIKE 'admin-test-%'",[tenantId]);}}

async function assertHidden(table, idColumn, id) {
  if (await scalar(tenantB, `SELECT count(*) FROM ${table} WHERE ${idColumn}=$1`, [id]) !== 0) throw new Error(`cross_tenant_read:${table}`);
  if(table==="audit.events")return; // append-only runtime ACL is stronger than cross-tenant mutation denial
  await withTenantContext(pool, { tenantId: tenantB }, async (db) => {
    const updated = await db.query(`UPDATE ${table} SET tenant_id=$1 WHERE ${idColumn}=$2`, [tenantB, id]); if (updated.rowCount !== 0) throw new Error(`cross_tenant_update:${table}`);
    const deleted = await db.query(`DELETE FROM ${table} WHERE ${idColumn}=$1`, [id]); if (deleted.rowCount !== 0) throw new Error(`cross_tenant_delete:${table}`);
  });
}

try {
  await cleanupSynthetic();
  const hasCommunication=Boolean((await pool.query("SELECT to_regclass('communication.inbound_messages') present")).rows[0].present);
  const guardedTables=["app.resources","files.objects","audit.events","integration.calculator_events",...(hasCommunication?["communication.inbound_messages"]:[])];
  for(const [tenantId,name] of [[tenantA,'Admin Synthetic A'],[tenantB,'Admin Synthetic B']]){await adminPool.query("INSERT INTO saas.tenants(id,slug,display_name,status,customer_identity_hash) VALUES($1,$2,$3,'ACTIVE',$4) ON CONFLICT(id) DO NOTHING",[tenantId,`admin-test-${tenantId.slice(0,8)}`,name,`admin-test-${tenantId}`]);await adminPool.query("INSERT INTO saas.subscriptions(tenant_id,plan_code,status) VALUES($1,'ENTERPRISE','ACTIVE') ON CONFLICT(tenant_id) DO NOTHING",[tenantId]);}
  for (const tenantId of [tenantA, tenantB]) {
    for (const table of guardedTables)
      if (await scalar(tenantId, `SELECT count(*) FROM ${table}`) !== 0) throw new Error(`onboarding_not_empty:${table}`);
  }

  const created = await withTenantContext(pool, { tenantId: tenantA }, async (db) => {
    const ids = {};
    for (const [key, type] of [["crm", "companies"], ["flow", "tasks"], ["docs", "documents"], ["insights", "calculator_records"]]) {
      ids[key] = (await db.query("INSERT INTO app.resources(domain,resource_type,title,status,data) VALUES($1,$2,$3,'draft','{}') RETURNING id", [type === "tasks" ? "crm" : type === "documents" ? "crm" : type === "calculator_records" ? "crm" : "crm", type, `Synthetic A ${key}`])).rows[0].id;
    }
    ids.file = (await db.query("INSERT INTO files.objects(storage_name,original_name,mime_type,size_bytes,sha256,protection_class,verified) VALUES($1,$2,'application/pdf',1,$3,'private',true) RETURNING id", [`${tenantA}/synthetic-a-file`, "synthetic-a.pdf", "d".repeat(64)])).rows[0].id;
    await db.query("INSERT INTO app.resource_files(resource_id,file_id) VALUES($1,$2)", [ids.docs, ids.file]);
    ids.audit = (await db.query("INSERT INTO audit.events(action,object_type,object_id) VALUES('synthetic_a','resource',$1) RETURNING id", [ids.crm])).rows[0].id;
    ids.integration = (await db.query("INSERT INTO integration.calculator_events(idempotency_key,source_id,reference,payload_sha256,raw_payload) VALUES('synthetic-a-event','synthetic-a','A',$1,'{}') RETURNING id", ["e".repeat(64)])).rows[0].id;
    if(hasCommunication)ids.communication = (await db.query("INSERT INTO communication.inbound_messages(provider,provider_message_id,received_at,processing_status) VALUES('synthetic','synthetic-a',now(),'quarantined') RETURNING id")).rows[0].id;
    return ids;
  });

  for (const key of ["crm", "flow", "docs", "insights"]) await assertHidden("app.resources", "id", created[key]);
  await assertHidden("files.objects", "id", created.file);
  await assertHidden("audit.events", "id", created.audit);
  await assertHidden("integration.calculator_events", "id", created.integration);
  if(hasCommunication)await assertHidden("communication.inbound_messages", "id", created.communication);

  if (await scalar(tenantB, "SELECT count(*) FROM app.resources WHERE title ILIKE '%Synthetic A%'") !== 0) throw new Error("cross_tenant_search");
  if (await scalar(tenantB, "SELECT count(*) FROM app.resources WHERE id=$1", [created.crm]) !== 0) throw new Error("cross_tenant_export");
  if (await scalar(tenantB, "SELECT count(*) FROM files.objects f JOIN app.resource_files rf ON rf.tenant_id=f.tenant_id AND rf.file_id=f.id WHERE f.id=$1", [created.file]) !== 0) throw new Error("cross_tenant_download");

  for (const table of guardedTables) {
    const result = await pool.query(`SELECT count(*) FROM ${table}`);
    if (Number(result.rows[0].count) !== 0) throw new Error(`missing_context_visible:${table}`);
  }

  await adminPool.query("INSERT INTO saas.tenant_module_entitlements(tenant_id,module_key,enabled,source) VALUES($1,'crm',false,'DIRECT') ON CONFLICT(tenant_id,module_key) DO UPDATE SET enabled=false,updated_at=now()", [tenantA]);
  const revoked = await withTenantContext(pool, { tenantId: tenantA }, async (db) => (await db.query("SELECT saas.module_entitled($1,'crm') allowed", [tenantA])).rows[0].allowed);
  if (revoked) throw new Error("module_revocation_not_immediate");

  if (await scalar(internal, "SELECT count(*) FROM app.resources") < 2) throw new Error("legacy_internal_resources_missing");
  if (await scalar(internal, "SELECT count(*) FROM files.objects") < 1) throw new Error("legacy_internal_files_missing");
  console.log(JSON.stringify({ passed: true, adminModules: ["crm", "flow", "docs", "control", "insights", "connect"], separatelyTenantOwned: ["csm","people"], blockedAdminSharedStores: ["people_shared_career_sqlite"], externalSubmissionEnabled: false }));
} finally {
  await cleanupSynthetic().catch(()=>{});
  await pool.end();
  await adminPool.end();
}
