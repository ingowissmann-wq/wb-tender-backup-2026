import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const routes = await readFile(new URL("../platform/autopilot-routes.mjs", import.meta.url), "utf8");
const worker = await readFile(new URL("../platform/autopilot-pipeline-worker.mjs", import.meta.url), "utf8");
const portalLogin = await readFile(new URL("../platform/portal-login-action.mjs", import.meta.url), "utf8");
const combined = `${routes}\n${worker}\n${portalLogin}`;

assert.match(routes, /external_submission_disabled/);
assert.match(routes, /reply\.code\(423\)/);
assert.match(routes, /external_submission_enabled:\s*false/);
assert.match(routes, /transmitted:\s*false/);
assert.match(routes, /MANUAL_BID_SUBMISSION_RELEVANCE_OVERRIDE/);
assert.match(routes, /submission-relevance/);
assert.match(routes, /manual_submission_relevance_override IS DISTINCT FROM false/);
assert.match(worker, /\$2::text\),'MONITORING_CHANGE_REPROCESS'/);
assert.doesNotMatch(combined, /\.secrets\/access\.txt/i);
assert.doesNotMatch(combined, /(?:password|secret)\s*=\s*["'][^"']{8,}["']/i);

console.log(JSON.stringify({
  passed: true,
  externalSubmissionHardDisabled: true,
  http423Implemented: true,
  procedureMonitoringParameterTyped: true,
  embeddedFallbackCredentials: false,
}));
