import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const baseURL = process.env.E2E_BASE_URL || "http://api:4240";
const auth = JSON.parse(await readFile(process.env.E2E_AUTH_FILE, "utf8"));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const canonical = await context.request.get(`${baseURL}/admin/ausschreibungen`, { maxRedirects: 0 });
assert.equal(canonical.status(), 308);
assert.equal(canonical.headers().location, "/admin/ausschreibungen/");
assert.equal((await context.request.get(`${baseURL}/api/autopilot/navigation/overview`)).status(), 401);
await page.goto(`${baseURL}/admin/ausschreibungen/`);
assert.match(page.url(), /\/admin\/login\?returnTo=/);
await page.getByLabel(/email/i).fill(auth.email);
await page.getByLabel(/password/i).fill(auth.password);
await page.getByRole("button", { name: /sign in|anmelden/i }).click();
if (page.url().includes("mfa")) {
  await page.getByLabel(/code/i).fill(auth.mfaCode);
  await page.getByRole("button", { name: /verify|bestätigen/i }).click();
}
await page.waitForURL(/\/admin\/ausschreibungen\/$/);
assert.ok((await context.cookies()).some((cookie) => cookie.httpOnly));
await page.locator('link[rel="stylesheet"], script[src]').first().waitFor();
for (const path of ["/api/autopilot/navigation/overview", "/api/tender/sources/ted", "/api/tender/sources/doe", "/api/tender/deadlines", "/api/tender/connectors", "/api/tender/documents", "/api/admin/roles", "/api/admin/plans"]) {
  assert.equal((await context.request.get(baseURL + path)).status(), 200, path);
}
assert.equal((await context.request.post(`${baseURL}/api/tender/submissions`, { data: {} })).status(), 423);
await browser.close();
