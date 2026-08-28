import fs from "node:fs";
import http from "node:http";
import { chromium } from "playwright";

const baseUrl = String(process.env.PORTAL_CANARY_BASE_URL || "").replace(/\/$/, "");
const sessionFile = process.env.PORTAL_CANARY_SESSION_FILE;
if (!baseUrl || !sessionFile) throw new Error("PORTAL_CANARY_BASE_URL and PORTAL_CANARY_SESSION_FILE are required");
const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
const target = new URL(baseUrl);
const proxy = http.createServer((request, response) => {
  const path = String(request.url || "/")
    .replace(/^\/admin\/ausschreibungen/, "")
    .replace(/^\/api\/tender(?=\/|$)/, "/api") || "/";
  const upstream = http.request({ hostname: target.hostname, port: target.port, path, method: request.method, headers: { ...request.headers, host: target.host } }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", (error) => { response.writeHead(502, { "content-type": "text/plain" }); response.end(error.message); });
  request.pipe(upstream);
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const testBaseUrl = `http://127.0.0.1:${proxy.address().port}`;
const browser = await chromium.launch({ headless: true });
const results = [];

const checkViewport = async (name, viewport) => {
  const context = await browser.newContext({ viewport });
  await context.addCookies([
    { name: "wb_session", value: session.token, url: testBaseUrl, httpOnly: true, sameSite: "Lax" },
    { name: "wb_csrf", value: session.csrf, url: testBaseUrl, sameSite: "Lax" },
  ]);
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.goto(`${testBaseUrl}/`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Management-Inbox" }).click();
  try {
    await page.locator("#inbox-company").waitFor({ timeout: 15000 });
  } catch (error) {
    throw new Error(`${name}: inbox did not render; content=${JSON.stringify((await page.locator("#content").innerText()).slice(0, 500))}; pageErrors=${pageErrors.join(";")}; consoleErrors=${consoleErrors.join(";")}; ${error.message}`);
  }
  const counts = await page.locator(".region-counts strong").allTextContents();
  if (counts.reduce((sum, value) => sum + Number(value || 0), 0) <= 0) throw new Error(`${name}: Management-Inbox has no non-zero category count`);
  const inboxText = await page.locator("#content").innerText();
  if (/DOE_QUELLPAYLOAD|TED_QUELLPAYLOAD|ENRICHMENT_DOCUMENT/.test(inboxText)) throw new Error(`${name}: internal provenance is visible`);
  await page.locator("[data-region-detail]").first().click();
  await page.locator(".region-detail").waitFor();
  const detailText = await page.locator(".region-detail").innerText();
  if (!detailText.includes("Offizielle externe Ziele")) throw new Error(`${name}: external-target section missing in detail`);
  const detailOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (detailOverflow) throw new Error(`${name}: tender detail overflows viewport`);

  await page.goto(`${testBaseUrl}/autopilot/portal-access`, { waitUntil: "networkidle" });
  try {
    await page.getByRole("heading", { name: "Portalverwaltung" }).waitFor({ timeout: 15000 });
  } catch (error) {
    throw new Error(`${name}: portal overview did not render; content=${JSON.stringify((await page.locator("#autopilot-content").innerText()).slice(0, 700))}; pageErrors=${pageErrors.join(";")}; consoleErrors=${consoleErrors.join(";")}; ${error.message}`);
  }
  const ribCard = page.locator("article").filter({ hasText: /Meinauftrag|RIB/i }).first();
  await ribCard.waitFor();
  const configure = ribCard.locator("button[data-configure-portal]").first();
  await configure.click();
  await page.getByRole("heading", { name: "Offizielle Portalziele" }).waitFor();
  const portalText = await page.locator("#autopilot-content").innerText();
  if (!portalText.includes("Registrierungsseite")) throw new Error(`${name}: registration registry control missing`);
  if (!portalText.includes("Loginseite")) throw new Error(`${name}: login registry control missing`);
  const html = await page.locator("#autopilot-content").innerHTML();
  if (/ciphertext|auth_tag|totpSeed|recoveryCodes/i.test(html)) throw new Error(`${name}: secret field is rendered`);
  const portalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (portalOverflow) throw new Error(`${name}: portal-access view overflows viewport`);
  if (pageErrors.length) throw new Error(`${name}: page errors: ${pageErrors.join("; ")}`);
  results.push({ name, viewport, counts: counts.map(Number), detail: true, portalAccessManagement: true, noInternalProvenance: true, noSecretFields: true, responsive: true });
  await context.close();
};

try {
  await checkViewport("desktop", { width: 1440, height: 1000 });
  await checkViewport("mobile", { width: 390, height: 844 });
  console.log(JSON.stringify({ passed: true, isolated: true, results }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => proxy.close(resolve));
}
