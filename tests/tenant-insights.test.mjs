import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerTenantInsightsRoutes} from '../platform/tenant-insights-routes.mjs';
const tenant='11111111-1111-4111-8111-111111111111';
test('operational reporting requires both booked insights and tenant management role',async()=>{
 for(const access of [{modules:[],role:'OWNER'},{modules:['insights'],role:'MEMBER'}]){
  let called=false;const app=Fastify();registerTenantInsightsRoutes(app,{pool:{connect(){called=true;throw Error('must not query')}},authenticate:async req=>{req.identity={userId:'22222222-2222-4222-8222-222222222222',saas:{tenant_id:tenant,plan_code:'PROFESSIONAL',access:{allowed:true},...access}}}});
  try{for(const url of ['/api/tenant-portal/insights','/saas/app/insights'])assert.equal((await app.inject({url})).statusCode,403);assert.equal(called,false);}finally{await app.close();}
 }
});
test('report failures disclose no database details and are never returned as empty success',async()=>{
 const app=Fastify();registerTenantInsightsRoutes(app,{pool:{connect(){throw Error('private database detail')}},authenticate:async req=>{req.identity={userId:'22222222-2222-4222-8222-222222222222',saas:{tenant_id:tenant,plan_code:'PROFESSIONAL',role:'OWNER',modules:['insights'],access:{allowed:true}}}}});
 try{const response=await app.inject({url:'/api/tenant-portal/insights'});assert.equal(response.statusCode,503);assert.deepEqual(response.json(),{error:'insights_temporarily_unavailable'});assert.equal(response.headers['cache-control'],'no-store');}finally{await app.close();}
});
