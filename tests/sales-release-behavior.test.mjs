import assert from "node:assert/strict";
import test from "node:test";
import { verifyWikosReadContract, wikOSConfiguration } from "../platform/wikos-connector.mjs";
import { enterpriseSubmissionAdapter } from "../platform/submission-adapters.mjs";

test("WIKOS/Kyntrivex production health configuration is TLS-only and forbids inline secrets", () => {
  assert.equal(wikOSConfiguration({ NODE_ENV: "production" }).healthURL, "https://api.kyntrivex.com/api/health");
  assert.throws(() => wikOSConfiguration({ NODE_ENV: "production", WIKOS_LOCAL_STUB: "true" }), /forbidden/);
  assert.throws(() => wikOSConfiguration({ WIKOS_BASE_URL: "https://wikos.example", WIKOS_CLIENT_ID: "id", WIKOS_CLIENT_SECRET: "not-allowed" }), /inline_secret_forbidden/);
  assert.throws(() => wikOSConfiguration({ WIKOS_HEALTH_URL: "http://wikos.example/api/health" }), /https_required/);
  assert.throws(() => wikOSConfiguration({ WIKOS_HEALTH_URL: "https://user:secret@wikos.example/api/health" }), /embedded_credentials_forbidden/);
});

test("marked local WIKOS stub verifies the read-only Kyntrivex contract", async () => {
  const config = wikOSConfiguration({ NODE_ENV: "test", WIKOS_LOCAL_STUB: "true" });
  const evidence = await verifyWikosReadContract(config, async (url, options) => {
    assert.equal(url, "http://wikos-stub:8080/v1/health");
    assert.equal(options.method, "GET");
    assert.equal(options.headers.accept, "application/json");
    return new Response(JSON.stringify({ system: "WIKOS", partner: "KYNTRIVEX", readOnly: true }), { status: 200 });
  });
  assert.equal(evidence.verified, true);
  assert.equal(evidence.mode, "LOCAL_STUB");
  assert.equal(evidence.readOnly, true);
  assert.equal(evidence.externalWrite, false);
});

test("WB-Tender connector validates the real Kyntrivex health response contract read-only", async () => {
  const config = wikOSConfiguration({ NODE_ENV: "production", WIKOS_HEALTH_URL: "https://api.kyntrivex.com/api/health" });
  const evidence = await verifyWikosReadContract(config, async (url, options) => {
    assert.equal(url, "https://api.kyntrivex.com/api/health");
    assert.deepEqual(options, { method: "GET", headers: { accept: "application/json" }, redirect: "error" });
    return new Response(JSON.stringify({ status: "ok", checks: { database: "up", redis: "up", optional: "not_configured" } }), { status: 200 });
  });
  assert.deepEqual(evidence.checks, { database: "up", redis: "up" });
  assert.equal(evidence.readOnly, true);
  assert.equal(evidence.externalWrite, false);
});

test("the registered tender submission adapter remains a real HTTP-423 lock", async () => {
  const result = await enterpriseSubmissionAdapter("TED").planFinalHandoff({ scope: { tenderId: "t", companyId: "c", portalId: "p" } });
  assert.equal(result.httpStatus, 423);
  assert.equal(result.bindingExecutionAllowed, false);
  assert.equal(result.transmitted, false);
});
