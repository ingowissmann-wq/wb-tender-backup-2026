import fs from "node:fs";
import { chromium } from "playwright";

const session = JSON.parse(fs.readFileSync("/tmp/green-admin-session.json", "utf8"));
const proxyIp = process.env.GREEN_PROXY_IP;
if (!proxyIp) throw new Error("GREEN_PROXY_IP required");

const portalId = "5dc14f20-4da2-42a9-88e0-54d0a3516556";
const displayTender = "e34f1873-a2ae-4a97-8d5b-b5d046f7f692";
const displayCompany = "08dd8151-c950-4975-aa75-e882bdcf395c";
const testTender = "7d950556-b592-4c2b-b31c-7740088d9c5e";
const testCompany = "7edf1812-b5e9-4b5c-addf-95d2339362b3";
const screenshotDir = "/tmp/green-acceptance";
fs.mkdirSync(screenshotDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: "/usr/bin/chromium-browser",
  args: [
    "--no-sandbox",
    `--host-resolver-rules=MAP admin.wb-holding.ag ${proxyIp},MAP www.wb-holding.ag ${proxyIp},EXCLUDE localhost`,
  ],
});

const results = { pages: [], portalButton: [], jobs: [] };

async function waitForJob(page, jobId) {
  let current = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    current = await page.evaluate(async (id) => {
      const response = await fetch(`/api/tender/management-inbox/autopilot/jobs/${id}`, { credentials: "include" });
      return { httpStatus: response.status, body: await response.json() };
    }, jobId);
    if (["SUCCEEDED", "FAILED", "DEAD", "DEAD_LETTER", "CANCELLED"].includes(current.body?.queue_status || current.body?.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return current;
}

try {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    const publicContext = await browser.newContext({ viewport, ignoreHTTPSErrors: true, locale: "de-DE" });
    const publicPage = await publicContext.newPage();
    const publicErrors = [];
    publicPage.on("console", (message) => { if (message.type() === "error") publicErrors.push(message.text()); });
    for (const path of ["/", "/karriere", "/karriere/geschaeftsfuehrer-reinigung-m-w-d-augsburg", "/application?job=geschaeftsfuehrer-reinigung-m-w-d-augsburg"]) {
      const response = await publicPage.goto(`https://www.wb-holding.ag${path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await publicPage.waitForTimeout(500);
      results.pages.push({ viewport: viewport.name, host: "www", path, status: response?.status(), title: await publicPage.title() });
    }
    await publicPage.screenshot({ path: `${screenshotDir}/website-${viewport.name}.png`, fullPage: true });
    results.pages.push({ viewport: viewport.name, host: "www", consoleErrors: publicErrors });
    await publicContext.close();

    const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true, locale: "de-DE" });
    await context.addCookies([
      { name: "wb_session", value: session.token, url: "https://admin.wb-holding.ag", secure: true, httpOnly: true, sameSite: "Lax" },
      { name: "wb_csrf", value: session.csrf, url: "https://admin.wb-holding.ag", secure: true, sameSite: "Lax" },
    ]);
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    const detailPath = `/admin/ausschreibungen/autopilot/detail?tender=${displayTender}&company=${displayCompany}&lot=LOT-0001`;
    const response = await page.goto(`https://admin.wb-holding.ag${detailPath}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction(() => !document.querySelector("#autopilot-content")?.textContent?.includes("Ansicht wird geladen"), null, { timeout: 60_000 });
    const button = page.locator(`[data-login-portal="${portalId}"]`).filter({ hasText: "Am Portal anmelden" }).first();
    await button.waitFor({ state: "visible", timeout: 30_000 });
    const box = await button.boundingBox();
    results.portalButton.push({
      viewport: viewport.name,
      status: response?.status(),
      label: (await button.innerText()).trim(),
      visible: Boolean(box && box.width > 0 && box.height > 0),
      enabled: await button.isEnabled(),
      unavailableNotice: await page.locator(`[data-login-unavailable="${portalId}"]`).count(),
      consoleErrors,
    });
    await page.screenshot({ path: `${screenshotDir}/admin-${viewport.name}.png`, fullPage: true });

    if (viewport.name === "desktop") {
      for (const actionType of ["TEST_PORTAL_CONNECTION", "TEST_DOCUMENT_FETCH"]) {
        const created = await page.evaluate(async ({ portalId, testCompany, testTender, actionType, csrf }) => {
          const response = await fetch(`/api/tender/portal-access/${portalId}/jobs`, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json", "x-csrf-token": csrf },
            body: JSON.stringify({ action_type: actionType, company_id: testCompany, tender_id: testTender }),
          });
          return { httpStatus: response.status, body: await response.json() };
        }, { portalId, testCompany, testTender, actionType, csrf: session.csrf });
        const jobId = created.body?.job_id;
        const completed = jobId ? await waitForJob(page, jobId) : null;
        results.jobs.push({
          actionType,
          createStatus: created.httpStatus,
          jobId,
          pollStatus: completed?.httpStatus,
          status: completed?.body?.status,
          queueStatus: completed?.body?.queue_status,
          currentStep: completed?.body?.current_step,
          progressPercent: completed?.body?.progress_percent,
          resultCode: completed?.body?.result_summary?.resultCode || null,
          connectionFunctional: completed?.body?.result_summary?.connectionFunctional ?? null,
          foundDocuments: completed?.body?.result_summary?.foundDocuments ?? completed?.body?.documents_found ?? null,
          errorCode: completed?.body?.error_code || null,
        });
      }
    }
    await context.close();
  }
} finally {
  await browser.close();
}

const pagePass = results.pages.filter((entry) => entry.status !== undefined).every((entry) => entry.status === 200)
  && results.pages.filter((entry) => entry.consoleErrors).every((entry) => entry.consoleErrors.length === 0);
const buttonPass = results.portalButton.every((entry) => entry.status === 200 && entry.label === "Am Portal anmelden" && entry.visible && entry.enabled && entry.unavailableNotice === 0 && entry.consoleErrors.length === 0);
const connection = results.jobs.find((entry) => entry.actionType === "TEST_PORTAL_CONNECTION");
const documentFetch = results.jobs.find((entry) => entry.actionType === "TEST_DOCUMENT_FETCH");
const passed = pagePass && buttonPass
  && connection?.status === "SUCCEEDED" && connection.resultCode === "LOGIN_SUCCEEDED" && connection.connectionFunctional === true
  && documentFetch?.status === "SUCCEEDED" && !documentFetch.errorCode;

console.log(JSON.stringify({ passed, pagePass, buttonPass, results, screenshotDir }, null, 2));
if (!passed) process.exitCode = 1;
