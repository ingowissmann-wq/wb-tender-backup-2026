import crypto from 'node:crypto';
import {withTenantContext,validTenantId} from './tenant-context.mjs';
import {snapshotHash} from './canonical-truth.mjs';
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const text=(value,min,max)=>{if(typeof value!=='string'||value.trim().length<min||value.length>max)throw fail('csm_text_invalid');return value.trim();};
const choice=(value,options)=>{if(!options.includes(value))throw fail('csm_status_invalid');return value;};
const member=value=>{if(value==null||value==='')return null;if(!validTenantId(value))throw fail('active_tenant_member_required');return value;};
const date=value=>{if(value==null||value==='')return null;if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw fail('csm_date_invalid');return value;};
export function csmInput(kind,body,{update=false}={}){
 const id=body.id||crypto.randomUUID();if(!validTenantId(id))throw fail('csm_id_invalid');let input={id};
 if(kind==='customer')input={...input,name:text(body.name,2,160),health:choice(body.health||'UNASSESSED',['UNASSESSED','GREEN','AMBER','RED']),status:choice(body.status||'ACTIVE',['ACTIVE','AT_RISK','PAUSED','CHURNED']),lifecycleStage:choice(body.lifecycleStage||'ONBOARDING',['ONBOARDING','ADOPTION','VALUE','RENEWAL','EXPANSION','CHURNED']),ownerUserId:member(body.ownerUserId),renewalAt:date(body.renewalAt),followUpAt:date(body.followUpAt)};
 else if(kind==='case')input={...input,customerId:body.customerId,title:text(body.title,2,240),description:text(body.description||'',0,10000),priority:choice(body.priority||'NORMAL',['LOW','NORMAL','HIGH','URGENT']),status:choice(body.status||'OPEN',['OPEN','IN_PROGRESS','WAITING','RESOLVED','CLOSED']),ownerUserId:member(body.ownerUserId),dueAt:date(body.dueAt)};
 else if(kind==='interaction')input={...input,customerId:body.customerId,type:choice(body.type||'NOTE',['NOTE','CALL','EMAIL','MEETING','REVIEW']),subject:text(body.subject,2,200),body:text(body.body||'',0,10000)};
 else throw fail('csm_kind_invalid');
 if(kind!=='customer'&&!validTenantId(input.customerId))throw fail('customer_not_found',404);
 if(!update&&kind==='case'&&input.status!=='OPEN')throw fail('csm_new_case_must_be_open');
 if(update){if(!/^\d{1,10}$/.test(String(body.expectedRevision||''))||body.confirmed!==true)throw fail('csm_revision_confirmation_required');input.expectedRevision=String(body.expectedRevision);input.reason=text(body.reason,10,1000);}
 return input;
}
const tables={customer:'csm_customers',case:'csm_service_cases',interaction:'csm_interactions'};
export class TenantCsm{
 constructor(pool){this.pool=pool;}
 async list(context,search=''){return withTenantContext(this.pool,context,async db=>({items:(await db.query("SELECT c.*,c.xmin::text revision,(SELECT count(*)::int FROM tenant_portal.csm_service_cases sc WHERE sc.tenant_id=c.tenant_id AND sc.customer_id=c.id AND sc.status NOT IN('RESOLVED','CLOSED')) open_cases FROM tenant_portal.csm_customers c WHERE c.tenant_id=$1 AND ($2='' OR c.name ILIKE '%'||$2||'%') ORDER BY c.name,c.id LIMIT 501",[context.id,String(search).slice(0,120)])).rows}));}
 async detail(context,id){if(!validTenantId(id))throw fail('customer_not_found',404);return withTenantContext(this.pool,context,async db=>{const customer=(await db.query('SELECT *,xmin::text revision FROM tenant_portal.csm_customers WHERE tenant_id=$1 AND id=$2',[context.id,id])).rows[0];if(!customer)throw fail('customer_not_found',404);return{customer,interactions:(await db.query('SELECT * FROM tenant_portal.csm_interactions WHERE tenant_id=$1 AND customer_id=$2 ORDER BY occurred_at DESC,id LIMIT 501',[context.id,id])).rows,cases:(await db.query("SELECT *,xmin::text revision,(due_at<now() AND status NOT IN('RESOLVED','CLOSED')) overdue FROM tenant_portal.csm_service_cases WHERE tenant_id=$1 AND customer_id=$2 ORDER BY created_at DESC,id LIMIT 501",[context.id,id])).rows};});}
 async save(context,kind,body,{update=false}={}){
  const input=csmInput(kind,body,{update}),table=tables[kind],action='CSM_'+kind.toUpperCase()+(update?'_UPDATED':'_CREATED');
  return withTenantContext(this.pool,context,async db=>{
   if(input.ownerUserId&&!(await db.query("SELECT user_id FROM saas.tenant_memberships WHERE tenant_id=$1 AND user_id=$2 AND status='ACTIVE' FOR SHARE",[context.id,input.ownerUserId])).rows.length)throw fail('active_tenant_member_required');
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended('csm:'||$1::text||':'||$2::text,0))",[context.id,input.id]);
   const old=(await db.query(`SELECT *,xmin::text revision FROM tenant_portal.${table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[context.id,input.id])).rows[0];
   if(!update&&old){const audit=(await db.query('SELECT metadata FROM saas.audit_events WHERE tenant_id=$1 AND target_id=$2 AND action=$3 ORDER BY occurred_at,id LIMIT 1',[context.id,input.id,action])).rows[0];if(audit?.metadata?.requestSha256!==snapshotHash(input))throw fail('csm_request_conflict',409);return{item:old,idempotent:true};}
   if(update){if(!old)throw fail('csm_item_not_found',404);if(old.revision!==input.expectedRevision)throw fail('csm_version_conflict',409);if(kind==='interaction')throw fail('csm_interaction_immutable',409);}
   if(kind!=='customer'){if(old&&old.customer_id!==input.customerId)throw fail('csm_customer_binding_immutable',409);if(!(await db.query('SELECT id FROM tenant_portal.csm_customers WHERE tenant_id=$1 AND id=$2 FOR SHARE',[context.id,input.customerId])).rowCount)throw fail('customer_not_found',404);}
   if(update&&kind==='case'){
    const transitions={OPEN:['OPEN','IN_PROGRESS','WAITING','RESOLVED'],IN_PROGRESS:['IN_PROGRESS','WAITING','RESOLVED'],WAITING:['WAITING','IN_PROGRESS','RESOLVED'],RESOLVED:['RESOLVED','CLOSED','IN_PROGRESS'],CLOSED:['CLOSED','IN_PROGRESS']};
    if(!transitions[old.status]?.includes(input.status))throw fail('csm_case_transition_invalid',409);
   }
   let columns,values;
   if(kind==='customer'){columns=['name','health','status','lifecycle_stage','owner_user_id','renewal_at','follow_up_at'];values=[input.name,input.health,input.status,input.lifecycleStage,input.ownerUserId,input.renewalAt,input.followUpAt];}
   else if(kind==='case'){columns=['title','description','priority','status','owner_user_id','due_at'];values=[input.title,input.description,input.priority,input.status,input.ownerUserId,input.dueAt?input.dueAt+'T23:59:59.999Z':null];}
   else{columns=['interaction_type','subject','body'];values=[input.type,input.subject,input.body];}
   let sql;if(update)sql=`UPDATE tenant_portal.${table} SET ${columns.map((column,i)=>column+'=$'+(i+3)).join(',')},updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *,xmin::text revision`;
   else{if(kind!=='customer'){columns.push('customer_id');values.push(input.customerId);}columns.push('created_by');values.push(context.actorUserId);sql=`INSERT INTO tenant_portal.${table}(tenant_id,id,${columns.join(',')}) VALUES(${[context.id,input.id,...values].map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *,xmin::text revision`;}
   const item=(await db.query(sql,[context.id,input.id,...values])).rows[0];
   await db.query('INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[context.id,context.actorUserId,action,'csm_'+kind,input.id,{requestSha256:snapshotHash(input),previousStatus:old?.status??null,status:item.status??null,reason:input.reason??null,customerId:input.customerId??null}]);
   return{item,idempotent:false};
  });
 }
}
export async function csmReply(reply,operation){try{return await operation();}catch(error){return reply.code(error.statusCode||503).send({error:error.statusCode?error.message:'csm_temporarily_unavailable'});}}
