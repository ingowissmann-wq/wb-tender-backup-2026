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
// Login and MFA are owned by the Admin application. Its acceptance job writes
// a short-lived, MFA-verified session fixture; raw credentials never enter this
// container or Docker metadata.
assert.equal(auth.mfaVerified, true, "acceptance session must carry MFA evidence");
assert.ok(Array.isArray(auth.cookies) && auth.cookies.length >= 2);
await context.addCookies(auth.cookies.map((cookie) => ({ ...cookie, url: baseURL })));
await page.goto(`${baseURL}/admin/ausschreibungen/`);
await page.waitForURL(/\/admin\/ausschreibungen\/$/);
assert.ok((await context.cookies()).some((cookie) => cookie.httpOnly));
await page.locator('link[rel="stylesheet"], script[src]').first().waitFor();
const tenderId = auth.tenderId;
assert.match(tenderId, /^[0-9a-f-]{36}$/i);
for (const path of ["/api/tenders", "/api/sources", "/api/tasks", "/api/reminders", "/api/autopilot/navigation/overview", `/api/tenders/${tenderId}`, `/api/tenders/${tenderId}/document-workbench`, `/api/tenders/${tenderId}/calculation-inputs`, `/api/tenders/${tenderId}/management-output`, "/api/portals", "/api/profiles"]) {
  assert.equal((await context.request.get(baseURL + path)).status(), 200, path);
}
const csrf = auth.cookies.find((cookie) => cookie.name === "wb_csrf")?.value;
assert.ok(csrf, "CSRF cookie missing");
const locked = await context.request.post(`${baseURL}/api/tenders/${tenderId}/submission`, { headers: { "x-csrf-token": csrf }, data: auth.submissionContext });
assert.equal(locked.status(), 423);
assert.equal((await locked.json()).transmitted, false);
await browser.close();
