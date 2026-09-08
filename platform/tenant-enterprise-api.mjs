import {withTenantContext,validTenantId,requireTenantContext} from './tenant-context.mjs';
import {requireSaasModule} from './saas-platform.mjs';
import {MODULE_KEYS} from './saas-catalog.mjs';
const resources=Object.freeze({
 companies:{table:'saas.tenant_companies',columns:'id,display_name,status,created_at'},
 'lot-assignments':{table:'tenant_portal.lot_assignment_versions',columns:'id,workspace_id,source_version_id,lot_key,version,assignment_kind,company_id,profile_id,snapshot_sha256,created_at'},
 calculations:{table:'tenant_portal.lot_calculation_versions',columns:'id,assignment_id,version,status,result,created_at'},
 'offer-packages':{table:'tenant_portal.offer_packages',columns:'id,calculation_id,document_review_id,version,manifest_sha256,created_at'},
});
export const ENTERPRISE_API_RESOURCES=Object.freeze(Object.keys(resources));
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
export function enterprisePage(query={}){
 const limit=query.limit==null?50:Number(query.limit),cursor=query.cursor==null?null:String(query.cursor);
 if(!Number.isInteger(limit)||limit<1||limit>100||cursor&&!validTenantId(cursor))throw fail('api_pagination_invalid');
 return {limit,cursor};
}
export async function enterpriseRecords(pool,context,resource,query={}){
 const spec=Object.hasOwn(resources,resource)?resources[resource]:null;if(!spec)throw fail('api_resource_not_found',404);const {limit,cursor}=enterprisePage(query);
 return withTenantContext(pool,context,async db=>{
  const rows=(await db.query(`SELECT ${spec.columns} FROM ${spec.table} WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3`,[context.id,cursor,limit+1])).rows;
  const more=rows.length>limit,items=rows.slice(0,limit);
  await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,metadata) VALUES($1,$2,'ENTERPRISE_API_READ',$3,$4)",[context.id,context.actorUserId,resource,{count:items.length,limit,cursor,readOnly:true}]);
  return {apiVersion:'1',tenantId:context.id,resource,items,nextCursor:more?items.at(-1).id:null,readOnly:true,currentReadinessAssessed:false};
 });
}
export function registerTenantEnterpriseApi(app,{pool,authenticate}){
 const guards=[authenticate,async(req,reply)=>requireTenantContext(req,reply),requireSaasModule(MODULE_KEYS.CONNECT),async(req,reply)=>{if(!['OWNER','ADMIN'].includes(req.identity?.saas?.role))return reply.code(403).send({error:'tenant_admin_required'});}];
 app.get('/api/enterprise/v1/:resource',{preHandler:guards},async(req,reply)=>{reply.header('Cache-Control','no-store');try{return await enterpriseRecords(pool,req.tenant,req.params.resource,req.query);}catch(error){return reply.code(error.statusCode||503).send({error:error.statusCode?error.message:'enterprise_api_temporarily_unavailable'});}});
 app.get('/saas/assets/connect.js',{preHandler:[authenticate]},async(_,r)=>r.type('text/javascript').send(script));
 app.get('/saas/app/connect',{preHandler:guards},async(_,r)=>r.header('Cache-Control','no-store').type('text/html').send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Enterprise-API · WB-Tender</title><link rel="stylesheet" href="/saas/assets/commercial.css"><script src="/saas/assets/connect.js" defer></script></head><body><main class="panel"><h1>Enterprise-API</h1><p>Lesender Zugriff auf eigene Gesellschaften, Loszuordnungen, Kalkulationsversionen und Angebotspakete. Die Anmeldung erfolgt mit Passwort und Authenticator über die bestehende Sitzung. Nur Eigentümer und Administratoren können diese Schnittstelle nutzen.</p><form><label>Datenbestand<select name="resource">${ENTERPRISE_API_RESOURCES.map(key=>`<option value="${key}">${key}</option>`).join('')}</select></label><button>Datensätze laden</button></form><button id="next" hidden>Nächste Seite</button><p id="status" role="status"></p><pre id="result"></pre><p>Endpunkt: <code>/api/enterprise/v1/{resource}?limit=50</code>. Höchstens 100 Datensätze pro Seite; für die nächste Seite wird <code>nextCursor</code> als <code>cursor</code> übergeben. Die Datensätze sind gespeicherte Versionen. Sie bestätigen keine aktuelle Abgabefreigabe. Neue Datensätze während eines Abrufs können eine erneute vollständige Abfrage erfordern.</p><p>Diese API sendet keine Angebote und verändert keine Geschäftsdaten. Individuelle externe Anbindungen und Single Sign-on benötigen eine separat eingerichtete und validierte Gegenstelle; derzeit ist die native Anmeldung aktiv.</p><a href="/saas/app/management">Management</a> · <a href="/saas/app/control">Benutzerverwaltung</a></main></body></html>`));
}
const script=`const form=document.querySelector('form'),next=document.querySelector('#next'),status=document.querySelector('#status'),result=document.querySelector('#result');let cursor=null,resource='companies';async function load(){const response=await fetch('/api/enterprise/v1/'+resource+'?limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):'')),data=await response.json();if(!response.ok)throw Error(data.error);result.textContent=JSON.stringify(data,null,2);cursor=data.nextCursor;next.hidden=!cursor;status.textContent=data.items.length+' Datensätze geladen.';}form.addEventListener('submit',e=>{e.preventDefault();resource=new FormData(form).get('resource');cursor=null;load().catch(e=>status.textContent=e.message);});next.addEventListener('click',()=>load().catch(e=>status.textContent=e.message));load().catch(e=>status.textContent=e.message);`;
