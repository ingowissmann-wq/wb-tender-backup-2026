import {TenantWorkflowTasks} from './tenant-workflow-tasks.mjs';
import {tenantInsights} from './tenant-insights.mjs';
import { dispatchTenantJob } from './tenant-job-dispatch.mjs';
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
  [MODULE_KEYS.FLOW]: { table: null, implementation: "VERSIONED_TENANT_TASKS" },
  [MODULE_KEYS.PEOPLE]: { table: "employee_profiles", implementation: "TENANT_OWNED" },
  [MODULE_KEYS.DOCS]: { table: "files", implementation: "TENANT_OWNED_STORAGE" },
  [MODULE_KEYS.CONTROL]: { table: null, implementation: "TENANT_ADMIN" },
  [MODULE_KEYS.INSIGHTS]: { table: null, implementation: "TENANT_OPERATIONAL_REPORTING" },
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
    const result = await db.query("SELECT * FROM tenant_portal.claim_module_job($1,$2)", [context.tenant.id, jobId]);
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
// Keep the membership locked until the enclosing tenant transaction commits.
async function activeMember(db, tenantId, userId) {
  if (userId === undefined || userId === null || userId === '') return null;
  if (!UUID.test(String(userId))) throw Object.assign(new Error('active_tenant_member_required'), {statusCode: 400});
  const member = (await db.query("SELECT user_id FROM saas.tenant_memberships WHERE tenant_id=$1 AND user_id=$2 AND status='ACTIVE' FOR SHARE", [tenantId, userId])).rows[0];
  if (!member) throw Object.assign(new Error('active_tenant_member_required'), {statusCode: 400});
  return member.user_id;
}

