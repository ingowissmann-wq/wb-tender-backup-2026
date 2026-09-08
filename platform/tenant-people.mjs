import crypto from 'node:crypto';
import {withTenantContext,validTenantId} from './tenant-context.mjs';
import {snapshotHash} from './canonical-truth.mjs';
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const bounded=(value,max)=>typeof value==='string'&&value.length<=max?value.trim():value==null?'':null;
const optionalEmail=value=>{const email=bounded(value,254);if(email===null||email&&!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))throw fail('employee_email_invalid');return email?.toLowerCase()||null;};
const date=value=>{if(value==null||value==='')return null;if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw fail('employee_date_invalid');return value;};
export function employeeInput(body){
 const name=bounded(body?.displayName,160),id=body?.id??crypto.randomUUID();if(!validTenantId(id)||!name||name.length<2)throw fail('employee_name_invalid');
 const status=body?.employmentStatus??'ONBOARDING';if(!['ONBOARDING','ACTIVE','LEAVE','INACTIVE'].includes(status))throw fail('employee_status_invalid');
 const userId=body?.userId||null;if(userId&&!validTenantId(userId))throw fail('active_tenant_member_required');
 const phone=bounded(body?.phone,60),number=bounded(body?.employeeNumber,80),job=bounded(body?.jobTitle,160),team=bounded(body?.teamName,160);if([phone,number,job,team].includes(null))throw fail('employee_fields_invalid');
 return{id,userId,displayName:name,workEmail:optionalEmail(body?.workEmail),personalEmail:optionalEmail(body?.personalEmail),phone:phone||null,employeeNumber:number||null,employmentStatus:status,jobTitle:job||null,teamName:team||null,startDate:date(body?.startDate)};
}
async function member(db,context,id){if(!id)return null;if(!validTenantId(id))throw fail('active_tenant_member_required');const row=(await db.query("SELECT user_id FROM saas.tenant_memberships WHERE tenant_id=$1 AND user_id=$2 AND status='ACTIVE' FOR SHARE",[context.id,id])).rows[0];if(!row)throw fail('active_tenant_member_required');return row.user_id;}
async function priorRequest(db,context,table,id,action,input){
 await db.query("SELECT pg_advisory_xact_lock(hashtextextended('people:'||$1::text||':'||$2::text,0))",[context.id,id]);
 const old=(await db.query(`SELECT *,xmin::text revision FROM tenant_portal.${table} WHERE tenant_id=$1 AND id=$2`,[context.id,id])).rows[0];if(!old)return null;
 const audit=(await db.query('SELECT metadata FROM saas.audit_events WHERE tenant_id=$1 AND target_id=$2 AND action=$3 ORDER BY occurred_at,id LIMIT 1',[context.id,id,action])).rows[0];if(audit?.metadata?.requestSha256!==snapshotHash(input))throw fail('people_request_conflict',409);return old;
}
async function audit(db,context,action,id,input){await db.query('INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[context.id,context.actorUserId,action,'people',id,{requestSha256:snapshotHash(input),...(action==='EMPLOYEE_PROFILE_CREATED'||action==='EMPLOYEE_PROFILE_UPDATED'?{userId:input.userId,employmentStatus:input.employmentStatus}:input)}]);}
export class TenantPeople{
 constructor(pool){this.pool=pool;}
 async create(context,body){const input=employeeInput(body);return withTenantContext(this.pool,context,async db=>{
  // Validate referenced membership before any write, including a duplicate request.
  await member(db,context,input.userId);const old=await priorRequest(db,context,'employee_profiles',input.id,'EMPLOYEE_PROFILE_CREATED',input);if(old)return{item:old,idempotent:true};
  const item=(await db.query(`INSERT INTO tenant_portal.employee_profiles(id,tenant_id,user_id,display_name,work_email,personal_email,phone,employee_number,employment_status,job_title,team_name,start_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *,xmin::text revision`,[input.id,context.id,input.userId,input.displayName,input.workEmail,input.personalEmail,input.phone,input.employeeNumber,input.employmentStatus,input.jobTitle,input.teamName,input.startDate])).rows[0];await audit(db,context,'EMPLOYEE_PROFILE_CREATED',item.id,input);return{item,idempotent:false};
 });}
 async update(context,id,body){
  if(!validTenantId(id)||!/^\d{1,10}$/.test(String(body?.expectedRevision||'')))throw fail('employee_revision_required');
  return withTenantContext(this.pool,context,async db=>{
   const old=(await db.query('SELECT *,xmin::text revision FROM tenant_portal.employee_profiles WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[context.id,id])).rows[0];if(!old)throw fail('employee_not_found',404);if(old.revision!==String(body.expectedRevision))throw fail('employee_version_conflict',409);
   if(body.userId!==undefined&&body.userId!==old.user_id)throw fail('employee_user_binding_immutable',409);
   const input=employeeInput({id,userId:old.user_id,displayName:body.displayName??old.display_name,employmentStatus:body.employmentStatus??old.employment_status,workEmail:body.workEmail??old.work_email,personalEmail:body.personalEmail??old.personal_email,phone:body.phone??old.phone,employeeNumber:body.employeeNumber??old.employee_number,jobTitle:body.jobTitle??old.job_title,teamName:body.teamName??old.team_name,startDate:body.startDate??(old.start_date instanceof Date?old.start_date.toISOString().slice(0,10):old.start_date)});
   const item=(await db.query('UPDATE tenant_portal.employee_profiles SET display_name=$3,employment_status=$4,work_email=$5,personal_email=$6,phone=$7,employee_number=$8,job_title=$9,team_name=$10,start_date=$11 WHERE tenant_id=$1 AND id=$2 RETURNING *,xmin::text revision',[context.id,id,input.displayName,input.employmentStatus,input.workEmail,input.personalEmail,input.phone,input.employeeNumber,input.jobTitle,input.teamName,input.startDate])).rows[0];await audit(db,context,'EMPLOYEE_PROFILE_UPDATED',id,input);return item;
  });
 }
 async list(context){return withTenantContext(this.pool,context,async db=>({items:(await db.query('SELECT *,xmin::text revision FROM tenant_portal.employee_profiles WHERE tenant_id=$1 ORDER BY display_name,id LIMIT 501',[context.id])).rows}));}
 async detail(context,id){if(!validTenantId(id))throw fail('employee_not_found',404);return withTenantContext(this.pool,context,async db=>{const employee=(await db.query('SELECT *,xmin::text revision FROM tenant_portal.employee_profiles WHERE tenant_id=$1 AND id=$2',[context.id,id])).rows[0];if(!employee)throw fail('employee_not_found',404);return{employee,tasks:(await db.query('SELECT *,xmin::text revision FROM tenant_portal.people_onboarding_tasks WHERE tenant_id=$1 AND employee_id=$2 ORDER BY due_at NULLS LAST,created_at',[context.id,id])).rows};});}
 async self(context){return withTenantContext(this.pool,context,async db=>({employee:(await db.query('SELECT id,display_name,work_email,personal_email,phone,employee_number,employment_status,job_title,team_name,start_date FROM tenant_portal.employee_profiles WHERE tenant_id=$1 AND user_id=$2',[context.id,context.actorUserId])).rows[0]??null,tasks:(await db.query(`SELECT t.id,t.employee_id,t.title,t.status,t.due_at,t.completed_at,t.assignee_user_id,t.xmin::text revision FROM tenant_portal.people_onboarding_tasks t WHERE t.tenant_id=$1 AND (t.assignee_user_id=$2 OR EXISTS(SELECT 1 FROM tenant_portal.employee_profiles e WHERE e.tenant_id=t.tenant_id AND e.id=t.employee_id AND e.user_id=$2)) ORDER BY t.due_at NULLS LAST,t.created_at`,[context.id,context.actorUserId])).rows}));}
 async createTask(context,employeeId,body){
  const title=bounded(body?.title,240),id=body?.id??crypto.randomUUID(),assigneeUserId=body?.assigneeUserId||null;
  if(!validTenantId(employeeId)||!validTenantId(id))throw fail('employee_not_found',404);if(!title||title.length<3)throw fail('onboarding_title_invalid');
  const input={id,employeeId,title,assigneeUserId,dueAt:date(body?.dueAt)};
  return withTenantContext(this.pool,context,async db=>{
   await member(db,context,assigneeUserId);const old=await priorRequest(db,context,'people_onboarding_tasks',id,'ONBOARDING_TASK_CREATED',input);if(old)return{item:old,idempotent:true};
   if(!(await db.query('SELECT id FROM tenant_portal.employee_profiles WHERE tenant_id=$1 AND id=$2 FOR SHARE',[context.id,employeeId])).rowCount)throw fail('employee_not_found',404);
   const item=(await db.query('INSERT INTO tenant_portal.people_onboarding_tasks(id,tenant_id,employee_id,title,assignee_user_id,due_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *,xmin::text revision',[id,context.id,employeeId,title,assigneeUserId,input.dueAt,context.actorUserId])).rows[0];await audit(db,context,'ONBOARDING_TASK_CREATED',id,input);return{item,idempotent:false};
  });
 }
 async decide(context,id,body,{admin=false}={}){
  if(!validTenantId(id)||!body||!['OPEN','DONE','NOT_APPLICABLE'].includes(body.status)||!/^\d{1,10}$/.test(String(body.expectedRevision||''))||body.confirmed!==true||typeof body.reason!=='string'||body.reason.trim().length<10||body.reason.length>1000)throw fail('onboarding_decision_invalid');
  return withTenantContext(this.pool,context,async db=>{
   const task=(await db.query('SELECT *,xmin::text revision FROM tenant_portal.people_onboarding_tasks WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[context.id,id])).rows[0];if(!task||!admin&&task.assignee_user_id!==context.actorUserId)throw fail('onboarding_task_not_found',404);
   if(task.revision!==String(body.expectedRevision))throw fail('onboarding_version_conflict',409);
   const item=(await db.query("UPDATE tenant_portal.people_onboarding_tasks SET status=$3,completed_at=CASE WHEN $3::text='OPEN' THEN NULL ELSE now() END,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *,xmin::text revision",[context.id,id,body.status])).rows[0];await audit(db,context,'ONBOARDING_TASK_DECIDED',id,{before:task.status,status:item.status,reason:body.reason.trim()});return item;
  });
 }
}
