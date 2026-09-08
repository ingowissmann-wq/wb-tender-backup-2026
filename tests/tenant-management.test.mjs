import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotHash} from '../platform/canonical-truth.mjs';
import {tenantManagementGate} from '../platform/tenant-management.mjs';
const result={status:'CALCULATED',schemaVersion:4,formulaVersion:'WB_COST_CATALOG_V4',totalPrice:2000,db1:0,db2:0,db3:0,externalTransmission:false};
const row={id:'c1',current_calculation_id:'c1',assignment_id:'a1',current_assignment_id:'a1',assignment_kind:'AUTOMATIC',source_version_id:'v1',current_source_version_id:'v1',eligible:true,profile_current:true,status:'CALCULATED',result:{...result,calculationHash:snapshotHash(result)}};
test('management approves only the exact current immutable lot calculation',()=>{assert.deepEqual(tenantManagementGate(row),{ready:true,reasons:[]});});
test('source, profile, assignment, result tampering, expiry or newer calculation invalidate review',()=>{
 for(const changes of [{current_calculation_id:'c2'},{current_assignment_id:'a2'},{assignment_kind:'REVIEW_REQUIRED'},{current_source_version_id:'v2'},{eligible:false},{profile_current:false},{status:'BLOCKED'},{result:{...row.result,totalPrice:1}}])assert.equal(tenantManagementGate({...row,...changes}).ready,false);
});
