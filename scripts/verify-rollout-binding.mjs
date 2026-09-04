#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";

const fail = (message, code = 65) => {
  console.error(message);
  process.exit(code);
};
const required = (name) => {
  const value = String(process.env[name] || "").trim();
  if (!value) fail(`missing required environment: ${name}`, 64);
  return value;
};
const exactSha = (name, value = required(name)) => {
  if (!/^[0-9a-f]{64}$/.test(value)) fail(`${name} must be an exact lowercase sha256`, 64);
  return value;
};
const exactGit = (name) => {
  const value = required(name);
  if (!/^[0-9a-f]{40}$/.test(value)) fail(`${name} must be an exact lowercase git object id`, 64);
  return value;
};
const secureFile = (name, { rootOnly = false } = {}) => {
  const pathname = required(name);
  let stat;
  try { stat = fs.lstatSync(pathname); } catch { fail(`required file is unreadable: ${name}`, 66); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${name} must be a regular non-symlink file`, 66);
  if ((stat.mode & 0o077) !== 0 || (stat.mode & 0o700) > 0o600) fail(`${name} must have mode 0600 or stricter`, 66);
  if (rootOnly && stat.uid !== 0) fail(`${name} must be owned by root`, 66);
  try { fs.accessSync(pathname, fs.constants.R_OK); } catch { fail(`required file is unreadable: ${name}`, 66); }
  return pathname;
};
const parseExact = (pathname, expectedKeys, label) => {
  const text = fs.readFileSync(pathname, "utf8");
  if (!text.endsWith("\n")) fail(`${label} must end with a newline`);
  const result = new Map();
  for (const line of text.slice(0, -1).split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || result.has(match[1])) fail(`${label} contains malformed or duplicate fields`);
    result.set(match[1], match[2]);
  }
  if (result.size !== expectedKeys.length || expectedKeys.some((key) => !result.has(key))) {
    fail(`${label} field set is not exact`);
  }
  return result;
};
const expect = (fields, key, value, label) => {
  if (fields.get(key) !== value) fail(`${label} mismatch: ${key}`);
};

for (const inline of [
  "DATABASE_URL", "BACKUP_ENCRYPTION_KEY", "SESSION_PEPPER", "FIELD_ENCRYPTION_KEY",
  "PORTAL_CREDENTIAL_KEY", "E2E_PASSWORD", "E2E_TOTP", "PRODUCTION_SESSION",
  "SAAS_IAM_CLIENT_SECRET", "SAAS_IAM_SESSION_PEPPER", "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET", "SAAS_SMTP_PASSWORD", "SAAS_INVITATION_PEPPER",
]) if (String(process.env[inline] || "").length) fail(`inline secret is forbidden: ${inline}`, 64);
const applicationPrefix = /^(?:WB_|SAAS_|STRIPE_|E2E_|PORTAL_|DATABASE_|BACKUP_|SESSION_|FIELD_|PRODUCTION_)/;
const sensitiveSuffix = /(?:PASSWORD|TOKEN|SECRET|KEY|SESSION|CREDENTIAL|DATABASE_URL)$/;
for (const [name, value] of Object.entries(process.env)) {
  if (value && applicationPrefix.test(name) && sensitiveSuffix.test(name) && !name.endsWith("_FILE")) fail(`inline secret is forbidden: ${name}`, 64);
  if (value && applicationPrefix.test(name) && name.endsWith("_FILE") && /(?:PASSWORD|TOKEN|SECRET|KEY|SESSION|CREDENTIAL|DATABASE_URL)_FILE$/.test(name)) secureFile(name, { rootOnly: name === "PRODUCTION_SESSION_FILE" });
}

const expectedCommit = exactGit("EXPECTED_COMMIT");
const expectedTree = exactGit("EXPECTED_TREE");
const expectedImageId = `sha256:${exactSha("EXPECTED_RELEASE_IMAGE_ID", required("EXPECTED_RELEASE_IMAGE_ID").replace(/^sha256:/, ""))}`;
const expectedImageDigest = `sha256:${exactSha("EXPECTED_RELEASE_IMAGE_DIGEST", required("EXPECTED_RELEASE_IMAGE_DIGEST").replace(/^sha256:/, ""))}`;
const expectedEvidenceSha = exactSha("EXPECTED_EVIDENCE_SHA256");
const releaseImage = required("RELEASE_IMAGE");
if (!releaseImage.endsWith(`@${expectedImageDigest}`)) fail("RELEASE_IMAGE does not match the approved digest", 64);

const evidencePath = secureFile("REHEARSAL_EVIDENCE");
const approvalPath = secureFile("OPERATOR_APPROVAL", { rootOnly: true });
for (const name of ["DATABASE_URL_FILE", "BACKUP_ENCRYPTION_KEY_FILE", "PRODUCTION_SESSION_FILE"] ) secureFile(name, { rootOnly: name === "PRODUCTION_SESSION_FILE" });

const actualCommit = exactGit("ACTUAL_COMMIT");
const actualTree = exactGit("ACTUAL_TREE");
if (actualCommit !== expectedCommit) fail("checkout commit does not match EXPECTED_COMMIT");
if (actualTree !== expectedTree) fail("checkout tree does not match EXPECTED_TREE");
if (required("CHECKOUT_CLEAN") !== "true") fail("checkout is not clean");

const evidenceSha = crypto.createHash("sha256").update(fs.readFileSync(evidencePath)).digest("hex");
if (evidenceSha !== expectedEvidenceSha) fail("rehearsal evidence sha256 mismatch");
const evidenceKeys = [
  "EVIDENCE_VERSION", "SOURCE_COMMIT", "SOURCE_TREE", "RELEASE_IMAGE_ID", "RELEASE_IMAGE_DIGEST",
  "SOURCE_DUMP_SHA256", "WIKOS_EVIDENCE_SHA256", "RESULT", "PLAN_ROWS_SHA256", "IAM_ROWS_SHA256",
  "FIXTURE_NAMESPACE", "FIXTURE_CLEANUP_ABSENCE", "TENANT_ISOLATION", "RBAC_ISOLATION",
  "BROWSER_PASSWORD_MFA_RETURNTO", "DOCUMENT_WORKFLOW", "CALCULATION_WORKFLOW", "MANAGEMENT_WORKFLOW",
  "TASK_WORKFLOW", "REMINDER_WORKFLOW", "HTTP423", "WIKOS_REAL", "WIKOS_STUB_COMPONENT",
  "SAME_IMAGE_API_WORKER_SCHEDULER", "SCHEDULER", "ROLLBACK", "EXTERNAL_SUBMISSION",
];
const evidence = parseExact(evidencePath, evidenceKeys, "rehearsal evidence");
for (const [key, value] of Object.entries({
  EVIDENCE_VERSION: "1", SOURCE_COMMIT: expectedCommit, SOURCE_TREE: expectedTree,
  RELEASE_IMAGE_ID: expectedImageId, RELEASE_IMAGE_DIGEST: expectedImageDigest, RESULT: "PASS",
  FIXTURE_CLEANUP_ABSENCE: "PASS", TENANT_ISOLATION: "PASS", RBAC_ISOLATION: "PASS",
  BROWSER_PASSWORD_MFA_RETURNTO: "PASS", DOCUMENT_WORKFLOW: "PASS", CALCULATION_WORKFLOW: "PASS",
  MANAGEMENT_WORKFLOW: "PASS", TASK_WORKFLOW: "PASS", REMINDER_WORKFLOW: "PASS", HTTP423: "PASS",
  WIKOS_REAL: "PASS", WIKOS_STUB_COMPONENT: "PASS", SAME_IMAGE_API_WORKER_SCHEDULER: "PASS",
  SCHEDULER: "PASS", ROLLBACK: "PASS", EXTERNAL_SUBMISSION: "false",
})) expect(evidence, key, value, "rehearsal evidence");
for (const key of ["SOURCE_DUMP_SHA256", "WIKOS_EVIDENCE_SHA256", "PLAN_ROWS_SHA256", "IAM_ROWS_SHA256"] ) {
  if (!/^[0-9a-f]{64}$/.test(evidence.get(key))) fail(`rehearsal evidence invalid digest: ${key}`);
}
if (!/^WB_RELEASE_REHEARSAL_[A-Z0-9_-]+$/.test(evidence.get("FIXTURE_NAMESPACE"))) fail("rehearsal evidence fixture namespace is invalid");

const approvalKeys = ["APPROVAL_VERSION", "APPROVE_COMMIT", "APPROVE_TREE", "APPROVE_IMAGE_DIGEST", "APPROVE_EVIDENCE_SHA256", "EXTERNAL_SUBMISSION_ENABLED"];
const approval = parseExact(approvalPath, approvalKeys, "operator approval");
for (const [key, value] of Object.entries({
  APPROVAL_VERSION: "1", APPROVE_COMMIT: expectedCommit, APPROVE_TREE: expectedTree,
  APPROVE_IMAGE_DIGEST: expectedImageDigest, APPROVE_EVIDENCE_SHA256: expectedEvidenceSha,
  EXTERNAL_SUBMISSION_ENABLED: "false",
})) expect(approval, key, value, "operator approval");

if (required("ACTUAL_RELEASE_IMAGE_ID") !== expectedImageId) fail("release image ID mismatch");
if (required("ACTUAL_RELEASE_IMAGE_REVISION") !== expectedCommit) fail("release image revision label mismatch");
if (required("ACTUAL_RELEASE_IMAGE_TREE") !== expectedTree) fail("release image tree label mismatch");
console.log(JSON.stringify({ passed: true, commit: expectedCommit, tree: expectedTree, imageId: expectedImageId, imageDigest: expectedImageDigest, evidenceSha256: evidenceSha, externalSubmissionEnabled: false }));
