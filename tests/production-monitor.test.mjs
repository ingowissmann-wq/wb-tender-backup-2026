import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const assess=records=>JSON.parse(execFileSync('python3',['-B','-c',"import importlib.util,json,sys; s=importlib.util.spec_from_file_location('monitor','deployment/production-monitor.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.container_failures(json.load(sys.stdin))))"],{input:JSON.stringify(records),encoding:'utf8'}));
const healthy=()=>Object.fromEntries(['api','worker','scheduler','db'].map(service=>[service,{project:'wb-tender-production',image:'sha256:'+ 'a'.repeat(64),health:'healthy',restarts:0,flags:{EXTERNAL_SUBMISSION_ENABLED:'false',WB_TENDER_ALLOW_EXTERNAL_SUBMISSION:'false'}}]));
test('monitor fails on a foreign project, divergent images, restarts and submission flags',()=>{
 assert.deepEqual(assess(healthy()),[]);
 const foreign=healthy();foreign.api.project='another-project';assert.ok(assess(foreign).includes('api:project_binding'));
 const mixed=healthy();mixed.worker.image='sha256:'+'b'.repeat(64);assert.ok(assess(mixed).includes('release_images_differ'));
 const restarted=healthy();restarted.scheduler.restarts=1;assert.ok(assess(restarted).includes('scheduler:unexpected_restart'));
 const unsafe=healthy();unsafe.api.flags.EXTERNAL_SUBMISSION_ENABLED='true';assert.ok(assess(unsafe).includes('api:external_submission'));
 assert.ok(assess({}).length>0);
});
