import fs from "node:fs";
import http from "node:http";
import { chromium } from "playwright";

const baseUrl = String(process.env.PORTAL_CANARY_BASE_URL || "").replace(/\/$/, "");
const sessionFile = process.env.PORTAL_CANARY_SESSION_FILE;
if (!baseUrl || !sessionFile) throw new Error("PORTAL_CANARY_BASE_URL and PORTAL_CANARY_SESSION_FILE are required");
const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
const expectBroken = process.env.PORTAL_EXPECT_BROKEN === "true";
const target = new URL(baseUrl);
const proxy = http.createServer((request, response) => {
  const path = String(request.url || "/").replace(/^\/admin\/ausschreibungen/, "").replace(/^\/api\/tender(?=\/|$)/, "/api") || "/";
  const upstream = http.request({ hostname: target.hostname, port: target.port, path, method: request.method, headers: { ...request.headers, host: target.host } }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => { response.writeHead(502); response.end("upstream unavailable"); });
  request.pipe(upstream);
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const testBaseUrl = `http://127.0.0.1:${proxy.address().port}`;
const browser = await chromium.launch({ headless: true });
const results = [];
console.log(JSON.stringify({ phase: "browser_started", isolated: true }));

try {
  for (const [name, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    await context.addCookies([
      { name: "wb_session", value: session.token, url: testBaseUrl, httpOnly: true, sameSite: "Lax" },
      { name: "wb_csrf", value: session.csrf, url: testBaseUrl, sameSite: "Lax" },
    ]);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const pageErrors = [], consoleErrors = [], portalRequests = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text().replace(/[A-Za-z0-9_-]{30,}/g, "[REDACTED]")); });
    page.on("response", (response) => {
      if (response.url().includes("/portal-access/for-tender/")) {
        const url = new URL(response.url());
        portalRequests.push({ method: response.request().method(), status: response.status(), path: url.pathname, companyBound: Boolean(url.searchParams.get("company")), lotBound: url.searchParams.has("lot") });
      }
    });
    await page.goto(testBaseUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    console.log(JSON.stringify({ phase: "page_loaded", viewport: name, path: new URL(page.url()).pathname, title: await page.title(), body: (await page.locator("body").innerText()).slice(0, 180) }));
    await page.getByRole("button", { name: "Management-Inbox" }).click();
    const button = page.locator('[data-open-portal-access]').first();
    await button.waitFor({ timeout: 15000 });
    console.log(JSON.stringify({ phase: "button_found", viewport: name }));
    const evidence = await button.evaluate((element) => ({
      type: element.getAttribute("type"),
      tenderAttribute: element.getAttribute("data-tender"),
      manageUrlPresent: Boolean(element.getAttribute("data-manage-url")),
      portalHost: element.getAttribute("data-portal-host"),
    }));
    const portalRequestsBeforeClick = portalRequests.length;
    await button.click();
    if (expectBroken) {
      await page.waitForTimeout(300);
      results.push({ name, viewport, evidence, dialogOpen: await page.locator("#portal-access-dialog[open]").count() === 1, clickPortalRequests: portalRequests.slice(portalRequestsBeforeClick), pageErrors, consoleErrors });
      await context.close();
      continue;
    }
    const dialog = page.locator("#portal-access-dialog[open]");
    await dialog.waitFor();
    await dialog.getByText("Kanonischer Portalhost", { exact: true }).waitFor();
    const dialogText = await dialog.innerText(), dialogHtml = await dialog.innerHTML();
    const safeMetadataVisible = ["MeinAuftrag / RIB", "www.meinauftrag.rib.de", "Leistungsbereich", "Benutzername / E-Mail", "MFA erforderlich", "Loginseite noch nicht verifiziert", "Registrierungsseite noch nicht verifiziert"].every((value) => dialogText.includes(value));
    const noSecretMaterial = !/(ciphertext|auth_tag|totpSeed|recoveryCodes|BEGIN [A-Z ]*PRIVATE KEY)/i.test(dialogHtml);
    await dialog.getByRole("button", { name: "Abbrechen" }).click();
    const cancelClosed = await page.locator("#portal-access-dialog[open]").count() === 0;
    await button.click();
    await dialog.waitFor();
    const repeatedOpenSingleDialog = await page.locator("#portal-access-dialog").count() === 1;
    await dialog.getByRole("button", { name: "Abbrechen" }).click();
    const denyRoute = async (route) => route.fulfill({ status: 403, contentType: "application/json", body: '{"error":"company_scope_forbidden"}' });
    await page.route("**/api/portal-access/for-tender/**", denyRoute);
    await button.click();
    await dialog.getByText("Sie besitzen keine Berechtigung zur Verwaltung dieses Portalzugangs.", { exact: true }).waitFor();
    const forbiddenVisible = true;
    await page.unroute("**/api/portal-access/for-tender/**", denyRoute);
    results.push({
      name,
      viewport,
      evidence,
      dialogOpen: true,
      safeMetadataVisible,
      cancelClosed,
      repeatedOpenSingleDialog,
      forbiddenVisible,
      noSecretMaterial,
      mutationRequests: portalRequests.filter((request) => request.method !== "GET").length,
      portalRequests,
      pageErrors,
      consoleErrors,
      unexpectedConsoleErrors: consoleErrors.filter((message) => !/status of 403 \(Forbidden\)/.test(message)),
    });
    await context.close();
  }
  const passed = expectBroken
    ? results.every((item) => !item.dialogOpen && item.pageErrors.some((error) => /esc is not defined/.test(error)))
    : results.every((item) => item.dialogOpen && item.safeMetadataVisible && item.cancelClosed && item.repeatedOpenSingleDialog && item.forbiddenVisible && item.noSecretMaterial && item.mutationRequests === 0 && item.portalRequests.some((request) => request.companyBound && request.lotBound) && item.pageErrors.length === 0 && item.unexpectedConsoleErrors.length === 0);
  console.log(JSON.stringify({ passed, expectedBroken: expectBroken, isolated: true, results }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => proxy.close(resolve));
}
