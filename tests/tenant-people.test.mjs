import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import {employeeInput} from '../platform/tenant-people.mjs';
import {registerTenantPeopleRoutes} from '../platform/tenant-people-routes.mjs';
import {registerTenantPortalRoutes} from '../platform/tenant-portal.mjs';
test('employee records reject malformed dates, email, account bindings and status',()=>{
 const valid={id:crypto.randomUUID(),displayName:'Own Employee',startDate:'2026-09-01',userId:crypto.randomUUID()};assert.equal(employeeInput(valid).employmentStatus,'ONBOARDING');
 for(const update of [{startDate:'2026-02-30'},{workEmail:'invalid\nmail@example.com'},{userId:'not-uuid'},{employmentStatus:'UNKNOWN'},{phone:'x'.repeat(61)}])assert.throws(()=>employeeInput({...valid,...update}));
});
test('members cannot enumerate or export other personnel records through any registered route',async()=>{
 let queried=false;const app=Fastify(),options={pool:{connect(){queried=true;throw Error('must not query')}},csrf:async()=>{},authenticate:async req=>{req.identity={userId:crypto.randomUUID(),saas:{tenant_id:'11111111-1111-4111-8111-111111111111',role:'MEMBER',plan_code:'NORMAL',modules:['people'],access:{allowed:true}}}}};registerTenantPortalRoutes(app,options);registerTenantPeopleRoutes(app,options);
 try{for(const url of ['/api/tenant-portal/people/employees','/api/tenant-portal/people/employees/22222222-2222-4222-8222-222222222222','/api/tenant-portal/modules/people','/api/tenant-portal/modules/people/export'])assert.equal((await app.inject({url})).statusCode,403);assert.equal(queried,false);const page=await app.inject({url:'/saas/app/people'});assert.equal(page.statusCode,302);assert.equal(page.headers.location,'/saas/app/me');}finally{await app.close();}
});
