import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerTenantPortalRoutes} from '../platform/tenant-portal.mjs';
import {registerSaasRoutes} from '../platform/saas-platform.mjs';
const tenant='11111111-1111-4111-8111-111111111111',actor='22222222-2222-4222-8222-222222222222';
test('company administration page is reachable for its tenant owner and protected from regular members',{timeout:3000},async()=>{
 for(const role of ['OWNER','MEMBER']){
  const app=Fastify();registerTenantPortalRoutes(app,{pool:{},authenticate:async req=>{req.identity={userId:actor,saas:{tenant_id:tenant,role,access:{allowed:true},modules:['control']}}},csrf:async()=>{}});
  try{const response=await app.inject('/saas/app/companies');assert.equal(response.statusCode,role==='OWNER'?200:403);if(role==='OWNER')assert.match(response.body,/Gesellschaft anlegen/)}finally{await app.close()}
 }
});
test('the rendered registration disclosure offers only card and Billie',async()=>{
 const app=Fastify(),noop=async()=>{};
 registerSaasRoutes(app,{enabled:true,pool:{query:async()=>({rows:[]})},loadInternalIdentity:noop,requireInternalAdmin:noop,csrf:noop});
 try{const response=await app.inject('/saas/register?plan=TRIAL');assert.equal(response.statusCode,200);assert.match(response.body,/Billie/);const select=response.body.match(/<select name="billingPath"[^>]*>(.*?)<\/select>/s)[1];assert.deepEqual([...select.matchAll(/<option value="([^"]+)"/g)].map(x=>x[1]),['AUTO_CARD','INVOICE_BILLIE']);}finally{await app.close()}
});
