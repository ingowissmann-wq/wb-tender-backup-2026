import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const overlay = new URL(
  "../deployment/context-portal-readiness-128-overlay/platform/autopilot-pipeline-worker.mjs",
  import.meta.url,
);
const shipped = new URL("../platform/autopilot-pipeline-worker.mjs", import.meta.url);
const worker = readFileSync(existsSync(fileURLToPath(overlay)) ? overlay : shipped, "utf8");

test("portal authentication is serialized by exact company, portal and credential", () => {
  const start = worker.indexOf("export async function restoreOrLoginPortalSession");
  const end = worker.indexOf("async function portalReadHeaders", start);
  const implementation = worker.slice(start, end);

  assert.ok(implementation.includes("portal-auth:${companyId}:${portal.id}:${credential.id}"));
  assert.ok(implementation.includes("pg_advisory_lock(hashtextextended($1,0))"));
  assert.ok(implementation.includes("pg_advisory_unlock(hashtextextended($1,0))"));
  assert.ok(implementation.includes("portal_id=$1 AND credential_id=$2 AND company_id=$3"));
  assert.ok(implementation.indexOf("pg_advisory_lock") < implementation.indexOf("currentSession"));
  assert.ok(implementation.indexOf("currentSession") < implementation.indexOf("authenticatePortal("));
});

test("portal authentication lock is released from finally and rejects incomplete scope", () => {
  const start = worker.indexOf("export async function restoreOrLoginPortalSession");
  const end = worker.indexOf("async function portalReadHeaders", start);
  const implementation = worker.slice(start, end);

  assert.ok(implementation.includes('code: "COMPANY_SCOPE_MISMATCH"'));
  assert.match(implementation, /finally\s*\{/);
  assert.ok(implementation.includes("lockClient.release()"));
});

test("browser failures retain safe phase and class evidence", () => {
  const start = worker.indexOf("async function portalReadHeaders");
  const end = worker.indexOf("async function registeredPublicNetServerPortal", start);
  const implementation = worker.slice(start, end);

  for (const field of ["result.failurePhase", "result.failureClass", "result.failureReason"])
    assert.ok(implementation.includes(field), field);
});

test("pipeline document authentication cannot recursively fan out", () => {
  const verificationStart = worker.indexOf("async function verifyStoredPortalSession");
  const restoreStart = worker.indexOf(
    "export async function restoreOrLoginPortalSession",
    verificationStart,
  );
  const verification = worker.slice(verificationStart, restoreStart);
  assert.ok(verification.includes("context.enqueueFanout !== false"));

  const headersStart = worker.indexOf("async function portalReadHeaders");
  const headersEnd = worker.indexOf("async function registeredPublicNetServerPortal", headersStart);
  const headers = worker.slice(headersStart, headersEnd);
  assert.ok(headers.includes("enqueueFanout: false"));
  assert.ok(headers.includes("allowAutomaticLogin: false"));

  const documentStart = worker.indexOf("async function processDeutscheEvergabe(");
  const documentEnd = worker.indexOf("async function processDocuments", documentStart);
  const documentWorkflow = worker.slice(documentStart, documentEnd);
  assert.ok(documentWorkflow.includes("enqueueFanout: false"));
  assert.ok(documentWorkflow.includes("allowAutomaticLogin: false"));
});

test("only explicit login actions may submit stored credentials", () => {
  const start = worker.indexOf("export async function restoreOrLoginPortalSession");
  const end = worker.indexOf("async function portalReadHeaders", start);
  const implementation = worker.slice(start, end);

  assert.ok(implementation.includes("context.allowAutomaticLogin === false"));
  assert.ok(
    implementation.indexOf("context.allowAutomaticLogin === false") <
      implementation.indexOf("const loggedIn = await authenticatePortal"),
  );
  assert.ok(implementation.includes('resultCode: "SESSION_NICHT_FUER_DOWNLOAD_GUELTIG"'));
});
