import test from 'node:test';
import assert from 'node:assert/strict';
import {submissionRuntimePolicy,assertSubmissionSchema} from '../platform/submission-runtime-policy.mjs';
test('disabled production remains supported',()=>assert.equal(submissionRuntimePolicy({EXTERNAL_SUBMISSION_ENABLED:'false',WB_TENDER_ALLOW_EXTERNAL_SUBMISSION:'false'}).enabled,false));
test('enabled runtime requires a dedicated validated worker mode',()=>{const env={EXTERNAL_SUBMISSION_ENABLED:'true',WB_TENDER_ALLOW_EXTERNAL_SUBMISSION:'true'};assert.throws(()=>submissionRuntimePolicy(env),/dedicated_worker/);assert.equal(submissionRuntimePolicy({...env,SUBMISSION_EXECUTION_MODE:'DEDICATED_VALIDATED_WORKER'}).enabled,true)});
test('mismatched or missing flags fail before starting a service',()=>{for(const env of [{},{EXTERNAL_SUBMISSION_ENABLED:'true',WB_TENDER_ALLOW_EXTERNAL_SUBMISSION:'false'},{EXTERNAL_SUBMISSION_ENABLED:'false',WB_TENDER_ALLOW_EXTERNAL_SUBMISSION:'true'}])assert.throws(()=>submissionRuntimePolicy(env),/inconsistent/)});

test('service startup rejects an unapplied submission migration',async()=>{await assert.rejects(assertSubmissionSchema({query:async()=>({rows:[{ready:false}]})}),/migration_required/);await assertSubmissionSchema({query:async()=>({rows:[{ready:true}]})})});
