import {registerTenantCsmRoutes} from '../platform/tenant-csm-routes.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerTenantPeopleRoutes} from '../platform/tenant-people-routes.mjs';
import {registerTenantPortalRoutes} from '../platform/tenant-portal.mjs';
const tenant='11111111-1111-4111-8111-111111111111',actor='22222222-2222-4222-8222-222222222222',foreign='33333333-3333-4333-8333-333333333333',item='44444444-4444-4444-8444-444444444444';
const routes=[
 ['/api/tenant-portal/csm/customers',{name:'Example'},'ownerUserId'],
 [`/api/tenant-portal/csm/customers/${item}/cases`,{title:'Example'},'ownerUserId'],
 ['/api/tenant-portal/people/employees',{displayName:'Example'},'userId'],
 [`/api/tenant-portal/people/employees/${item}/onboarding`,{title:'Example'},'assigneeUserId']
];
for(const [url,body,field] of routes)test(`${url} rejects invalid, foreign and inactive user assignments before writing`,async()=>{
 for(const target of ['invalid',foreign,actor]){
  const queries=[];
  const pool={connect:async()=>({release(){},async query(sql,args){queries.push(sql);if(sql.startsWith('SELECT user_id')){assert.deepEqual(args,[tenant,target]);assert.match(sql,/status='ACTIVE' FOR SHARE/);return {rows:[]};}return{rows:[]};}})};
  const app=Fastify();const options={pool,csrf:async()=>{},authenticate:async req=>{req.identity={userId:actor,saas:{tenant_id:tenant,role:'OWNER',plan_code:'PROFESSIONAL',modules:['csm','people'],access:{allowed:true}}};}};registerTenantPortalRoutes(app,options);registerTenantPeopleRoutes(app,options);registerTenantCsmRoutes(app,options);
  try{const response=await app.inject({method:'POST',url,payload:{...body,[field]:target}});assert.equal(response.statusCode,400);assert.equal(response.json().message??response.json().error,'active_tenant_member_required');assert.equal(queries.some(q=>q.startsWith('INSERT')),false);if(queries.includes('BEGIN'))assert.ok(queries.includes('ROLLBACK'));else assert.equal(queries.length,0);}finally{await app.close();}
 }
});
