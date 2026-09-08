import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import {enterprisePage,enterpriseRecords,registerTenantEnterpriseApi} from '../platform/tenant-enterprise-api.mjs';
test('enterprise API bounds pagination and rejects unknown resources before database access',async()=>{
 for(const query of [{limit:0},{limit:101},{limit:1.5},{cursor:'foreign'},{limit:'Infinity'}])assert.throws(()=>enterprisePage(query),/api_pagination_invalid/);
 assert.deepEqual(enterprisePage(),{limit:50,cursor:null});
 await assert.rejects(()=>enterpriseRecords({connect(){throw Error('must not query');}},{},'__proto__'),/api_resource_not_found/);
});
test('enterprise API rejects unentitled, expired and non-admin identities before reading data',async()=>{
 for(const override of [{modules:[]},{access:{allowed:false,reason:'expired'}},{role:'MEMBER'},{role:'BILLING'}]){
  let queried=false;const app=Fastify();registerTenantEnterpriseApi(app,{pool:{connect(){queried=true;throw Error('must not query');}},authenticate:async req=>{req.identity={userId:crypto.randomUUID(),saas:{tenant_id:crypto.randomUUID(),role:'OWNER',modules:['connect'],access:{allowed:true},...override}};}});
  try{assert.equal((await app.inject('/api/enterprise/v1/companies')).statusCode,403);assert.equal(queried,false);}finally{await app.close();}
 }
});
