import {withTenantContext,validTenantId} from './tenant-context.mjs';
import {snapshotHash} from './canonical-truth.mjs';
import {TenantDocumentReview} from './tenant-document-review.mjs';
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const text=(value,min,max)=>typeof value==='string'&&value.trim().length>=min&&value.length<=max;
export function taskInput(input){
 if(!input||!validTenantId(input.id)||!validTenantId(input.taskId)||!validTenantId(input.companyId)||!Number.isInteger(input.expectedVersion)||input.expectedVersion<0||input.confirmed!==true)throw fail('task_request_invalid');
 if(input.assignmentId!=null&&!validTenantId(input.assignmentId)||input.assigneeUserId!=null&&!validTenantId(input.assigneeUserId))throw fail('task_binding_invalid');
 if(!text(input.title,3,240)||!text(input.description??'',0,5000)||!text(input.reason,10,1000)||!['OPEN','IN_PROGRESS','BLOCKED','DONE','CANCELLED'].includes(input.status))throw fail('task_details_invalid');
 if(!Array.isArray(input.checklist)||input.checklist.length<1||input.checklist.length>30||input.checklist.some(x=>!x||!validTenantId(x.id)||!text(x.label,3,240)||typeof x.done!=='boolean')||new Set(input.checklist.map(x=>x.id)).size!==input.checklist.length)throw fail('task_checklist_invalid');
 let dueAt=null;if(input.dueAt!=null){if(typeof input.dueAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.dueAt)||!Number.isFinite(Date.parse(input.dueAt))||new Date(input.dueAt).toISOString().slice(0,10)!==input.dueAt.slice(0,10)||!text(input.deadlineSource,10,1000))throw fail('task_deadline_source_required');dueAt=new Date(input.dueAt).toISOString();}
 if(input.status==='DONE'&&input.checklist.some(x=>!x.done))throw fail('task_required_steps_incomplete',409);
 return {id:input.id,taskId:input.taskId,companyId:input.companyId,assignmentId:input.assignmentId??null,assigneeUserId:input.assigneeUserId??null,expectedVersion:input.expectedVersion,title:input.title.trim(),description:(input.description??'').trim(),status:input.status,dueAt,deadlineSource:dueAt?input.deadlineSource.trim():'',reason:input.reason.trim(),checklist:input.checklist.map(x=>({id:x.id,label:x.label.trim(),done:x.done}))};
}
export function taskTransition(prior,input){
 if(!prior){if(input.expectedVersion!==0||input.status!=='OPEN'||input.checklist.some(x=>x.done))throw fail('task_creation_requires_open_steps',409);return;}
 if(prior.version!==input.expectedVersion)throw fail('task_version_conflict',409);
 if(prior.company_id!==input.companyId||prior.assignment_id!==input.assignmentId)throw fail('task_binding_immutable',409);
 const transitions={OPEN:['OPEN','IN_PROGRESS','BLOCKED','DONE','CANCELLED'],IN_PROGRESS:['IN_PROGRESS','BLOCKED','DONE','CANCELLED'],BLOCKED:['BLOCKED','IN_PROGRESS','CANCELLED'],DONE:['OPEN'],CANCELLED:['OPEN']};
 if(!transitions[prior.status]?.includes(input.status))throw fail('task_transition_invalid',409);
 if(['DONE','CANCELLED'].includes(prior.status)&&input.checklist.some(x=>x.done))throw fail('task_reopen_requires_new_review',409);
 if(prior.checklist.length!==input.checklist.length||prior.checklist.some((x,i)=>x.id!==input.checklist[i].id||x.label!==input.checklist[i].label))throw fail('task_required_steps_immutable',409);
}
const listSql=`SELECT latest.*,c.display_name company_name,a.lot_key,
 (latest.due_at<now() AND latest.status NOT IN('DONE','CANCELLED')) overdue,
 (latest.assignment_id IS NOT NULL AND (a.id IS DISTINCT FROM newest.id OR a.source_version_id IS DISTINCT FROM source.id OR a.assignment_kind NOT IN('AUTOMATIC','MANUAL') OR eligible.lot_key IS NULL)) source_changed
 FROM (SELECT DISTINCT ON(task_id) * FROM tenant_portal.workflow_task_versions WHERE tenant_id=$1 ORDER BY task_id,version DESC) latest
 JOIN saas.tenant_companies c ON c.tenant_id=latest.tenant_id AND c.id=latest.company_id
 LEFT JOIN tenant_portal.lot_assignment_versions a ON a.tenant_id=latest.tenant_id AND a.id=latest.assignment_id
 LEFT JOIN tenant_portal.tender_workspaces w ON w.tenant_id=a.tenant_id AND w.id=a.workspace_id
 LEFT JOIN LATERAL(SELECT id FROM tenant_portal.lot_assignment_versions WHERE tenant_id=a.tenant_id AND workspace_id=a.workspace_id AND lot_key=a.lot_key ORDER BY version DESC LIMIT 1)newest ON true
 LEFT JOIN LATERAL(SELECT id FROM tender.tender_versions WHERE tender_id=w.public_tender_id ORDER BY version DESC LIMIT 1)source ON true
 LEFT JOIN tender.current_participation_eligible_lots eligible ON eligible.tender_id=w.public_tender_id AND eligible.lot_key=a.lot_key
 ORDER BY latest.due_at NULLS LAST,latest.created_at DESC LIMIT 500`;
