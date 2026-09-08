import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {csmInput} from '../platform/tenant-csm.mjs';
test('service input rejects invented dates, foreign-shaped owners and premature completion',()=>{
 assert.throws(()=>csmInput('customer',{name:'Customer',followUpAt:'2026-02-30'}),/csm_date_invalid/);
 assert.throws(()=>csmInput('customer',{name:'Customer',ownerUserId:'foreign'}),/active_tenant_member_required/);
 assert.throws(()=>csmInput('case',{customerId:crypto.randomUUID(),title:'Case',status:'CLOSED'}),/csm_new_case_must_be_open/);
 assert.throws(()=>csmInput('customer',{name:'Customer'},{update:true}),/csm_revision_confirmation_required/);
});
test('service input preserves explicit owner and date without fabricated health assessments',()=>{
 const owner=crypto.randomUUID(),input=csmInput('customer',{name:' Customer ',ownerUserId:owner,renewalAt:'2028-02-29'});
 assert.equal(input.health,'UNASSESSED');assert.equal(input.ownerUserId,owner);assert.equal(input.renewalAt,'2028-02-29');assert.equal(input.followUpAt,null);
});
