import test from 'node:test';
import assert from 'node:assert/strict';
import {requireTenantContext,withTenantContext} from '../platform/tenant-context.mjs';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
test('the authenticated route context binds its tenant and actor for database operations',async()=>{
  const req={identity:{userId:b,saas:{tenant_id:a}}};requireTenantContext(req,{code(){throw new Error('unexpected rejection');}});
  const calls=[];let released=false;
  const pool={async connect(){return{async query(sql,params){calls.push([sql,params]);return{rows:[]};},release(){released=true;}}}};
  const result=await withTenantContext(pool,req.tenant,async db=>{await db.query('SELECT tenant data');return 'bound';});
  assert.equal(result,'bound');assert.equal(calls[0][0],'BEGIN');
  assert.deepEqual(calls[1],["SELECT set_config('app.tenant_id',$1,true)",[a]]);
  assert.deepEqual(calls[2],["SELECT set_config('app.actor_user_id',$1,true)",[b]]);
  assert.equal(calls.at(-1)[0],'COMMIT');assert.equal(released,true);
});
test('conflicting tenant aliases fail before opening a database connection',async()=>{
  const pool={async connect(){throw new Error('must not connect');}};
  await assert.rejects(withTenantContext(pool,{tenantId:a,id:b},()=>{}),/tenant_context_conflict/);
  await assert.rejects(withTenantContext(pool,{id:'invalid'},()=>{}),/tenant_context_required/);
});
