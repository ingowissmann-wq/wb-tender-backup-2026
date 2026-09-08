import {withTenantContext,validTenantId} from './tenant-context.mjs';
import {snapshotHash} from './canonical-truth.mjs';
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
export const CRM_STAGES=Object.freeze(['PROSPECT','QUALIFIED','PROPOSAL','CUSTOMER','LOST']);
export function crmInput(kind,body,{update=false}={}){
 if(!body||!validTenantId(body.id)||typeof body.name!=='string'||body.name.trim().length<2||body.name.length>200)throw fail('crm_input_invalid');
 const result={id:body.id,name:body.name.trim()};
 if(kind==='account'){if(!CRM_STAGES.includes(body.stage))throw fail('crm_stage_invalid');result.stage=body.stage;}
 else if(kind==='contact'){if(!validTenantId(body.accountId))throw fail('crm_account_required');const email=body.email==null||body.email===''?null:String(body.email).trim().toLowerCase();if(email&&(email.length>254||! /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)))throw fail('crm_email_invalid');Object.assign(result,{accountId:body.accountId,email});}
 else throw fail('crm_entity_invalid');
 if(update){if(!/^\d{1,10}$/.test(String(body.expectedRevision||''))||typeof body.reason!=='string'||body.reason.trim().length<10||body.reason.length>1000)throw fail('crm_revision_and_reason_required');Object.assign(result,{expectedRevision:String(body.expectedRevision),reason:body.reason.trim()});}
 return result;
}
const tables={account:'crm_accounts',contact:'crm_contacts'};
const columns={account:'id,name,stage,created_at,updated_at,xmin::text revision',contact:'id,account_id,name,email,created_at,updated_at,xmin::text revision'};
export class TenantCrm{
 constructor(pool){this.pool=pool;}
 async list(context,search=''){return withTenantContext(this.pool,context,async db=>({items:(await db.query(`SELECT ${columns.account} FROM tenant_portal.crm_accounts WHERE tenant_id=$1 AND ($2='' OR name ILIKE '%'||$2||'%') ORDER BY name,id LIMIT 501`,[context.id,String(search).slice(0,120)])).rows}));}
 async detail(context,id){if(!validTenantId(id))throw fail('crm_account_not_found',404);return withTenantContext(this.pool,context,async db=>{const account=(await db.query(`SELECT ${columns.account} FROM tenant_portal.crm_accounts WHERE tenant_id=$1 AND id=$2`,[context.id,id])).rows[0];if(!account)throw fail('crm_account_not_found',404);return{account,contacts:(await db.query(`SELECT ${columns.contact} FROM tenant_portal.crm_contacts WHERE tenant_id=$1 AND account_id=$2 ORDER BY name,id LIMIT 501`,[context.id,id])).rows};});}
 async save(context,kind,body,{update=false}={}){
  const input=crmInput(kind,body,{update}),table=tables[kind],action='CRM_'+kind.toUpperCase()+(update?'_UPDATED':'_CREATED');
  return withTenantContext(this.pool,context,async db=>{
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended('crm:'||$1::text||':'||$2::text,0))",[context.id,input.id]);
   const old=(await db.query(`SELECT ${columns[kind]} FROM tenant_portal.${table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[context.id,input.id])).rows[0];
   if(!update&&old){const audit=(await db.query("SELECT metadata FROM saas.audit_events WHERE tenant_id=$1 AND target_id=$2 AND action=$3 ORDER BY occurred_at,id LIMIT 1",[context.id,input.id,action])).rows[0];if(audit?.metadata?.requestSha256!==snapshotHash(input))throw fail('crm_request_conflict',409);return{item:old,idempotent:true};}
   if(update&&(!old||old.revision!==input.expectedRevision)){if(!old)throw fail('crm_item_not_found',404);throw fail('crm_version_conflict',409);}
   if(kind==='contact'){if(old&&old.account_id!==input.accountId)throw fail('crm_contact_account_immutable',409);if(!(await db.query('SELECT id FROM tenant_portal.crm_accounts WHERE tenant_id=$1 AND id=$2 FOR SHARE',[context.id,input.accountId])).rowCount)throw fail('crm_account_not_found',404);}
   let sql,params;
   if(kind==='account'){
    sql=update?`UPDATE tenant_portal.crm_accounts SET name=$3,stage=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING ${columns.account}`:`INSERT INTO tenant_portal.crm_accounts(tenant_id,id,name,stage,created_by) VALUES($1,$2,$3,$4,$5) RETURNING ${columns.account}`;
    params=[context.id,input.id,input.name,input.stage,...(update?[]:[context.actorUserId])];
   }else{
    sql=update?`UPDATE tenant_portal.crm_contacts SET name=$3,email=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING ${columns.contact}`:`INSERT INTO tenant_portal.crm_contacts(tenant_id,id,name,email,account_id,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${columns.contact}`;
    params=[context.id,input.id,input.name,input.email,...(update?[]:[input.accountId,context.actorUserId])];
   }
   const item=(await db.query(sql,params)).rows[0];
   await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,$4,$5,$6)",[context.id,context.actorUserId,action,'crm_'+kind,input.id,{requestSha256:snapshotHash(input),reason:input.reason??null,before:old??null,after:item}]);
   return{item,idempotent:false};
  });
 }
}
