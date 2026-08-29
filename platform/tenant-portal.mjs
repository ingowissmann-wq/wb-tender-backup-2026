import { MODULE_CATALOG, MODULE_KEYS, normalizeModuleKey } from "./saas-catalog.mjs";
import { requireSaasJobModule, requireSaasModule } from "./saas-platform.mjs";
import { requireTenantContext, withTenantContext } from "./tenant-context.mjs";
import crypto from "node:crypto";
import { safeDownloadName, UnconfiguredTenantStorage } from "./tenant-storage.mjs";
import { UnconfiguredEmailAdapter } from "./saas-adapters.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bySlug = new Map(MODULE_CATALOG.flatMap((module) => [[module.slug, module.key], [module.key, module.key]]));

export const MODULE_ROUTE_CONTRACTS = Object.freeze({
  [MODULE_KEYS.TENDER_SCOUT]: { table: null, implementation: "PARTIAL_PUBLIC_DISCOVERY" },
  [MODULE_KEYS.TENDER_AUTOPILOT]: { table: "tender_workspaces", implementation: "PARTIAL_TENANT_FOUNDATION" },
  [MODULE_KEYS.CRM]: { table: "crm_accounts", implementation: "SECURE_EMPTY_SHELL" },
  [MODULE_KEYS.CSM]: { table: "csm_customers", implementation: "TENANT_OWNED" },
  [MODULE_KEYS.FLOW]: { table: "blocks", implementation: "SECURE_EMPTY_SHELL" },
  [MODULE_KEYS.PEOPLE]: { table: "employee_profiles", implementation: "TENANT_OWNED" },
  [MODULE_KEYS.DOCS]: { table: "files", implementation: "TENANT_OWNED_STORAGE" },
  [MODULE_KEYS.CONTROL]: { table: null, implementation: "TENANT_ADMIN" },
  [MODULE_KEYS.INSIGHTS]: { table: null, implementation: "SECURE_EMPTY_SHELL" },
  [MODULE_KEYS.CONNECT]: { table: null, implementation: "SECURE_EMPTY_SHELL" },
});

function requestedModule(req, reply) {
  const key = bySlug.get(String(req.params?.module || "").toLowerCase());
  if (!key) {
    reply.code(404).send({ error: "module_not_found" });
    return null;
  }
  return key;
}

const tenantGuard = async (req, reply) => requireTenantContext(req, reply);
const dynamicModuleGuard = async (req, reply) => {
  const key = requestedModule(req, reply);
  if (!key || reply.sent) return;
  req.moduleKey = key;
  return requireSaasModule(key)(req, reply);
};

export async function claimTenantModuleJob(pool, context, jobId, moduleKey) {
  if (!UUID.test(String(jobId || ""))) throw Object.assign(new Error("job_not_found"), { statusCode: 404 });
  const decision = requireSaasJobModule({ saas: context.saas }, normalizeModuleKey(moduleKey));
  if (!decision.allowed) throw Object.assign(new Error(decision.error), { statusCode: decision.statusCode, module: decision.module });
  return withTenantContext(pool, context.tenant, async (db) => {
    const result = await db.query("SELECT (tenant_portal.claim_module_job($1,$2)).*", [context.tenant.id, jobId]);
    return result.rows[0];
  });
}

