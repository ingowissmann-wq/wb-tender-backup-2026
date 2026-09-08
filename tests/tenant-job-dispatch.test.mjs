import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerTenantPortalRoutes} from '../platform/tenant-portal.mjs';
import {dispatchTenantJob} from '../platform/tenant-job-dispatch.mjs';
const tenant='11111111-1111-4111-8111-111111111111';
test('unsupported jobs are rejected without creating a queue record',async()=>{
 for(const [moduleKey,jobType] of [['tender_autopilot','SEND_BID'],['crm','CALCULATE_LOT'],['tender_autopilot','ANY_UNIMPLEMENTED_JOB']])await assert.rejects(dispatchTenantJob({moduleKey,jobType,pool:{connect(){throw new Error('unexpected_database_access')}}}),error=>error.message==='job_type_not_supported'&&error.statusCode===422);
});
test('module job endpoint enforces role and rejects unknown or incomplete executable jobs',async()=>{
 for(const role of ['OWNER','MEMBER']){
  const app=Fastify();registerTenantPortalRoutes(app,{pool:{connect(){throw new Error('unexpected_database_access')}},authenticate:async req=>{req.identity={userId:tenant,saas:{tenant_id:tenant,role,modules:['tender_autopilot'],access:{allowed:true},plan_code:'PRO'}}},csrf:async()=>{}});
  try{
   const response=await app.inject({method:'POST',url:'/api/tenant-portal/modules/tender-autopilot/jobs',payload:{jobType:'UNIMPLEMENTED_JOB',payload:{}}});assert.equal(response.statusCode,role==='OWNER'?422:403);
   if(role==='OWNER'){
    const calculation=await app.inject({method:'POST',url:'/api/tenant-portal/modules/tender-autopilot/jobs',payload:{jobType:'CALCULATE_LOT',payload:{}}});assert.equal(calculation.statusCode,400);assert.match(calculation.json().error,/^calculation_/);
    const document=await app.inject({method:'POST',url:'/api/tenant-portal/modules/tender-autopilot/jobs',payload:{jobType:'REVIEW_LOT_DOCUMENTS',payload:{}}});assert.equal(document.statusCode,400);assert.match(document.json().error,/^document_review_/);
   }
  }finally{await app.close();}
 }
});
