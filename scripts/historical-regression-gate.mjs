import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";

const browserPath = process.env.CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
if (!existsSync(browserPath)) {
  console.error(JSON.stringify({ passed: false, error: "CHROMIUM_REQUIRED_FOR_RELEASE_GATE" }));
  process.exit(1);
}

const tests = [
  "tests/management-inbox-null-contract-browser.test.mjs",
  "tests/tender-context-contract.test.mjs",
  "tests/canonical-portal-access.test.mjs",
  "tests/portal-save-verify-version.test.mjs",
  "tests/management-inbox-pagination.test.mjs",
  "tests/canonical-action-context-systemwide.test.mjs",
  "tests/continuous-enrichment-context-binding.test.mjs",
  "tests/portal-credential-secret-rls.test.mjs",
  "tests/phase2-authoritative-portal-jobs.test.mjs",
  "tests/structured-regions.test.mjs",
  "tests/tender-link-evidence.test.mjs",
];
for (const file of tests) if (!existsSync(new URL(`../${file}`, import.meta.url))) {
  console.error(JSON.stringify({ passed: false, error: "HISTORICAL_REGRESSION_TEST_MISSING", file }));
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...tests], {
  cwd: new URL("../", import.meta.url),
  env: { ...process.env, CHROMIUM_EXECUTABLE_PATH: browserPath },
  stdio: "inherit",
});
if (result.error || result.status !== 0) {
  console.error(JSON.stringify({ passed: false, error: result.error?.message || "HISTORICAL_REGRESSION_FAILED", status: result.status }));
  process.exit(result.status || 1);
}
console.log(JSON.stringify({ passed: true, requiredTests: tests.length, browserRequired: true, skippedAllowed: false }));
