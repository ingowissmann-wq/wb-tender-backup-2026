import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerSubmissionDispatchRoutes} from '../platform/submission-dispatch-routes.mjs';
import {MODULE_KEYS} from '../platform/saas-catalog.mjs';
const tenant='a0000000-0000-4000-8000-000000000001',actor='b0000000-0000-4000-8000-000000000001';
function appFor({role='OWNER',fresh=true}={}){
 const app=Fastify(),db={query:async()=>({rows:[]}),release(){}};
 registerSubmissionDispatchRoutes(app,{pool:{connect:async()=>db},storage:{},authenticate:async req=>{req.identity={userId:actor,saas:{tenant_id:tenant,role,access:{allowed:true},modules:[MODULE_KEYS.TENDER_AUTOPILOT]}}},csrf:async()=>{},isFreshWbMfa:async()=>fresh});
 return app;
}
test('submission list completes authenticated tenant hook and returns scoped results',{timeout:2000},async()=>{
 const app=appFor();
 try{const r=await app.inject('/api/tenant-portal/submissions');assert.equal(r.statusCode,200);assert.deepEqual(r.json(),{items:[]})}
 finally{await app.close()}
});
test('member cannot release or list management submissions',async()=>{
 const app=appFor({role:'MEMBER'});
 try{assert.equal((await app.inject('/api/tenant-portal/submissions')).statusCode,403);assert.equal((await app.inject({method:'POST',url:'/api/tenant-portal/packages/'+tenant+'/submit',payload:{}})).statusCode,403)}
 finally{await app.close()}
});
test('release requires fresh MFA and explicit confirmation',async()=>{
 for(const fresh of [false,true]){
  const app=appFor({fresh});
  try{const r=await app.inject({method:'POST',url:'/api/tenant-portal/packages/'+tenant+'/submit',payload:{}});assert.equal(r.statusCode,fresh?409:403);assert.equal(r.json().error,fresh?'submission_explicit_confirmation_required':'wb_mfa_required')}
  finally{await app.close()}
 }
});
