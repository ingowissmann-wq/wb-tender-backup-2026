import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import {crmInput} from '../platform/tenant-crm.mjs';
import {registerTenantCrmRoutes} from '../platform/tenant-crm-routes.mjs';
test('CRM validates account stages, contact parent and conflict revision',()=>{
 const id=crypto.randomUUID(),accountId=crypto.randomUUID();assert.deepEqual(crmInput('contact',{id,accountId,name:' Contact ',email:'PERSON@EXAMPLE.COM'}),{id,accountId,name:'Contact',email:'person@example.com'});
 for(const [kind,body,options] of [['account',{id,name:'Name',stage:'AUTOMATIC_WON'},{}],['contact',{id,name:'Name',accountId,email:'bad\naddress@example.com'},{}],['contact',{id,name:'Name',email:'person@example.com'},{}],['account',{id,name:'Name',stage:'CUSTOMER',expectedRevision:'wrong',reason:'Valid reason for update'},{update:true}]])assert.throws(()=>crmInput(kind,body,options));
});
test('Pro has no CRM page or write access and operational errors expose no SQL details',async()=>{
 for(const modules of [[],['crm']]){
  const app=Fastify();registerTenantCrmRoutes(app,{pool:{connect(){throw Error('secret database connection detail')}},csrf:async()=>{},authenticate:async req=>{req.identity={userId:crypto.randomUUID(),saas:{tenant_id:'11111111-1111-4111-8111-111111111111',plan_code:modules.length?'PROFESSIONAL':'NORMAL',role:'OWNER',modules,access:{allowed:true}}}}});
  try{if(!modules.length){assert.equal((await app.inject({url:'/saas/app/crm'})).statusCode,403);assert.equal((await app.inject({method:'POST',url:'/api/tenant-portal/crm/accounts',payload:{}})).statusCode,403);}else{const r=await app.inject({url:'/api/tenant-portal/crm/accounts'});assert.equal(r.statusCode,503);assert.deepEqual(r.json(),{error:'crm_temporarily_unavailable'});}}finally{await app.close();}
 }
});
