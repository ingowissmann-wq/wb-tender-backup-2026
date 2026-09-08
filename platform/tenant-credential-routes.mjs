import { requireTenantContext, withTenantContext, validTenantId } from './tenant-context.mjs';
import { requireSaasModule } from './saas-platform.mjs';
import { MODULE_KEYS } from './saas-catalog.mjs';
import { TenantCredentialVault } from './tenant-credential-vault.mjs';

export function registerTenantCredentialRoutes(app,{pool,authenticate,csrf,keyringFile}) {
  const vault=new TenantCredentialVault({pool,keyringFile});
  const admin=async(req,reply)=>{
    if (!['OWNER','ADMIN'].includes(req.identity?.saas?.role)) return reply.code(403).send({error:'tenant_admin_required'});
  };
  const guards=[authenticate,async(req,reply)=>requireTenantContext(req,reply),requireSaasModule(MODULE_KEYS.TENDER_AUTOPILOT),admin];
  const safe=fn=>async(req,reply)=>{
    reply.header('Cache-Control','no-store');
    try { return await fn(req,reply); }
    catch(error) {
      const code=error.code==='23505'?'credential_already_exists':error.message;
      const known=/^(portal_credential_|credential_|company_not_found$|portal_not_found$)/.test(code);
      return reply.code(error.code==='23505'?409:known?(error.statusCode||503):503).send({error:known?code:'portal_credential_operation_failed'});
    }
  };
  app.get('/api/tenant-portal/credential-options',{preHandler:guards},safe(async(req)=>withTenantContext(pool,req.tenant,async(db)=>({
    companies:(await db.query("SELECT id,display_name FROM saas.tenant_companies WHERE tenant_id=$1 AND status='ACTIVE' ORDER BY display_name,id",[req.tenant.id])).rows,
    portals:(await db.query('SELECT id,display_name,canonical_domain FROM tender.portal_registry ORDER BY display_name,id')).rows
  }))));
  const path='/api/tenant-portal/companies/:companyId/credentials';
  app.get(path,{preHandler:guards},safe(req=>vault.list(req.tenant,req.params.companyId)));
  const save=async(req,reply)=>{
    const body=req.body||{};
    if (!validTenantId(req.params.companyId)) return reply.code(404).send({error:'company_not_found'});
    return vault.save(req.tenant,{id:req.params.id,companyId:req.params.companyId,portalId:body.portalId,label:body.label,username:body.username,password:body.password,expectedRevision:body.expectedRevision});
  };
  app.post(path,{preHandler:[...guards,csrf],bodyLimit:16384},safe(save));
  app.put(path+'/:id',{preHandler:[...guards,csrf],bodyLimit:16384},safe(save));
  app.post(path+'/:id/rotate',{preHandler:[...guards,csrf],bodyLimit:1024},safe(req=>vault.rotate(req.tenant,req.params.companyId,req.params.id,req.body?.expectedRevision)));
  app.get('/saas/app/portal-access',{preHandler:guards},async(_,reply)=>reply.header('Cache-Control','no-store').type('text/html').send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Portalzugänge · WB-Tender</title><link rel="stylesheet" href="/saas/assets/commercial.css"><script src="/saas/assets/portal-access.js" defer></script></head><body><main class="panel"><h1>Portalzugänge</h1><p>Gespeicherte Passwörter werden nicht angezeigt. Eine erfolgreiche Speicherung bestätigt noch keine Anmeldung am Vergabeportal.</p><form id="credential-form"><label>Gesellschaft<select name="companyId" required></select></label><label>Vergabeportal<select name="portalId" required></select></label><label>Bezeichnung<input name="label" maxlength="120" required></label><label>Portalbenutzer<input name="username" autocomplete="off" maxlength="320" required></label><label>Portalpasswort<input name="password" type="password" autocomplete="new-password" maxlength="4096" required></label><button>Verschlüsselt speichern</button><button type="reset">Neuen Zugang erfassen</button></form><p id="result" role="status"></p><ul id="credentials"></ul><a href="/saas/app/tender-autopilot">Zurück zum Ausschreibungsportal</a></main></body></html>`));
  app.get('/saas/assets/portal-access.js',{preHandler:[authenticate]},async(_,reply)=>reply.type('text/javascript').send(portalAccessJs));
}

const portalAccessJs=`const form=document.querySelector('#credential-form'),result=document.querySelector('#result'),list=document.querySelector('#credentials');
async function request(url,options){const response=await fetch(url,options);const data=await response.json();if(!response.ok)throw new Error(data.error||'Anfrage fehlgeschlagen');return data}
async function load(){list.replaceChildren();if(!form.elements.companyId.value)return;for(const item of await request('/api/tenant-portal/companies/'+encodeURIComponent(form.elements.companyId.value)+'/credentials')){const row=document.createElement('li');row.textContent=item.label+' · Zugang gespeichert · Version '+item.revision+' ';const edit=document.createElement('button');edit.type='button';edit.textContent='Ändern';edit.addEventListener('click',()=>{form.dataset.id=item.id;form.dataset.revision=item.revision;form.elements.portalId.value=item.portal_id;form.elements.portalId.disabled=true;form.elements.label.value=item.label;form.elements.username.value='';form.elements.password.value='';result.textContent='Aktuelle Zugangsdaten erneut eingeben. Gespeicherte Passwörter werden nicht zurückgesendet.'});row.append(edit);list.append(row)}}
async function start(){const data=await request('/api/tenant-portal/credential-options');for(const [field,items] of [['companyId',data.companies],['portalId',data.portals]])for(const item of items){const option=document.createElement('option');option.value=item.id;option.textContent=item.display_name+(item.canonical_domain?' ('+item.canonical_domain+')':'');form.elements[field].append(option)}await load()}
function clearEdit(){delete form.dataset.id;delete form.dataset.revision;form.elements.portalId.disabled=false;form.elements.username.value='';form.elements.password.value=''}
form.addEventListener('reset',()=>{clearEdit();setTimeout(()=>load().catch(e=>result.textContent=e.message),0)});
form.elements.companyId.addEventListener('change',()=>{clearEdit();load().catch(e=>result.textContent=e.message)});
form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;try{const csrf=document.cookie.split('; ').find(value=>value.startsWith('wb_csrf='))?.slice(8);if(!csrf)throw new Error('Sitzung bitte neu anmelden');const body=Object.fromEntries(new FormData(form));body.portalId=form.elements.portalId.value;body.expectedRevision=form.dataset.id?Number(form.dataset.revision):undefined;await request('/api/tenant-portal/companies/'+encodeURIComponent(body.companyId)+'/credentials'+(form.dataset.id?'/'+encodeURIComponent(form.dataset.id):''),{method:form.dataset.id?'PUT':'POST',headers:{'Content-Type':'application/json','x-csrf-token':decodeURIComponent(csrf)},body:JSON.stringify(body)});clearEdit();result.textContent='Zugang verschlüsselt gespeichert und zurückgelesen.';await load()}catch(error){result.textContent=error.message}finally{form.elements.password.value='';form.elements.username.value='';button.disabled=false}});start().catch(error=>result.textContent=error.message);`;
