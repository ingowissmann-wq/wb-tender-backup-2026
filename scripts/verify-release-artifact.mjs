import { access, readFile } from "node:fs/promises";
import crypto from "node:crypto";

const required = [
  "package.json",
  "platform/server.mjs",
  "platform/autopilot-routes.mjs",
  "platform/autopilot-pipeline-worker.mjs",
  "platform/portal-login-action.mjs",
  "tests/production-gate.mjs",
  "scripts/release-readiness-gate.mjs",
  "scripts/generate-sbom.mjs",
];
const root = new URL("../", import.meta.url);
const hashes = {};
for (const relative of required) {
  const url = new URL(relative, root);
  await access(url);
  hashes[relative] = crypto.createHash("sha256").update(await readFile(url)).digest("hex");
}
console.log(JSON.stringify({ passed: true, requiredFiles: required.length, hashes }));
