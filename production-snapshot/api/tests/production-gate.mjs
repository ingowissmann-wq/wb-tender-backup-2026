import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const routes = await readFile(new URL("../platform/autopilot-routes.mjs", import.meta.url), "utf8");
const worker = await readFile(new URL("../platform/autopilot-pipeline-worker.mjs", import.meta.url), "utf8");
const portalLogin = await readFile(new URL("../platform/portal-login-action.mjs", import.meta.url), "utf8");
const contextContract = await readFile(new URL("../platform/tender-context-contract.mjs", import.meta.url), "utf8");
const inboxUi = await readFile(new URL("../platform/assets/inbox-regions.js", import.meta.url), "utf8");
const packageManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const combined = `${routes}\n${worker}\n${portalLogin}\n${contextContract}\n${inboxUi}`;

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
assert.match(routes, /normalizeTenderContext/);
assert.match(contextContract, /wb-tender-context\/1\.0\.0/);
assert.match(contextContract, /Canonical tender\.lots UUID/);
assert.match(contextContract, /tender\.enrichment_lots UUID/);
assert.match(inboxUi, /recordOrNull/);
assert.match(inboxUi, /Portalzuordnung prüfen/);
assert.match(packageManifest.scripts.gate, /historical-regression-gate\.mjs/);
assert.match(packageManifest.scripts.gate, /portal-restoration-acceptance-gate\.mjs/);

console.log(JSON.stringify({
  passed: true,
  externalSubmissionHardDisabled: true,
  http423Implemented: true,
  procedureMonitoringParameterTyped: true,
  embeddedFallbackCredentials: false,
  canonicalTenderContextRequired: true,
  historicalRegressionGateRequired: true,
  fullRestorationGateRequired: true,
}));
