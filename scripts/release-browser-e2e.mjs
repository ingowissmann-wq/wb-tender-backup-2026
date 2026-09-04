import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const baseURL = process.env.E2E_BASE_URL || "http://api:4240";
const marker = "WB_RELEASE_REHEARSAL_20260904";
const fixtureUuid = (name) => {
  const bytes = crypto.createHash("sha256").update(`${marker}:${name}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [bytes.subarray(0, 4), bytes.subarray(4, 6), bytes.subarray(6, 8), bytes.subarray(8, 10), bytes.subarray(10)].map((part) => part.toString("hex")).join("-");
};
const secret = async (name) => (await readFile(process.env[`${name}_FILE`], "utf8")).trim();
const email = await secret("E2E_EMAIL"), password = await secret("E2E_PASSWORD"), totpSecret = await secret("E2E_TOTP");
const base32 = (value) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of value.toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  return Buffer.from(bytes);
};
const totp = () => {
  const counter = Math.floor(Date.now() / 30_000), input = Buffer.alloc(8);
  input.writeBigUInt64BE(BigInt(counter));
  const hash = crypto.createHmac("sha1", base32(totpSecret)).update(input).digest(), offset = hash.at(-1) & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
};
const nextTotp = async (previous) => {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const candidate = totp();
    if (candidate !== previous) return candidate;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("next_totp_window_unavailable");
};
const login = async (page, returnTo, code) => {
  await page.goto(`${baseURL}/admin/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByLabel("E-Mail").fill(email);
  await page.getByLabel("Passwort").fill(password);
  await page.getByRole("button", { name: "Weiter" }).click();
  await page.getByLabel("Authenticator-Code").waitFor({ state: "visible" });
  assert.equal((await page.context().cookies()).some((cookie) => cookie.name === "wb_session"), false, "password step must not create a session");
  assert.match(code, /^\d{6}$/, "generated TOTP has an invalid shape");
  await page.getByLabel("Authenticator-Code").fill(code);
  const mfaResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/admin/v1/iam/mfa"));
  await page.getByRole("button", { name: "Sicher anmelden" }).click({ noWaitAfter: true });
  const response = await mfaResponse;
  const submitted = response.request().postDataJSON();
  assert.match(String(submitted.challenge || ""), /^[A-Za-z0-9_-]{32,512}$/, "browser submitted an invalid MFA challenge");
  assert.match(String(submitted.code || ""), /^\d{6}$/, "browser submitted an invalid TOTP shape");
  assert.equal(response.status(), 200, `MFA request failed with HTTP ${response.status()}`);
  let sessionPresent = false;
  for (let attempt = 0; attempt < 40 && !sessionPresent; attempt += 1) {
    sessionPresent = (await page.context().cookies()).some((cookie) => cookie.name === "wb_session");
    if (!sessionPresent) await page.waitForTimeout(50);
  }
  assert.ok(sessionPresent, "MFA response did not set the session cookie");
};

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const request = async (method, path, options = {}) => {
    try {
      return await context.request[method](`${baseURL}${path}`, { timeout: 180_000, ...options });
    } catch (error) {
      throw new Error(`browser_request_failed:${method.toUpperCase()}:${path}:${error?.name || "Error"}`);
    }
  };
  const canonical = await request("get", "/admin/ausschreibungen", { maxRedirects: 0 });
  assert.equal(canonical.status(), 308);
  assert.equal(canonical.headers().location, "/admin/ausschreibungen/");
  assert.equal((await request("get", "/api/autopilot/navigation/overview")).status(), 401);

  const firstCode = totp();
  await login(page, "//outside.example.invalid/admin/", firstCode);
  await page.waitForURL(`${baseURL}/admin/ausschreibungen/`);
  assert.equal(new URL(page.url()).origin, new URL(baseURL).origin, "unsafe returnTo escaped the application origin");
  await context.clearCookies();

  const safeCode = await nextTotp(firstCode);
  await login(page, "/admin/ausschreibungen/?releaseJourney=1", safeCode);
  await page.waitForURL(`${baseURL}/admin/ausschreibungen/?releaseJourney=1`);
  const cookies = await context.cookies();
  const session = cookies.find((cookie) => cookie.name === "wb_session"), csrf = cookies.find((cookie) => cookie.name === "wb_csrf");
  assert.ok(session?.httpOnly, "session cookie must be HttpOnly");
  assert.equal(session?.secure, true, "session cookie must be Secure");
  assert.equal(session?.sameSite, "Strict");
  assert.ok(session?.value.length >= 40 && csrf?.value.length >= 40, "opaque session material missing");
  assert.equal(csrf?.httpOnly, false);
  await page.locator('link[rel="stylesheet"], script[src]').first().waitFor({ state: "attached" });
  await page.getByRole("button", { name: "Ausschreibungen" }).click();
  await page.locator("#content").waitFor();

  const paths = [
    "/api/tenders", "/api/sources", "/api/tasks", "/api/reminders",
    "/api/autopilot/navigation/overview", "/api/portals", "/api/profiles",
  ];
  for (const path of paths) assert.equal((await request("get", path)).status(), 200, path);
  const sources = await (await request("get", "/api/sources")).json();
  const sourceCodes = new Set((sources.items || []).map((item) => item.code));
  assert.ok(sourceCodes.has("TED") && sourceCodes.has("DOE"), "TED/DOE source status is incomplete");
  const portals = await (await request("get", "/api/portals")).json();
  assert.ok(Array.isArray(portals.items) && portals.items.length > 0, "connector status route returned no registered connectors");
  const tenders = await (await request("get", "/api/tenders")).json();
  assert.ok(Array.isArray(tenders.items) && tenders.items.length > 0, "no real tender route result available in restored source data");
  assert.ok(tenders.items.some((item) => item.offer_deadline), "real tender deadline is absent");
  const fixtureTender = tenders.items.find((item) => item.title === `${marker}_TENDER_A`);
  assert.ok(fixtureTender, "scoped synthetic rehearsal tender is absent from the real tender route");
  assert.equal(tenders.items.some((item) => item.title === `${marker}_TENDER_B`), false, "cross-company rehearsal tender leaked into the scoped list");
  const tenderId = String(fixtureTender.id), companyId = fixtureUuid("companyA"), foreignCompanyId = fixtureUuid("companyB"), foreignTenderId = fixtureUuid("tenderB"), lotKey = "LOT-REHEARSAL-1";
  assert.match(tenderId, /^[0-9a-f-]{36}$/i);
  assert.equal((await request("get", `/api/tenders/${tenderId}`)).status(), 200);
  assert.equal((await request("get", `/api/tenders/${foreignTenderId}`)).status(), 403, "foreign company tender was not denied");
  const mutationHeaders = { "x-csrf-token": csrf.value };
  const decision = await request("post", `/api/tenders/${tenderId}/bid-decision`, { headers: mutationHeaders, data: { companyId, lotKey, action: "REJECT", reason: `${marker} synthetic rehearsal decision` } });
  const decisionBody = await decision.json();
  assert.ok([200, 201].includes(decision.status()), `management decision failed with HTTP ${decision.status()}:${decisionBody.error || "unknown"}`);
  assert.equal(decisionBody.externalExecution, false);
  const locked = await request("post", `/api/tenders/${tenderId}/submission`, {
    headers: { "x-csrf-token": csrf.value },
    data: { acceptance: "isolated", externalWrite: false },
  });
  assert.equal(locked.status(), 423);
  const lockBody = await locked.json();
  assert.deepEqual({ transmitted: lockBody.transmitted, enabled: lockBody.external_submission_enabled }, { transmitted: false, enabled: false });
  const query = new URLSearchParams({ company: companyId, lot: lotKey });
  const workflowPaths = {
    documents: `/api/tenders/${tenderId}/document-workbench?${query}`,
    calculation: `/api/autopilot/calculation/${tenderId}?${query}`,
    management: `/api/tenders/${tenderId}/management-output?${query}`,
    decision: `/api/tenders/${tenderId}/bid-decision-context?${query}`,
  };
  const workflowCoverage = {};
  for (const [name, path] of Object.entries(workflowPaths)) workflowCoverage[name] = (await request("get", path)).status() === 200;
  assert.deepEqual(workflowCoverage, { documents: true, calculation: true, management: true, decision: true });
  assert.equal((await request("get", `/api/autopilot/calculation/${tenderId}?company=${foreignCompanyId}&lot=${lotKey}`)).status(), 403, "foreign company calculation context was not denied");
  assert.equal((await request("get", `/api/tenders/${tenderId}/management-output?company=${foreignCompanyId}&lot=${lotKey}`)).status(), 403, "foreign company management context was not denied");
  assert.equal((await request("post", `/api/tenders/${foreignTenderId}/tasks`, { headers: mutationHeaders, data: { title: `${marker}_FORBIDDEN_TASK` } })).status(), 403, "foreign tender task write was not denied");
  assert.equal((await request("post", `/api/tenders/${foreignTenderId}/reminders`, { headers: mutationHeaders, data: { remindAt: "2099-09-22T12:00:00Z" } })).status(), 403, "foreign tender reminder write was not denied");
  assert.equal((await request("post", `/api/tenders/${tenderId}/tasks`, { headers: mutationHeaders, data: { title: `${marker}_TASK_HTTP`, dueAt: "2099-09-22T12:00:00Z" } })).status(), 200);
  assert.equal((await request("post", `/api/tenders/${tenderId}/reminders`, { headers: mutationHeaders, data: { remindAt: "2099-09-23T12:00:00Z" } })).status(), 200);
  const taskItems = (await (await request("get", "/api/tasks")).json()).items || [];
  const reminderItems = (await (await request("get", "/api/reminders")).json()).items || [];
  assert.ok(taskItems.some((item) => item.title === `${marker}_TASK_SEEDED`) && taskItems.some((item) => item.title === `${marker}_TASK_HTTP`));
  assert.ok(reminderItems.filter((item) => item.tender_id === tenderId).length >= 2);
  const uiViews = ["documents", "calculation", "management-output"];
  for (const view of uiViews) {
    await page.goto(`${baseURL}/autopilot/${view}?tender=${tenderId}&company=${companyId}&lot=${lotKey}`, { waitUntil: "networkidle" });
    await page.locator("#autopilot-content").waitFor({ state: "visible" });
    assert.equal(await page.locator('[role="alert"]').count(), 0, `${view} UI route rendered an error`);
  }
  await page.goto(`${baseURL}/admin/ausschreibungen/`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Aufgaben" }).click();
  await page.getByText(`${marker}_TASK_HTTP`, { exact: true }).waitFor();
  await page.getByRole("button", { name: "Wiedervorlagen" }).click();
  await page.getByText(`${marker}_TENDER_A`, { exact: true }).first().waitFor();
  console.log(JSON.stringify({ passed: true, passwordStep: true, mfaStep: true, httpOnlySession: true, safeReturnTo: true, unsafeReturnToRejected: true, realRoutes: paths.length + Object.keys(workflowPaths).length + uiViews.length + 8, workflowCoverage, taskWorkflow: true, reminderWorkflow: true, managementDecision: true, tenantIsolation: true, rbacIsolation: true, http423: true, runtimeDataLogged: false }));
} finally {
  await browser.close();
}
