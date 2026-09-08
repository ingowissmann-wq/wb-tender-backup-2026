import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {taskInput,taskTransition} from '../platform/tenant-workflow-tasks.mjs';
const input=()=>({id:crypto.randomUUID(),taskId:crypto.randomUUID(),companyId:crypto.randomUUID(),expectedVersion:0,confirmed:true,title:'Prepare own offer',description:'',status:'OPEN',reason:'Source document reviewed',checklist:[{id:crypto.randomUUID(),label:'Check required proof',done:false}]});
test('tasks require explicit sourced deadlines, complete stable steps and valid scope',()=>{
 const base=input();assert.equal(taskInput(base).dueAt,null);
 for(const bad of [{...base,companyId:crypto.randomUUID()+'bad'},{...base,checklist:[]},{...base,checklist:[base.checklist[0],base.checklist[0]]},{...base,confirmed:false},{...base,dueAt:'2026-02-30T10:00:00Z',deadlineSource:'Explicit source document'},{...base,dueAt:'2026-09-30T10:00:00Z'},{...base,status:'DONE'}])assert.throws(()=>taskInput(bad));
 const valid=taskInput({...base,dueAt:'2026-09-30T10:00:00Z',deadlineSource:'Explicit source document'});assert.equal(valid.dueAt,'2026-09-30T10:00:00.000Z');
});
test('task history requires version matching, immutable company and steps, and explicit reopening',()=>{
 const base=taskInput(input());taskTransition(null,base);
 const prior={version:1,status:'OPEN',company_id:base.companyId,assignment_id:null,checklist:base.checklist};
 taskTransition(prior,{...base,expectedVersion:1,status:'IN_PROGRESS'});
 assert.throws(()=>taskTransition(prior,base),/task_version_conflict/);
 assert.throws(()=>taskTransition(prior,{...base,expectedVersion:1,companyId:crypto.randomUUID()}),/task_binding_immutable/);
 assert.throws(()=>taskTransition(prior,{...base,expectedVersion:1,checklist:[]}),/task_required_steps_immutable/);
 assert.throws(()=>taskTransition({...prior,status:'BLOCKED'},{...base,expectedVersion:1,status:'DONE'}),/task_transition_invalid/);
 taskTransition({...prior,status:'DONE'},{...base,expectedVersion:1,status:'OPEN'});
 assert.throws(()=>taskTransition({...prior,status:'DONE'},{...base,expectedVersion:1,status:'OPEN',checklist:base.checklist.map(x=>({...x,done:true}))}),/task_reopen_requires_new_review/);
});

test('workflow routes require booked access and management role before reading or writing',async()=>{
 const {default:Fastify}=await import('fastify');const {registerTenantWorkflowRoutes}=await import('../platform/tenant-workflow-routes.mjs');
 for(const access of [{role:'MEMBER',modules:['flow']},{role:'OWNER',modules:[]}]){
  let queried=false;const app=Fastify();registerTenantWorkflowRoutes(app,{pool:{connect(){queried=true;throw Error('must not query')}},csrf:async()=>{},authenticate:async req=>{req.identity={userId:crypto.randomUUID(),saas:{tenant_id:'11111111-1111-4111-8111-111111111111',plan_code:'NORMAL',access:{allowed:true},...access}}}});
  try{for(const request of [{url:'/saas/app/workflow'},{url:'/api/tenant-portal/workflow/tasks'},{url:'/api/tenant-portal/workflow/tasks',method:'POST',payload:input()}])assert.equal((await app.inject(request)).statusCode,403);assert.equal(queried,false);}finally{await app.close();}
 }
});