const tenantAdmin = async (req, reply) => {
  if (!['OWNER','ADMIN'].includes(req.identity?.saas?.role)) return reply.code(403).send({ error: "tenant_admin_required" });
};
const tenantOwner = async (req, reply) => {
  if (req.identity?.saas?.role !== 'OWNER') return reply.code(403).send({ error: "tenant_owner_required" });
};
const cleanText = (value, max = 500) => String(value || "").trim().slice(0, max);
const html = (value) => String(value||"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const tenantAppJs = `const root=document.querySelector('[data-module]'),module=root.dataset.module,form=document.querySelector('form');async function load(){const q=new URLSearchParams(location.search).get('q')||'';const r=await fetch('/api/tenant-portal/modules/'+encodeURIComponent(module)+'?q='+encodeURIComponent(q));const data=await r.json();if(!r.ok)throw new Error(data.error||'Laden fehlgeschlagen');document.querySelector('#items').textContent=JSON.stringify(data.items,null,2)}load().catch(e=>document.querySelector('#items').textContent=e.message);form.addEventListener('submit',e=>{e.preventDefault();location.search=new URLSearchParams(new FormData(form))})`;

export function registerTenantPortalRoutes(app, { pool, authenticate, csrf, storage = new UnconfiguredTenantStorage(), invitationPepper = "", emailAdapter = new UnconfiguredEmailAdapter() }) {
  app.get("/saas/assets/tenant-app.js", {preHandler:[authenticate]}, async(_,reply)=>reply.type('text/javascript').send(tenantAppJs));
  app.get("/saas/app/:module", {preHandler:[authenticate,tenantGuard,dynamicModuleGuard]}, async(req,reply)=>{
    const metadata=MODULE_CATALOG.find((module)=>module.key===req.moduleKey);
    return reply.type('text/html').send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${html(metadata.name)}</title><link rel="stylesheet" href="/saas/assets/commercial.css"><script src="/saas/assets/tenant-app.js" defer></script></head><body><header><strong>WB Business Suite</strong><a href="/api/saas/navigation">Module</a></header><main class="panel" data-module="${html(req.moduleKey)}"><h1>${html(metadata.name)}</h1><form><label>Suche<input name="q" maxlength="120"></label><button>Suchen</button> <a href="/api/tenant-portal/modules/${encodeURIComponent(req.moduleKey)}/export">Export</a></form><pre id="items" aria-live="polite">Laden …</pre></main></body></html>`);
  });
  app.get("/api/tenant-portal/summary", { preHandler: [authenticate, tenantGuard, requireSaasModule(MODULE_KEYS.CONTROL)] }, async (req) =>
    withTenantContext(pool, req.tenant, async (db) => {
      const organization = (await db.query("SELECT id,display_name,legal_name,created_at,updated_at FROM tenant_portal.organizations WHERE tenant_id=$1", [req.tenant.id])).rows[0];
      const settings = (await db.query("SELECT demo_data_enabled,locale,timezone FROM tenant_portal.tenant_settings WHERE tenant_id=$1", [req.tenant.id])).rows[0];
      return { tenantId: req.tenant.id, organization, settings, modules: req.identity.saas.modules };
    }));

  app.get("/api/tenant-portal/modules/:module", { preHandler: [authenticate, tenantGuard, dynamicModuleGuard] }, async (req) => {
    const contract = MODULE_ROUTE_CONTRACTS[req.moduleKey];
    const metadata = MODULE_CATALOG.find((module) => module.key === req.moduleKey);
    if (req.moduleKey === MODULE_KEYS.TENDER_SCOUT) {
      const q = String(req.query?.q || "").slice(0, 120);
      const rows = await pool.query(`SELECT id,title,buyer,source_code,source_url,offer_deadline,regions,cpv_codes
        FROM tender.tenders WHERE data_class='PUBLIC_REAL' AND ($1='' OR search_document@@plainto_tsquery('german',$1))
        ORDER BY offer_deadline NULLS LAST LIMIT 100`, [q]);
      return { module: metadata, implementation: contract.implementation, items: rows.rows };
    }
    if (!contract.table) return { module: metadata, implementation: contract.implementation, items: [] };
    const search = String(req.query?.q || "").slice(0, 120);
    const items = await withTenantContext(pool, req.tenant, async (db) =>
      (await db.query(`SELECT to_jsonb(row_data)-'storage_key' item FROM tenant_portal.${contract.table} row_data
        WHERE ($1='' OR to_jsonb(row_data)::text ILIKE '%'||$1||'%') ORDER BY created_at DESC LIMIT 100`, [search])).rows.map((row) => row.item));
    return { module: metadata, implementation: contract.implementation, items };
  });

  app.get("/api/tenant-portal/modules/:module/export", { preHandler: [authenticate, tenantGuard, dynamicModuleGuard] }, async (req) => {
    const contract = MODULE_ROUTE_CONTRACTS[req.moduleKey];
    if (!contract.table) return { tenantId: req.tenant.id, module: req.moduleKey, implementation: contract.implementation, items: [], truncated: false };
    const rows = await withTenantContext(pool, req.tenant, async (db) =>
      (await db.query(`SELECT to_jsonb(row_data)-'storage_key' item FROM tenant_portal.${contract.table} row_data ORDER BY created_at,id LIMIT 10000`)).rows.map((row) => row.item));
    return { tenantId: req.tenant.id, module: req.moduleKey, implementation: contract.implementation, items: rows, truncated: rows.length === 10000 };
  });

  app.patch("/api/tenant-portal/modules/:module/:id", { preHandler: [authenticate,tenantGuard,dynamicModuleGuard,csrf] }, async (req,reply) => {
    if(!UUID.test(String(req.params.id||""))) return reply.code(404).send({error:"item_not_found"});
    let query,params;
    if(req.moduleKey===MODULE_KEYS.CSM){query=`UPDATE tenant_portal.csm_customers SET name=coalesce($3,name),health=coalesce($4,health),status=coalesce($5,status),lifecycle_stage=coalesce($6,lifecycle_stage),renewal_at=coalesce($7,renewal_at),follow_up_at=coalesce($8,follow_up_at),updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`;params=[req.tenant.id,req.params.id,cleanText(req.body?.name,160)||null,req.body?.health||null,req.body?.status||null,req.body?.lifecycleStage||null,req.body?.renewalAt||null,req.body?.followUpAt||null];}
    else if(req.moduleKey===MODULE_KEYS.PEOPLE){if(!['OWNER','ADMIN'].includes(req.identity.saas.role))return reply.code(403).send({error:'tenant_admin_required'});query=`UPDATE tenant_portal.employee_profiles SET display_name=coalesce($3,display_name),employment_status=coalesce($4,employment_status),job_title=coalesce($5,job_title),team_name=coalesce($6,team_name),phone=coalesce($7,phone),updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`;params=[req.tenant.id,req.params.id,cleanText(req.body?.displayName,160)||null,req.body?.employmentStatus||null,cleanText(req.body?.jobTitle,160)||null,cleanText(req.body?.teamName,160)||null,cleanText(req.body?.phone,60)||null];}
    else return reply.code(405).send({error:'module_item_update_not_supported'});
    const row=await withTenantContext(pool,req.tenant,async(db)=>{const item=(await db.query(query,params)).rows[0];if(item)await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id) VALUES($1,$2,'MODULE_ITEM_UPDATED',$3,$4)",[req.tenant.id,req.identity.userId,req.moduleKey,req.params.id]);return item;});
    return row||reply.code(404).send({error:'item_not_found'});
  });
  app.delete("/api/tenant-portal/modules/:module/:id", { preHandler: [authenticate,tenantGuard,dynamicModuleGuard,tenantAdmin,csrf] }, async (req,reply) => {
    if(!UUID.test(String(req.params.id||"")))return reply.code(404).send({error:'item_not_found'});
    const table=req.moduleKey===MODULE_KEYS.CSM?'csm_customers':req.moduleKey===MODULE_KEYS.PEOPLE?'employee_profiles':null;
    if(!table)return reply.code(405).send({error:'module_item_delete_not_supported'});
    const row=await withTenantContext(pool,req.tenant,async(db)=>{const item=(await db.query(`DELETE FROM tenant_portal.${table} WHERE tenant_id=$1 AND id=$2 RETURNING id`,[req.tenant.id,req.params.id])).rows[0];if(item)await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id) VALUES($1,$2,'MODULE_ITEM_DELETED',$3,$4)",[req.tenant.id,req.identity.userId,req.moduleKey,req.params.id]);return item;});
    if(!row)return reply.code(404).send({error:'item_not_found'});return reply.code(204).send();
  });

  app.get("/api/tenant-portal/modules/docs/files/:id/download", { preHandler: [authenticate, tenantGuard, requireSaasModule(MODULE_KEYS.DOCS)] }, async (req, reply) => {
    if (!UUID.test(String(req.params.id || ""))) return reply.code(404).send({ error: "file_not_found" });
    const file = await withTenantContext(pool, req.tenant, async (db) =>
      (await db.query("SELECT id,filename,media_type,size_bytes,sha256 FROM tenant_portal.files WHERE tenant_id=$1 AND id=$2", [req.tenant.id, req.params.id])).rows[0]);
    if (!file) return reply.code(404).send({ error: "file_not_found" });
    if (!storage.configured) return reply.code(503).send({ error: "tenant_storage_adapter_not_configured" });
    let bytes;
    try { bytes = await storage.get(req.tenant.id, file.id); } catch (error) { if (error.code === "ENOENT") return reply.code(404).send({ error: "file_object_missing" }); throw error; }
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== file.sha256) return reply.code(409).send({ error: "file_integrity_failed" });
    await withTenantContext(pool, req.tenant, (db) => db.query("INSERT INTO tenant_portal.storage_audit(tenant_id,file_id,action,actor_user_id) VALUES($1,$2,'DOWNLOAD',$3)", [req.tenant.id,file.id,req.identity.userId]));
    return reply.header("content-disposition", `attachment; filename="${safeDownloadName(file.filename)}"`).type(file.media_type).send(bytes);
  });

  app.post("/api/tenant-portal/modules/docs/files", { preHandler: [authenticate, tenantGuard, requireSaasModule(MODULE_KEYS.DOCS), csrf] }, async (req, reply) => {
    if (!storage.configured) return reply.code(503).send({ error: "tenant_storage_adapter_not_configured" });
    const filename = safeDownloadName(req.body?.filename), mediaType = cleanText(req.body?.mediaType || "application/octet-stream", 120);
    let bytes; try { bytes = Buffer.from(String(req.body?.contentBase64 || ""), "base64"); } catch { return reply.code(400).send({ error: "file_content_invalid" }); }
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) return reply.code(413).send({ error: "file_size_invalid" });
    const objectId = crypto.randomUUID(), stored = await storage.put(req.tenant.id, bytes, { objectId });
    try {
      const file = await withTenantContext(pool, req.tenant, async (db) => {
        const row = (await db.query("INSERT INTO tenant_portal.files(id,tenant_id,storage_key,filename,media_type,size_bytes,sha256,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,filename,media_type,size_bytes,sha256,created_at", [objectId,req.tenant.id,stored.storageKey,filename,mediaType,stored.sizeBytes,stored.sha256,req.identity.userId])).rows[0];
        await db.query("INSERT INTO tenant_portal.storage_audit(tenant_id,file_id,action,actor_user_id) VALUES($1,$2,'UPLOAD',$3)",[req.tenant.id,objectId,req.identity.userId]); return row;
      });
      return reply.code(201).send(file);
    } catch (error) { await storage.delete(req.tenant.id, objectId).catch(() => {}); throw error; }
  });

  app.delete("/api/tenant-portal/modules/docs/files/:id", { preHandler: [authenticate, tenantGuard, requireSaasModule(MODULE_KEYS.DOCS), csrf] }, async (req, reply) => {
    if (!UUID.test(String(req.params.id || ""))) return reply.code(404).send({ error: "file_not_found" });
    const removed = await withTenantContext(pool, req.tenant, async (db) => {
      const row = (await db.query("DELETE FROM tenant_portal.files WHERE tenant_id=$1 AND id=$2 RETURNING id",[req.tenant.id,req.params.id])).rows[0];
      if (row) await db.query("INSERT INTO tenant_portal.storage_audit(tenant_id,file_id,action,actor_user_id) VALUES($1,NULL,'DELETE',$2)",[req.tenant.id,req.identity.userId]); return row;
    });
    if (!removed) return reply.code(404).send({ error: "file_not_found" });
    if (storage.configured) await storage.delete(req.tenant.id, req.params.id);
    return reply.code(204).send();
  });

  app.post("/api/tenant-portal/csm/customers", { preHandler: [authenticate,tenantGuard,requireSaasModule(MODULE_KEYS.CSM),csrf] }, async (req,reply) => {
    const name=cleanText(req.body?.name,160); if(name.length<2) return reply.code(400).send({error:"customer_name_invalid"});
    const row=await withTenantContext(pool,req.tenant,async(db)=>{const item=(await db.query("INSERT INTO tenant_portal.csm_customers(tenant_id,name,health,status,lifecycle_stage,owner_user_id,renewal_at,follow_up_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",[req.tenant.id,name,req.body?.health||'UNASSESSED',req.body?.status||'ACTIVE',req.body?.lifecycleStage||'ONBOARDING',req.body?.ownerUserId||null,req.body?.renewalAt||null,req.body?.followUpAt||null,req.identity.userId])).rows[0];await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id) VALUES($1,$2,'CSM_CUSTOMER_CREATED','csm_customer',$3)",[req.tenant.id,req.identity.userId,item.id]);return item;});
    return reply.code(201).send(row);
  });
  app.post("/api/tenant-portal/csm/customers/:id/interactions", { preHandler: [authenticate,tenantGuard,requireSaasModule(MODULE_KEYS.CSM),csrf] }, async (req,reply) => {
    if(!UUID.test(String(req.params.id||""))) return reply.code(404).send({error:"customer_not_found"});
    const row=await withTenantContext(pool,req.tenant,async(db)=>(await db.query("INSERT INTO tenant_portal.csm_interactions(tenant_id,customer_id,interaction_type,subject,body,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[req.tenant.id,req.params.id,req.body?.type||'NOTE',cleanText(req.body?.subject,200),cleanText(req.body?.body,10000),req.identity.userId])).rows[0]); return reply.code(201).send(row);
  });
  app.post("/api/tenant-portal/csm/customers/:id/cases", { preHandler: [authenticate,tenantGuard,requireSaasModule(MODULE_KEYS.CSM),csrf] }, async (req,reply) => {
    if(!UUID.test(String(req.params.id||""))) return reply.code(404).send({error:"customer_not_found"});
    const row=await withTenantContext(pool,req.tenant,async(db)=>(await db.query("INSERT INTO tenant_portal.csm_service_cases(tenant_id,customer_id,title,description,priority,owner_user_id,due_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",[req.tenant.id,req.params.id,cleanText(req.body?.title,240),cleanText(req.body?.description,10000),req.body?.priority||'NORMAL',req.body?.ownerUserId||null,req.body?.dueAt||null,req.identity.userId])).rows[0]); return reply.code(201).send(row);
  });
  app.get("/api/tenant-portal/csm/customers/:id", { preHandler: [authenticate,tenantGuard,requireSaasModule(MODULE_KEYS.CSM)] }, async (req,reply) => {
    if(!UUID.test(String(req.params.id||"")))return reply.code(404).send({error:'customer_not_found'});
    const result=await withTenantContext(pool,req.tenant,async(db)=>{const customer=(await db.query("SELECT * FROM tenant_portal.csm_customers WHERE tenant_id=$1 AND id=$2",[req.tenant.id,req.params.id])).rows[0];if(!customer)return null;return{customer,interactions:(await db.query("SELECT * FROM tenant_portal.csm_interactions WHERE tenant_id=$1 AND customer_id=$2 ORDER BY occurred_at DESC",[req.tenant.id,req.params.id])).rows,cases:(await db.query("SELECT * FROM tenant_portal.csm_service_cases WHERE tenant_id=$1 AND customer_id=$2 ORDER BY created_at DESC",[req.tenant.id,req.params.id])).rows,tasks:(await db.query("SELECT * FROM tenant_portal.csm_tasks WHERE tenant_id=$1 AND customer_id=$2 ORDER BY created_at DESC",[req.tenant.id,req.params.id])).rows,contracts:(await db.query("SELECT * FROM tenant_portal.csm_contracts WHERE tenant_id=$1 AND customer_id=$2 ORDER BY created_at DESC",[req.tenant.id,req.params.id])).rows,onboarding:(await db.query("SELECT * FROM tenant_portal.csm_onboarding_plans WHERE tenant_id=$1 AND customer_id=$2 ORDER BY created_at DESC",[req.tenant.id,req.params.id])).rows,healthHistory:(await db.query("SELECT * FROM tenant_portal.csm_health_assessments WHERE tenant_id=$1 AND customer_id=$2 ORDER BY assessed_at DESC",[req.tenant.id,req.params.id])).rows};});
    return result||reply.code(404).send({error:'customer_not_found'});
  });
  const csmCustomerWrite = [authenticate,tenantGuard,requireSaasModule(MODULE_KEYS.CSM),csrf];
  app.post("/api/tenant-portal/csm/customers/:id/contracts", {preHandler:csmCustomerWrite}, async(req,reply)=>{
    if(!UUID.test(String(req.params.id||"")))return reply.code(404).send({error:"customer_not_found"});
    const reference=cleanText(req.body?.contractReference,160);if(!reference)return reply.code(400).send({error:"contract_reference_required"});
    const row=await withTenantContext(pool,req.tenant,async(db)=>(await db.query(`INSERT INTO tenant_portal.csm_contracts(tenant_id,customer_id,contract_reference,status,starts_on,ends_on,renewal_notice_on,metadata,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[req.tenant.id,req.params.id,reference,req.body?.status||'DRAFT',req.body?.startsOn||null,req.body?.endsOn||null,req.body?.renewalNoticeOn||null,req.body?.metadata||{},req.identity.userId])).rows[0]);return reply.code(201).send(row);
  });
  app.post("/api/tenant-portal/csm/customers/:id/onboarding", {preHandler:csmCustomerWrite}, async(req,reply)=>{
    if(!UUID.test(String(req.params.id||"")))return reply.code(404).send({error:"customer_not_found"});const title=cleanText(req.body?.title,240);if(!title)return reply.code(400).send({error:"onboarding_title_required"});
    const row=await withTenantContext(pool,req.tenant,async(db)=>(await db.query("INSERT INTO tenant_portal.csm_onboarding_plans(tenant_id,customer_id,title,status,target_date,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[req.tenant.id,req.params.id,title,req.body?.status||'PLANNED',req.body?.targetDate||null,req.identity.userId])).rows[0]);return reply.code(201).send(row);
  });
  app.post("/api/tenant-portal/csm/customers/:id/health", {preHandler:csmCustomerWrite}, async(req,reply)=>{
    if(!UUID.test(String(req.params.id||""))||!["UNASSESSED","GREEN","AMBER","RED"].includes(req.body?.health))return reply.code(400).send({error:"health_assessment_invalid"});
    const row=await withTenantContext(pool,req.tenant,async(db)=>{const assessment=(await db.query("INSERT INTO tenant_portal.csm_health_assessments(tenant_id,customer_id,health,score,evidence,assessed_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[req.tenant.id,req.params.id,req.body.health,req.body?.score??null,req.body?.evidence||{},req.identity.userId])).rows[0];await db.query("UPDATE tenant_portal.csm_customers SET health=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",[req.tenant.id,req.params.id,req.body.health]);return assessment;});return reply.code(201).send(row);
  });
  app.post("/api/tenant-portal/csm/customers/:id/tasks", {preHandler:csmCustomerWrite}, async(req,reply)=>{
    if(!UUID.test(String(req.params.id||"")))return reply.code(404).send({error:"customer_not_found"});const title=cleanText(req.body?.title,240);if(!title)return reply.code(400).send({error:"task_title_required"});
    const row=await withTenantContext(pool,req.tenant,async(db)=>(await db.query("INSERT INTO tenant_portal.csm_tasks(tenant_id,customer_id,case_id,title,assignee_user_id,due_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",[req.tenant.id,req.params.id,req.body?.caseId||null,title,req.body?.assigneeUserId||null,req.body?.dueAt||null,req.identity.userId])).rows[0]);return reply.code(201).send(row);
  });
  app.post("/api/tenant-portal/csm/playbooks", {preHandler:csmCustomerWrite}, async(req,reply)=>{
    const name=cleanText(req.body?.name,200);if(!name)return reply.code(400).send({error:"playbook_name_required"});
    const row=await withTenantContext(pool,req.tenant,async(db)=>{const playbook=(await db.query("INSERT INTO tenant_portal.csm_playbooks(tenant_id,name,status,trigger_health,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *",[req.tenant.id,name,req.body?.status||'DRAFT',req.body?.triggerHealth||null,req.identity.userId])).rows[0];for(const [index,step] of (req.body?.steps||[]).entries())await db.query("INSERT INTO tenant_portal.csm_playbook_steps(tenant_id,playbook_id,position,title,due_offset_days) VALUES($1,$2,$3,$4,$5)",[req.tenant.id,playbook.id,index+1,cleanText(step?.title,240),Number(step?.dueOffsetDays||0)]);return playbook;});return reply.code(201).send(row);
  });
  app.get("/api/tenant-portal/csm/reports", {preHandler:[authenticate,tenantGuard,requireSaasModule(MODULE_KEYS.CSM)]}, async(req)=>withTenantContext(pool,req.tenant,async(db)=>({items:(await db.query("SELECT id,report_type,period_start,period_end,payload,sha256,generated_at FROM tenant_portal.csm_report_snapshots WHERE tenant_id=$1 ORDER BY generated_at DESC LIMIT 100",[req.tenant.id])).rows})));
  app.post("/api/tenant-portal/csm/reports", {preHandler:csmCustomerWrite}, async(req,reply)=>{
    const reportType=cleanText(req.body?.reportType,80).toUpperCase();if(!/^[A-Z][A-Z0-9_]{2,79}$/.test(reportType))return reply.code(400).send({error:"report_type_invalid"});
    const payload=await withTenantContext(pool,req.tenant,async(db)=>{const counts=(await db.query(`SELECT (SELECT count(*) FROM tenant_portal.csm_customers WHERE tenant_id=$1) customers,(SELECT count(*) FROM tenant_portal.csm_service_cases WHERE tenant_id=$1 AND status NOT IN('RESOLVED','CLOSED')) open_tickets,(SELECT count(*) FROM tenant_portal.csm_tasks WHERE tenant_id=$1 AND status='OPEN') open_tasks`,[req.tenant.id])).rows[0];return{reportType,periodStart:req.body?.periodStart||null,periodEnd:req.body?.periodEnd||null,counts,generatedAt:new Date().toISOString()};});
    const serialized=JSON.stringify(payload),sha256=crypto.createHash('sha256').update(serialized).digest('hex');const row=await withTenantContext(pool,req.tenant,async(db)=>(await db.query("INSERT INTO tenant_portal.csm_report_snapshots(tenant_id,report_type,period_start,period_end,payload,sha256,generated_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,report_type,sha256) DO UPDATE SET sha256=excluded.sha256 RETURNING id,report_type,payload,sha256,generated_at",[req.tenant.id,reportType,req.body?.periodStart||null,req.body?.periodEnd||null,payload,sha256,req.identity.userId])).rows[0]);return reply.code(201).send(row);
  });

  app.post("/api/tenant-portal/people/employees", { preHandler: [authenticate,tenantGuard,requireSaasModule(MODULE_KEYS.PEOPLE),tenantAdmin,csrf] }, async (req,reply) => {
    const name=cleanText(req.body?.displayName,160); if(name.length<2) return reply.code(400).send({error:"employee_name_invalid"});
    const row=await withTenantContext(pool,req.tenant,async(db)=>(await db.query("INSERT INTO tenant_portal.employee_profiles(tenant_id,user_id,display_name,work_email,personal_email,phone,employee_number,employment_status,job_title,team_name,start_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",[req.tenant.id,req.body?.userId||null,name,cleanText(req.body?.workEmail,254)||null,cleanText(req.body?.personalEmail,254)||null,cleanText(req.body?.phone,60)||null,cleanText(req.body?.employeeNumber,80)||null,req.body?.employmentStatus||'ONBOARDING',cleanText(req.body?.jobTitle,160)||null,cleanText(req.body?.teamName,160)||null,req.body?.startDate||null])).rows[0]); return reply.code(201).send(row);
  });
  app.post("/api/tenant-portal/people/employees/:id/onboarding", { preHandler: [authenticate,tenantGuard,requireSaasModule(MODULE_KEYS.PEOPLE),tenantAdmin,csrf] }, async (req,reply) => {
    if(!UUID.test(String(req.params.id||""))) return reply.code(404).send({error:"employee_not_found"});
    const row=await withTenantContext(pool,req.tenant,async(db)=>(await db.query("INSERT INTO tenant_portal.people_onboarding_tasks(tenant_id,employee_id,title,assignee_user_id,due_at,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[req.tenant.id,req.params.id,cleanText(req.body?.title,240),req.body?.assigneeUserId||null,req.body?.dueAt||null,req.identity.userId])).rows[0]); return reply.code(201).send(row);
  });

  app.get("/api/tenant-portal/control/members", { preHandler: [authenticate,tenantGuard,requireSaasModule(MODULE_KEYS.CONTROL),tenantAdmin] }, async (req) => withTenantContext(pool,req.tenant,async(db)=>({items:(await db.query("SELECT m.user_id,m.role,m.status,m.created_at,u.email FROM saas.tenant_memberships m JOIN iam.users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY m.created_at",[req.tenant.id])).rows})));
  app.post("/api/tenant-portal/control/invitations", { preHandler: [authenticate,tenantGuard,requireSaasModule(MODULE_KEYS.CONTROL),tenantAdmin,csrf] }, async (req,reply) => {
    if(!invitationPepper || invitationPepper.length<32 || !emailAdapter.configured) return reply.code(503).send({error:"invitation_delivery_not_configured"});
    const email=cleanText(req.body?.email,254).toLowerCase(),role=req.body?.role||'MEMBER',token=crypto.randomBytes(32).toString('base64url'),hash=crypto.createHmac('sha256',invitationPepper).update(token).digest('hex');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!['ADMIN','MEMBER','BILLING'].includes(role)) return reply.code(400).send({error:"invitation_invalid"});
    const tenantContext={tenantId:req.tenant.id,actorUserId:req.identity.userId};
    const item=await withTenantContext(pool,tenantContext,async(db)=>(await db.query("INSERT INTO saas.tenant_invitations(tenant_id,email,role,token_hash,expires_at,invited_by) VALUES($1,$2,$3,$4,now()+interval '72 hours',$5) RETURNING id,email,role,status,expires_at",[req.tenant.id,email,role,hash,req.identity.userId])).rows[0]);
    try {
      await emailAdapter.sendInvitation({ email, tenantId:req.tenant.id, token, role });
      return reply.code(201).send({...item,delivery:'QUEUED'});
    } catch {
      await withTenantContext(pool,tenantContext,(db)=>db.query("DELETE FROM saas.tenant_invitations WHERE tenant_id=$1 AND id=$2 AND status='PENDING'",[req.tenant.id,item.id]));
      req.log.warn({code:'saas_invitation_delivery_failed'},'SaaS invitation delivery failed');
      return reply.code(503).send({error:'invitation_delivery_failed'});
    }
  });
  app.patch("/api/tenant-portal/control/members/:userId", { preHandler: [authenticate,tenantGuard,requireSaasModule(MODULE_KEYS.CONTROL),tenantOwner,csrf] }, async (req,reply) => {
    if(!UUID.test(String(req.params.userId||""))||req.params.userId===req.identity.userId) return reply.code(409).send({error:"membership_change_invalid"});
    const role=req.body?.role,status=req.body?.status;if(!['ADMIN','MEMBER','BILLING'].includes(role)||!['ACTIVE','SUSPENDED'].includes(status)) return reply.code(400).send({error:"membership_change_invalid"});
    const row=await withTenantContext(pool,req.tenant,async(db)=>(await db.query("UPDATE saas.tenant_memberships SET role=$3,status=$4 WHERE tenant_id=$1 AND user_id=$2 AND role<>'OWNER' RETURNING user_id,role,status",[req.tenant.id,req.params.userId,role,status])).rows[0]);
    if(!row)return reply.code(404).send({error:"membership_not_found"});return row;
  });

  app.post("/api/tenant-portal/modules/:module/jobs", { preHandler: [authenticate, tenantGuard, dynamicModuleGuard, csrf] }, async (req, reply) => {
    const jobType = String(req.body?.jobType || "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(jobType)) return reply.code(400).send({ error: "job_type_invalid" });
    const job = await withTenantContext(pool, req.tenant, async (db) =>
      (await db.query("INSERT INTO tenant_portal.jobs(tenant_id,module_key,job_type,payload,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id,module_key,job_type,status,created_at", [req.tenant.id, req.moduleKey, jobType, req.body?.payload || {}, req.identity.userId])).rows[0]);
    return reply.code(201).send(job);
  });

  app.post("/api/tenant-portal/demo-data/enable", { preHandler: [authenticate, tenantGuard, requireSaasModule(MODULE_KEYS.CONTROL), csrf] }, async (req, reply) => {
    if (req.body?.confirmation !== "ENABLE_SYNTHETIC_DEMO_DATA") return reply.code(422).send({ error: "explicit_demo_confirmation_required" });
    await withTenantContext(pool, req.tenant, (db) => db.query("SELECT tenant_portal.enable_synthetic_demo($1)", [req.tenant.id]));
    return reply.code(201).send({ enabled: true, syntheticOnly: true });
  });
}
