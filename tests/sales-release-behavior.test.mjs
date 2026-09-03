import assert from "node:assert/strict";
import test from "node:test";
import { verifyWikosReadContract, wikOSConfiguration } from "../platform/wikos-connector.mjs";
import { enterpriseSubmissionAdapter } from "../platform/submission-adapters.mjs";

test("WIKOS/Kyntrivex production configuration fails closed and forbids inline secrets", () => {
  assert.throws(() => wikOSConfiguration({ NODE_ENV: "production" }), /WIKOS_BASE_URL/);
  assert.throws(() => wikOSConfiguration({ NODE_ENV: "production", WIKOS_LOCAL_STUB: "true" }), /forbidden/);
  assert.throws(() => wikOSConfiguration({ WIKOS_BASE_URL: "https://wikos.example", WIKOS_CLIENT_ID: "id", WIKOS_CLIENT_SECRET: "not-allowed" }), /inline_secret_forbidden/);
});

test("marked local WIKOS stub verifies the read-only Kyntrivex contract", async () => {
  const config = wikOSConfiguration({ NODE_ENV: "test", WIKOS_LOCAL_STUB: "true" });
  const evidence = await verifyWikosReadContract(config, async (url, options) => {
    assert.equal(url, "http://wikos-stub:8080/v1/health");
    assert.equal(options.headers.accept, "application/json");
    return new Response(JSON.stringify({ system: "WIKOS", partner: "KYNTRIVEX", readOnly: true }), { status: 200 });
  });
  assert.deepEqual(evidence, { verified: true, system: "WIKOS", partner: "KYNTRIVEX", readOnly: true, externalWrite: false });
});

test("the registered tender submission adapter remains a real HTTP-423 lock", async () => {
  const result = await enterpriseSubmissionAdapter("TED").planFinalHandoff({ scope: { tenderId: "t", companyId: "c", portalId: "p" } });
  assert.equal(result.httpStatus, 423);
  assert.equal(result.bindingExecutionAllowed, false);
  assert.equal(result.transmitted, false);
});
