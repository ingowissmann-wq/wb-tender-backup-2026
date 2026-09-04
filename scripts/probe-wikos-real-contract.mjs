import crypto from "node:crypto";
import { writeFile } from "node:fs/promises";
import { defaultWikosHealthURL, verifyWikosReadContract, wikOSConfiguration } from "../platform/wikos-connector.mjs";

const output = process.env.WIKOS_EVIDENCE_FILE;
const sourceCommit = String(process.env.SOURCE_COMMIT || "").trim();
const imageDigest = String(process.env.RELEASE_IMAGE_DIGEST || "").trim();
if (!output || !sourceCommit || !/^(?:sha256:)?[0-9a-f]{64}$/i.test(imageDigest))
  throw new Error("wikos_evidence_binding_required");

const config = wikOSConfiguration(process.env);
if (config.mode !== "PRODUCTION_READ_ONLY") throw new Error("real_wikos_probe_cannot_use_stub");
const endpoint = new URL(config.healthURL);
if (endpoint.protocol !== "https:") throw new Error("real_wikos_probe_tls_required");

const responseMetadata = {};
const result = await verifyWikosReadContract(config, async (url, options) => {
  const response = await fetch(url, options);
  const bytes = Buffer.from(await response.arrayBuffer());
  responseMetadata.bodySha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  responseMetadata.bodyBytes = bytes.length;
  responseMetadata.contentType = String(response.headers.get("content-type") || "").split(";", 1)[0];
  return new Response(bytes, { status: response.status, headers: response.headers });
});

const schemaHash = crypto.createHash("sha256").update(JSON.stringify(result.schema)).digest("hex");
const lines = [
  `SOURCE_COMMIT=${sourceCommit}`,
  `RELEASE_IMAGE_DIGEST=${imageDigest.replace(/^sha256:/, "sha256:")}`,
  `ENDPOINT_ORIGIN=${endpoint.origin}`,
  `ENDPOINT_PATH=${endpoint.pathname}`,
  "TLS=true",
  `HTTP_STATUS=${result.httpStatus}`,
  `CONTENT_TYPE=${responseMetadata.contentType}`,
  `BODY_BYTES=${responseMetadata.bodyBytes}`,
  `BODY_SHA256=${responseMetadata.bodySha256}`,
  `SCHEMA_SHA256=${schemaHash}`,
  `STATUS=${result.status}`,
  `DATABASE_CHECK=${result.checks.database}`,
  `REDIS_CHECK=${result.checks.redis}`,
  "READ_ONLY=true",
  "EXTERNAL_WRITE=false",
  "PAYLOAD_LOGGED=false",
  "CREDENTIALS_LOGGED=false",
  "CONNECTOR_CONTRACT=PASS",
  "RESULT=PASS",
];
await writeFile(output, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ passed: true, endpoint: config.healthURL || defaultWikosHealthURL, httpStatus: result.httpStatus, status: result.status, checks: result.checks, bodySha256: responseMetadata.bodySha256, schemaSha256: schemaHash, payloadLogged: false, credentialsLogged: false, readOnly: true }));