const html = (value) => String(value||"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const tenantAppJs = `const root=document.querySelector('[data-module]'),module=root.dataset.module,form=document.querySelector('form');async function load(){const q=new URLSearchParams(location.search).get('q')||'';const r=await fetch('/api/tenant-portal/modules/'+encodeURIComponent(module)+'?q='+encodeURIComponent(q));const data=await r.json();if(!r.ok)throw new Error(data.error||'Laden fehlgeschlagen');document.querySelector('#items').textContent=JSON.stringify(data.items,null,2)}load().catch(e=>document.querySelector('#items').textContent=e.message);form.addEventListener('submit',e=>{e.preventDefault();location.search=new URLSearchParams(new FormData(form))})`;

const companyAppJs = `const form=document.querySelector('form'),status=document.querySelector('#status'),list=document.querySelector('#companies');async function load(){const response=await fetch('/api/tenant-portal/companies');const data=await response.json();if(!response.ok)throw new Error(data.error);list.replaceChildren();for(const item of data.items){const row=document.createElement('li');row.textContent=item.display_name+' · '+item.status;list.append(row)}document.querySelector('#usage').textContent=data.activeCount+' aktive Gesellschaften · Paketgrenze: '+(data.limit===null?'unbegrenzt':data.limit)}form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;try{const token=decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('wb_csrf='))?.slice(8)||'');form.dataset.requestId||=crypto.randomUUID();const response=await fetch('/api/tenant-portal/companies',{method:'POST',headers:{'Content-Type':'application/json','x-csrf-token':token},body:JSON.stringify({id:form.dataset.requestId,displayName:form.elements.displayName.value})});const data=await response.json();if(!response.ok)throw new Error(data.error==='saas_plan_limit_exceeded'?'Die Gesellschaftsgrenze Ihres Pakets ist erreicht.':data.error);delete form.dataset.requestId;form.reset();status.textContent='Gesellschaft angelegt.';await load()}catch(error){status.textContent=error.message}finally{button.disabled=false}});load().catch(error=>status.textContent=error.message);`;

export function registerTenantPortalRoutes(app, { pool, authenticate, csrf, storage = new UnconfiguredTenantStorage(), invitationPepper = "", emailAdapter = new UnconfiguredEmailAdapter() }) {
  app.get('/saas/app/companies',{preHandler:[authenticate,tenantGuard,requireSaasModule(MODULE_KEYS.CONTROL),tenantAdmin]},async(_,reply)=>reply.header('Cache-Control','no-store').type('text/html').send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gesellschaften · WB-Tender</title><link rel="stylesheet" href="/saas/assets/commercial.css"><script src="/saas/assets/companies.js" defer></script></head><body><main class="panel"><h1>Gesellschaften</h1><p id="usage"></p><ul id="companies"></ul><form><label>Unternehmensname<input name="displayName" minlength="2" maxlength="160" required></label><button>Gesellschaft anlegen</button></form><p id="status" role="status"></p><a href="/saas/app/company-profiles">Leistungs- und Kalkulationsgrundlagen</a> · <a href="/saas/app/portal-access">Portalzugänge verwalten</a> · <a href="/saas/account">Paket verwalten</a> · <a href="/saas/app/tender-scout">Ausschreibungen</a></main></body></html>`));
  app.get('/saas/assets/companies.js',{preHandler:[authenticate]},async(_,reply)=>reply.type('text/javascript').send(companyAppJs));
  app.get('/api/tenant-portal/companies',{preHandler:[authenticate,tenantGuard,requireSaasModule(MODULE_KEYS.CONTROL),tenantAdmin]},async(req,reply)=>{
    reply.header('Cache-Control','no-store');
    return withTenantContext(pool,req.tenant,async(db)=>{
      const items=(await db.query('SELECT id,display_name,status,created_at FROM saas.tenant_companies WHERE tenant_id=$1 ORDER BY created_at,id',[req.tenant.id])).rows;
      const plan=(await db.query('SELECT p.company_limit FROM saas.subscriptions s JOIN saas.plans p ON p.code=s.plan_code WHERE s.tenant_id=$1',[req.tenant.id])).rows[0];
      return {items,activeCount:items.filter(item=>item.status==='ACTIVE').length,limit:plan?.company_limit??null};
    });
  });
  app.post('/api/tenant-portal/companies',{preHandler:[authenticate,tenantGuard,requireSaasModule(MODULE_KEYS.CONTROL),tenantAdmin,csrf],bodyLimit:2048},async(req,reply)=>{
    const name=typeof req.body?.displayName==='string'?req.body.displayName.trim():'';
    const id=req.body?.id;
    if(!UUID.test(String(id||''))||name.length<2||name.length>160)return reply.code(400).send({error:'company_input_invalid'});
    try{
      const result=await withTenantContext(pool,req.tenant,async(db)=>{
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended('saas-plan:'||$1::text,0))",[req.tenant.id]);
        const previous=(await db.query('SELECT id,display_name,status,created_at FROM saas.tenant_companies WHERE tenant_id=$1 AND id=$2',[req.tenant.id,id])).rows[0];
        if(previous){if(previous.display_name!==name)throw new Error('company_request_conflict');return {item:previous,idempotent:true};}
        const item=(await db.query("INSERT INTO saas.tenant_companies(id,tenant_id,display_name,status) VALUES($1,$2,$3,'ACTIVE') ON CONFLICT(id) DO NOTHING RETURNING id,display_name,status,created_at",[id,req.tenant.id,name])).rows[0];
        if(!item)throw new Error('company_request_conflict');
        await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id) VALUES($1,$2,'TENANT_COMPANY_CREATED','tenant_company',$3)",[req.tenant.id,req.identity.userId,id]);
        return {item,idempotent:false};
      });
      return reply.header('Cache-Control','no-store').code(result.idempotent?200:201).send(result);
    }catch(error){if(['saas_plan_limit_exceeded','company_request_conflict'].includes(error.message))return reply.code(409).send({error:error.message});throw error;}
  });
  app.get("/saas/assets/tenant-app.js", {preHandler:[authenticate]}, async(_,reply)=>reply.type('text/javascript').send(tenantAppJs));
  app.get("/saas/app/:module", {preHandler:[authenticate,tenantGuard,dynamicModuleGuard]}, async(req,reply)=>{
    if(req.moduleKey===MODULE_KEYS.FLOW)return reply.redirect('/saas/app/workflow');
    const metadata=MODULE_CATALOG.find((module)=>module.key===req.moduleKey);
    return reply.type('text/html').send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${html(metadata.name)}</title><link rel="stylesheet" href="/saas/assets/commercial.css"><script src="/saas/assets/tenant-app.js" defer></script></head><body><header><strong>WB Business Suite</strong><a href="/saas/app/companies">Gesellschaften</a><a href="/saas/app/workflow">Aufgaben</a><a href="/saas/app/lot-assignments">Lose bearbeiten</a><a href="/saas/app/management">Management</a>${req.identity.saas.modules?.includes(MODULE_KEYS.INSIGHTS)?'<a href="/saas/app/insights">Auswertungen</a>':''}<a href="/saas/app/portal-access">Portalzugänge</a><a href="/saas/account">Mein Paket</a></header><main class="panel" data-module="${html(req.moduleKey)}"><h1>${html(metadata.name)}</h1><form><label>Suche<input name="q" maxlength="120"></label><button>Suchen</button> <a href="/api/tenant-portal/modules/${encodeURIComponent(req.moduleKey)}/export">Export</a></form><pre id="items" aria-live="polite">Laden …</pre></main></body></html>`);
  });
  app.get("/api/tenant-portal/summary", { preHandler: [authenticate, tenantGuard, requireSaasModule(MODULE_KEYS.CONTROL)] }, async (req) =>
    withTenantContext(pool, req.tenant, async (db) => {
      const organization = (await db.query("SELECT id,display_name,legal_name,created_at,updated_at FROM tenant_portal.organizations WHERE tenant_id=$1", [req.tenant.id])).rows[0];
      const settings = (await db.query("SELECT demo_data_enabled,locale,timezone FROM tenant_portal.tenant_settings WHERE tenant_id=$1", [req.tenant.id])).rows[0];
      return { tenantId: req.tenant.id, organization, settings, modules: req.identity.saas.modules };
    }));

  app.get("/api/tenant-portal/modules/:module", { preHandler: [authenticate, tenantGuard, dynamicModuleGuard] }, async (req,reply) => {
    const contract = MODULE_ROUTE_CONTRACTS[req.moduleKey];
    const metadata = MODULE_CATALOG.find((module) => module.key === req.moduleKey);
    if (req.moduleKey === MODULE_KEYS.TENDER_SCOUT) {
      const q = String(req.query?.q || "").slice(0, 120);
      const rows = await pool.query(`SELECT id,title,buyer,source_code,source_url,offer_deadline,regions,cpv_codes
        FROM tender.tenders WHERE data_class='PUBLIC_REAL' AND ($1='' OR search_document@@plainto_tsquery('german',$1))
        ORDER BY offer_deadline NULLS LAST LIMIT 100`, [q]);
      return { module: metadata, implementation: contract.implementation, items: rows.rows };
    }
    if(req.moduleKey===MODULE_KEYS.FLOW){if(!['OWNER','ADMIN'].includes(req.identity?.saas?.role))return reply.code(403).send({error:'tenant_admin_required'});return new TenantWorkflowTasks(pool).list(req.tenant)}
    if(req.moduleKey===MODULE_KEYS.INSIGHTS){if(!['OWNER','ADMIN'].includes(req.identity?.saas?.role))return reply.code(403).send({error:'tenant_admin_required'});reply.header('Cache-Control','no-store');try{return await tenantInsights(pool,req.tenant)}catch{return reply.code(503).send({error:'insights_temporarily_unavailable'})}}
    if (!contract.table) return { module: metadata, implementation: contract.implementation, items: [] };
    const search = String(req.query?.q || "").slice(0, 120);
    const items = await withTenantContext(pool, req.tenant, async (db) =>
      (await db.query(`SELECT to_jsonb(row_data)-'storage_key' item FROM tenant_portal.${contract.table} row_data
        WHERE ($1='' OR to_jsonb(row_data)::text ILIKE '%'||$1||'%') ORDER BY created_at DESC LIMIT 100`, [search])).rows.map((row) => row.item));
    return { module: metadata, implementation: contract.implementation, items };
  });

  app.get("/api/tenant-portal/modules/:module/export", { preHandler: [authenticate, tenantGuard, dynamicModuleGuard] }, async (req,reply) => {
    const contract = MODULE_ROUTE_CONTRACTS[req.moduleKey];
    if(req.moduleKey===MODULE_KEYS.FLOW){if(!['OWNER','ADMIN'].includes(req.identity?.saas?.role))return reply.code(403).send({error:'tenant_admin_required'});return new TenantWorkflowTasks(pool).list(req.tenant)}
    if(req.moduleKey===MODULE_KEYS.INSIGHTS){if(!['OWNER','ADMIN'].includes(req.identity?.saas?.role))return reply.code(403).send({error:'tenant_admin_required'});reply.header('Cache-Control','no-store');try{return await tenantInsights(pool,req.tenant,{auditExport:true})}catch{return reply.code(503).send({error:'insights_temporarily_unavailable'})}}
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

  app.post("/api/tenant-portal/modules/docs/files", { preHandler: [authenticate, tenantGuard, requireSaasModule(MODULE_KEYS.DOCS), csrf], bodyLimit: 14*1024*1024 }, async (req, reply) => {
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
    let removed;
    try { removed = await withTenantContext(pool, req.tenant, async (db) => {
      const row = (await db.query("DELETE FROM tenant_portal.files WHERE tenant_id=$1 AND id=$2 RETURNING id",[req.tenant.id,req.params.id])).rows[0];
      if (row) await db.query("INSERT INTO tenant_portal.storage_audit(tenant_id,file_id,action,actor_user_id) VALUES($1,NULL,'DELETE',$2)",[req.tenant.id,req.identity.userId]); return row;
    }); } catch(error) { if(error.code==='23503')return reply.code(409).send({error:'file_required_by_history'});throw error; }
    if (!removed) return reply.code(404).send({ error: "file_not_found" });
    if (storage.configured) await storage.delete(req.tenant.id, req.params.id);
    return reply.code(204).send();
  });

  app.post("/api/tenant-portal/csm/customers", { preHandler: [authenticate,tenantGuard,requireSaasModule(MODULE_KEYS.CSM),csrf] }, async (req,reply) => {
    const name=cleanText(req.body?.name,160); if(name.length<2) return reply.code(400).send({error:"customer_name_invalid"});
    const row=await withTenantContext(pool,req.tenant,async(db)=>{const item=(await db.query("INSERT INTO tenant_portal.csm_customers(tenant_id,name,health,status,lifecycle_stage,owner_user_id,renewal_at,follow_up_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",[req.tenant.id,name,req.body?.health||'UNASSESSED',req.body?.status||'ACTIVE',req.body?.lifecycleStage||'ONBOARDING',await activeMember(db,req.tenant.id,req.body?.ownerUserId),req.body?.renewalAt||null,req.body?.followUpAt||null,req.identity.userId])).rows[0];await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id) VALUES($1,$2,'CSM_CUSTOMER_CREATED','csm_customer',$3)",[req.tenant.id,req.identity.userId,item.id]);return item;});
    return reply.code(201).send(row);
  });
  app.post("/api/tenant-portal/csm/customers/:id/interactions", { preHandler: [authenticate,tenantGuard,requireSaasModule(MODULE_KEYS.CSM),csrf] }, async (req,reply) => {
    if(!UUID.test(String(req.params.id||""))) return reply.code(404).send({error:"customer_not_found"});
    const row=await withTenantContext(pool,req.tenant,async(db)=>(await db.query("INSERT INTO tenant_portal.csm_interactions(tenant_id,customer_id,interaction_type,subject,body,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[req.tenant.id,req.params.id,req.body?.type||'NOTE',cleanText(req.body?.subject,200),cleanText(req.body?.body,10000),req.identity.userId])).rows[0]); return reply.code(201).send(row);
  });
  app.post("/api/tenant-portal/csm/customers/:id/cases", { preHandler: [authenticate,tenantGuard,requireSaasModule(MODULE_KEYS.CSM),csrf] }, async (req,reply) => {
    if(!UUID.test(String(req.params.id||""))) return reply.code(404).send({error:"customer_not_found"});
    const row=await withTenantContext(pool,req.tenant,async(db)=>(await db.query("INSERT INTO tenant_portal.csm_service_cases(tenant_id,customer_id,title,description,priority,owner_user_id,due_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",[req.tenant.id,req.params.id,cleanText(req.body?.title,240),cleanText(req.body?.description,10000),req.body?.priority||'NORMAL',await activeMember(db,req.tenant.id,req.body?.ownerUserId),req.body?.dueAt||null,req.identity.userId])).rows[0]); return reply.code(201).send(row);
  });
  app.get("/api/tenant-portal/csm/customers/:id", { preHandler: [authenticate,tenantGuard,requireSaasModule(MODULE_KEYS.CSM)] }, async (req,reply) => {
    if(!UUID.test(String(req.params.id||"")))return reply.code(404).send({error:'customer_not_found'});
    const result=await withTenantContext(pool,req.tenant,async(db)=>{const customer=(await db.query("SELECT * FROM tenant_portal.csm_customers WHERE tenant_id=$1 AND id=$2",[req.tenant.id,req.params.id])).rows[0];if(!customer)return null;return{customer,interactions:(await db.query("SELECT * FROM tenant_portal.csm_interactions WHERE tenant_id=$1 AND customer_id=$2 ORDER BY occurred_at DESC",[req.tenant.id,req.params.id])).rows,cases:(await db.query("SELECT * FROM tenant_portal.csm_service_cases WHERE tenant_id=$1 AND customer_id=$2 ORDER BY created_at DESC",[req.tenant.id,req.params.id])).rows,tasks:(await db.query("SELECT * FROM tenant_portal.csm_tasks WHERE tenant_id=$1 AND customer_id=$2 ORDER BY created_at DESC",[req.tenant.id,req.params.id])).rows};});
    return result||reply.code(404).send({error:'customer_not_found'});
  });

  app.post("/api/tenant-portal/people/employees", { preHandler: [authenticate,tenantGuard,requireSaasModule(MODULE_KEYS.PEOPLE),tenantAdmin,csrf] }, async (req,reply) => {
    const name=cleanText(req.body?.displayName,160); if(name.length<2) return reply.code(400).send({error:"employee_name_invalid"});
    const row=await withTenantContext(pool,req.tenant,async(db)=>(await db.query("INSERT INTO tenant_portal.employee_profiles(tenant_id,user_id,display_name,work_email,personal_email,phone,employee_number,employment_status,job_title,team_name,start_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",[req.tenant.id,await activeMember(db,req.tenant.id,req.body?.userId),name,cleanText(req.body?.workEmail,254)||null,cleanText(req.body?.personalEmail,254)||null,cleanText(req.body?.phone,60)||null,cleanText(req.body?.employeeNumber,80)||null,req.body?.employmentStatus||'ONBOARDING',cleanText(req.body?.jobTitle,160)||null,cleanText(req.body?.teamName,160)||null,req.body?.startDate||null])).rows[0]); return reply.code(201).send(row);
  });
  app.post("/api/tenant-portal/people/employees/:id/onboarding", { preHandler: [authenticate,tenantGuard,requireSaasModule(MODULE_KEYS.PEOPLE),tenantAdmin,csrf] }, async (req,reply) => {
    if(!UUID.test(String(req.params.id||""))) return reply.code(404).send({error:"employee_not_found"});
    const row=await withTenantContext(pool,req.tenant,async(db)=>(await db.query("INSERT INTO tenant_portal.people_onboarding_tasks(tenant_id,employee_id,title,assignee_user_id,due_at,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[req.tenant.id,req.params.id,cleanText(req.body?.title,240),await activeMember(db,req.tenant.id,req.body?.assigneeUserId),req.body?.dueAt||null,req.identity.userId])).rows[0]); return reply.code(201).send(row);
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

  app.post("/api/tenant-portal/modules/:module/jobs", { preHandler: [authenticate, tenantGuard, dynamicModuleGuard, tenantAdmin, csrf], bodyLimit:32768 }, async (req, reply) => {
    const jobType = String(req.body?.jobType || "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(jobType)) return reply.code(400).send({ error: "job_type_invalid" });
    try {
      const job=await dispatchTenantJob({pool,storage,context:req.tenant,moduleKey:req.moduleKey,jobType,payload:req.body?.payload});
      return reply.header('Cache-Control','no-store').code(job.status==='FAILED'?422:200).send(job);
    } catch(error) {
      const known=/^(job_type_|calculation_|document_review_|saas_monthly_tender_limit_exceeded)/.test(error.message);
      return reply.code(known?(error.statusCode||409):503).send({error:known?error.message:'tenant_job_failed'});
    }
  });
  app.get('/api/tenant-portal/modules/:module/jobs/:id',{preHandler:[authenticate,tenantGuard,dynamicModuleGuard]},async(req,reply)=>{
    if(!UUID.test(String(req.params.id||'')))return reply.code(404).send({error:'job_not_found'});
    const job=await withTenantContext(pool,req.tenant,async db=>(await db.query('SELECT id,module_key,job_type,status,created_at,claimed_at FROM tenant_portal.jobs WHERE tenant_id=$1 AND module_key=$2 AND id=$3',[req.tenant.id,req.moduleKey,req.params.id])).rows[0]);
    return job?reply.header('Cache-Control','no-store').send(job):reply.code(404).send({error:'job_not_found'});
  });

  app.post("/api/tenant-portal/demo-data/enable", { preHandler: [authenticate, tenantGuard, requireSaasModule(MODULE_KEYS.CONTROL), csrf] }, async (req, reply) => {
    if (req.body?.confirmation !== "ENABLE_SYNTHETIC_DEMO_DATA") return reply.code(422).send({ error: "explicit_demo_confirmation_required" });
    await withTenantContext(pool, req.tenant, (db) => db.query("SELECT tenant_portal.enable_synthetic_demo($1)", [req.tenant.id]));
    return reply.code(201).send({ enabled: true, syntheticOnly: true });
  });
}
