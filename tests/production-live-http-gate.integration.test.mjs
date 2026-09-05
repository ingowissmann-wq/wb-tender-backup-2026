import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const gate = new URL("../deployment/production-live-http-gate.mjs", import.meta.url);

test("production live HTTP gate uses one exact configured Tender API base and sends no payload", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wb-live-http-gate-test-"));
  const sessionFile = path.join(temporary, "curl.config");
  await writeFile(sessionFile, `cookie = "wb_session=${"s".repeat(43)}; wb_csrf=${"c".repeat(43)}"\nheader = "x-csrf-token: ${"x".repeat(43)}"\n`);
  await chmod(sessionFile, 0o600);

  const requests = [];
  let actionStatus = 423;
  let actionBody = { external_submission_enabled: false, transmitted: false };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) });
      response.setHeader("content-type", "application/json");
      if (request.method === "GET" && request.url === "/api/tender/healthz") return response.end('{"ok":true}');
      if (request.method === "POST" && request.url === "/api/tender/tools/action/transmit") {
        response.statusCode = actionStatus;
        return response.end(JSON.stringify(actionBody));
      }
      response.statusCode = 404;
      return response.end('{"error":"not_found"}');
    });
  });
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const environment = (overrides = {}) => ({
    PATH: process.env.PATH,
    TMPDIR: temporary,
    ALLOW_LOOPBACK_HTTP: "true",
    PRODUCTION_BASE_URL: origin,
    PRODUCTION_SESSION_FILE: sessionFile,
    TENDER_API_BASE: "/api/tender",
    ...overrides,
  });
  const runGate = async (overrides = {}) => execFileAsync(process.execPath, [gate.pathname], { env: environment(overrides) });
  const rejection = async (overrides) => {
    try {
      await runGate(overrides);
      assert.fail("gate unexpectedly accepted invalid configuration or response");
    } catch (error) {
      assert.equal(error.code, 78);
      return error;
    }
  };

  const success = await runGate();
  assert.deepEqual(JSON.parse(success.stdout), {
    passed: true,
    health: "real-http",
    authenticated: true,
    externalActionPayload: "none",
    httpStatus: 423,
    external_submission_enabled: false,
    transmitted: false,
  });
  assert.deepEqual(requests.map(({ method, url }) => ({ method, url })), [
    { method: "GET", url: "/api/tender/healthz" },
    { method: "POST", url: "/api/tender/tools/action/transmit" },
  ]);
  assert.equal(requests.some(({ url }) => url.startsWith("/api/tools")), false, "legacy /api/tools fallback was requested");
  assert.equal(requests[1].body.length, 0, "external-action gate sent a payload");
  assert.equal(requests[1].headers["content-length"], undefined, "external-action gate declared a payload");

  const requestCountAfterSuccess = requests.length;
  for (const malformed of ["/", "api/tender", "/api/tender/", "/api//tender", "/api/../tools", "/api/tender?fallback=/api/tools", "https://example.invalid/api/tender"]) {
    const error = await rejection({ TENDER_API_BASE: malformed });
    assert.match(error.stderr, /tender API base path is invalid/);
  }
  for (const invalidOrigin of [`${origin}/api/tender`, `${origin}?api=/api/tender`, `${origin}#api-tender`]) {
    const error = await rejection({ PRODUCTION_BASE_URL: invalidOrigin });
    assert.match(error.stderr, /production base URL must be origin-only/);
  }
  assert.equal(requests.length, requestCountAfterSuccess, "invalid configuration reached the HTTP server");
  const insecureRemote = await rejection({ PRODUCTION_BASE_URL: "http://example.invalid" });
  assert.match(insecureRemote.stderr, /production base URL must use HTTPS/);

  actionBody = { external_submission_enabled: false, transmitted: true };
  const contractError = await rejection();
  assert.match(contractError.stderr, /HTTP 423 response did not prove the external submission lock/);
  assert.deepEqual(requests.slice(-2).map(({ url }) => url), ["/api/tender/healthz", "/api/tender/tools/action/transmit"]);
  assert.equal(requests.at(-1).body.length, 0, "failed contract probe sent a payload");

  actionStatus = 200;
  actionBody = { external_submission_enabled: false, transmitted: false };
  const statusError = await rejection();
  assert.match(statusError.stderr, /authenticated external-action probe did not return HTTP 423 \(200\)/);
});

test("production rollout entry points reject a conflicting Tender API base before side effects", async () => {
  const root = path.dirname(path.dirname(gate.pathname));
  const requiredRollout = {
    COMPOSE_FILE: "unused", COMPOSE_PROJECT_NAME: "unused", RELEASE_IMAGE: "unused", POSTGRES_IMAGE: "unused",
    DATABASE_URL_FILE: "unused", SESSION_PEPPER_FILE: "unused", FIELD_ENCRYPTION_KEY_FILE: "unused", BACKUP_DIR: "unused",
    BACKUP_ENCRYPTION_KEY_FILE: "unused", REHEARSAL_EVIDENCE: "unused", OPERATOR_APPROVAL: "unused", PRODUCTION_SESSION_FILE: "unused",
    PRODUCTION_CANARY_STATE_DIR: "unused", PRODUCTION_BASE_URL: "https://example.invalid", ROLLOUT_STATE_DIR: "unused",
    EXPECTED_COMMIT: "unused", EXPECTED_TREE: "unused", EXPECTED_RELEASE_IMAGE_ID: "unused", EXPECTED_RELEASE_IMAGE_DIGEST: "unused",
    EXPECTED_EVIDENCE_SHA256: "unused",
  };
  for (const script of ["deployment/production-rollout.sh", "deployment/production-rollout-with-iam-canary.sh"]) {
    try {
      await execFileAsync("bash", [script], {
        cwd: root,
        env: { PATH: process.env.PATH, TENDER_API_BASE: "/api", ...requiredRollout },
      });
      assert.fail(`${script} unexpectedly accepted the rehearsal API base`);
    } catch (error) {
      assert.equal(error.code, 64);
      assert.match(error.stderr, /production TENDER_API_BASE must be \/api\/tender/);
    }
  }
});