export class TenantWorkflowTasks{
 constructor(pool){this.pool=pool;this.documents=new TenantDocumentReview(pool);}
 async list(context){return withTenantContext(this.pool,context,async db=>({items:(await db.query(listSql,[context.id])).rows}));}
 async history(context,taskId){if(!validTenantId(taskId))throw fail('task_not_found',404);return withTenantContext(this.pool,context,async db=>{const rows=(await db.query('SELECT * FROM tenant_portal.workflow_task_versions WHERE tenant_id=$1 AND task_id=$2 ORDER BY version',[context.id,taskId])).rows;if(!rows.length)throw fail('task_not_found',404);return rows;});}
 async save(context,body){
  const input=taskInput(body),hash=snapshotHash(input);
  return withTenantContext(this.pool,context,async db=>{
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended('workflow-task:'||$1::text||':'||$2::text,0))",[context.id,input.taskId]);
   const old=(await db.query('SELECT * FROM tenant_portal.workflow_task_versions WHERE tenant_id=$1 AND id=$2',[context.id,input.id])).rows[0];
   if(old){if(old.request_sha256!==hash)throw fail('task_request_conflict',409);return{item:old,idempotent:true};}
   const prior=(await db.query('SELECT * FROM tenant_portal.workflow_task_versions WHERE tenant_id=$1 AND task_id=$2 ORDER BY version DESC LIMIT 1',[context.id,input.taskId])).rows[0];taskTransition(prior,input);
   if(!(await db.query("SELECT id FROM saas.tenant_companies WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE' FOR SHARE",[context.id,input.companyId])).rowCount)throw fail('task_company_not_found',404);
   if(input.assigneeUserId&&!(await db.query("SELECT user_id FROM saas.tenant_memberships WHERE tenant_id=$1 AND user_id=$2 AND status='ACTIVE' FOR SHARE",[context.id,input.assigneeUserId])).rowCount)throw fail('active_tenant_member_required');
   if(input.assignmentId&&input.status!=='CANCELLED'){const assignment=await this.documents.assignment(db,context,input.assignmentId);if(assignment.company_id!==input.companyId)throw fail('task_company_assignment_mismatch',409);}
   const item=(await db.query(`INSERT INTO tenant_portal.workflow_task_versions(id,tenant_id,task_id,version,company_id,assignment_id,title,description,status,assignee_user_id,due_at,deadline_source,checklist,reason,request_sha256,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,[input.id,context.id,input.taskId,input.expectedVersion+1,input.companyId,input.assignmentId,input.title,input.description,input.status,input.assigneeUserId,input.dueAt,input.deadlineSource,JSON.stringify(input.checklist),input.reason,hash,context.actorUserId])).rows[0];
   await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id,metadata) VALUES($1,$2,'WORKFLOW_TASK_VERSION_CREATED','workflow_task',$3,$4)",[context.id,context.actorUserId,input.taskId,{version:item.version,status:item.status,companyId:item.company_id,assignmentId:item.assignment_id}]);
   return{item,idempotent:false};
  });
 }
}
