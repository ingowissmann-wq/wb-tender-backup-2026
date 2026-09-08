import {access,constants,stat} from 'node:fs/promises';
import assert from 'node:assert/strict';
assert.equal(process.getuid(),1001,'release must run as its unprivileged production user');
assert.equal(process.getgid(),1001,'release must use its production group');
for(const path of ['/app/platform/server.mjs','/app/platform/autopilot-pipeline-worker.mjs','/app/platform/scheduler.mjs','/app/platform/saas-adapters.mjs','/app/deployment/apply-release-migrations.sh']){
 await access(path,constants.R_OK);
 assert.equal((await stat(path)).uid,0,'application files must remain root-owned');
 await assert.rejects(access(path,constants.W_OK),{code:'EACCES'});
}
await import('../platform/saas-adapters.mjs');
console.log(JSON.stringify({runtimeUser:'PASS',uid:process.getuid(),gid:process.getgid(),applicationReadable:true,applicationWritable:false,billingModuleImport:true}));
