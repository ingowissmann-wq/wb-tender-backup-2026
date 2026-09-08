import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerTenantCredentialRoutes} from '../platform/tenant-credential-routes.mjs';
const tenant='11111111-1111-4111-8111-111111111111',actor='22222222-2222-4222-8222-222222222222';
async function application({role='OWNER',modules=['tender_autopilot'],allowed=true,csrf=false}={}){
 const app=Fastify();
 registerTenantCredentialRoutes(app,{pool:{connect(){throw new Error('unexpected_database_access')}},authenticate:async req=>{req.identity={userId:actor,saas:{tenant_id:tenant,role,modules,access:{allowed},plan_code:'ENTERPRISE'}}},csrf:async(_,reply)=>{if(!csrf)return reply.code(403).send({error:'csrf_required'})}});
 await app.ready();return app;
}
test('portal access page completes its authentication prehandlers and contains no inline secret values',{timeout:3000},async()=>{
 const app=await application();try{const response=await app.inject({method:'GET',url:'/saas/app/portal-access'});assert.equal(response.statusCode,200);assert.match(response.body,/type="password"/);assert.match(response.body,/portal-access.js/);assert.equal(response.headers['cache-control'],'no-store');}finally{await app.close()}
});
test('portal credential routes enforce tenant admin, module access, CSRF and reject invalid company IDs before database access',async()=>{
 for(const options of [{role:'MEMBER'},{modules:[]},{allowed:false}]){
  const app=await application(options);try{assert.equal((await app.inject('/saas/app/portal-access')).statusCode,403)}finally{await app.close()}
 }
 const app=await application();try{assert.equal((await app.inject({method:'POST',url:'/api/tenant-portal/companies/'+tenant+'/credentials',payload:{}})).statusCode,403);assert.equal((await app.inject('/api/tenant-portal/companies/invalid/credentials')).statusCode,404)}finally{await app.close()}
});
