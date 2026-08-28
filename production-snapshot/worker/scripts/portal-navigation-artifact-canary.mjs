import fs from "node:fs";
import http from "node:http";
import pg from "pg";
import { chromium } from "playwright";

const appPort = Number(process.env.PORTAL_NAVIGATION_APP_PORT || 4261);
const session = JSON.parse(fs.readFileSync(process.env.PORTAL_CANARY_SESSION_FILE, "utf8"));
const pool = new pg.Pool({
  connectionString: fs.readFileSync(process.env.DATABASE_URL_FILE || "/run/secrets/database_url", "utf8").trim(),
  max: 1,
});
const tenderId = "0035e38a-6dba-4e10-a234-fedbc08415df";
const portalId = "42fe6df5-5e2f-4549-be4f-48c09dca37d9";
const release = "portal-management-20260820.2";

const proxy = http.createServer((request, response) => {
  const path = String(request.url || "/")
    .replace(/^\/admin\/ausschreibungen/, "")
    .replace(/^\/api\/tender(?=\/|$)/, "/api") || "/";
  const upstream = http.request(
    { hostname: "127.0.0.1", port: appPort, path, method: request.method, headers: { ...request.headers, host: `127.0.0.1:${appPort}` } },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", (error) => {
    response.writeHead(502, { "content-type": "text/plain" });
    response.end(error.message);
  });
  request.pipe(upstream);
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${proxy.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
    : {}),
});
const original = (
  await pool.query(
    "SELECT version.normalized_data,tender.company_id FROM tender.tender_versions version JOIN tender.tenders tender ON tender.id=version.tender_id WHERE version.tender_id=$1 ORDER BY version.version DESC LIMIT 1",
    [tenderId],
  )
).rows[0];
if (!original?.normalized_data) throw new Error("isolated fixture missing");
const companies = (
  await pool.query(
    `SELECT DISTINCT company.company_id,company.legal_name
     FROM tender.enterprise_company_links company
     JOIN tender.configuration_scopes scope ON scope.company_id=company.company_id
     WHERE company.active=true
       AND NOT EXISTS(
         SELECT 1 FROM tender.audit_events event
         WHERE event.action='tender_portal_mapping_confirmed'
           AND event.tender_id=$1
           AND event.metadata->>'companyId'=company.company_id::text
       )
     ORDER BY company.legal_name LIMIT 2`,
    [tenderId],
  )
).rows;
if (companies.length !== 2) throw new Error("two isolated company scopes required");

const contextFor = async (viewport, javaScriptEnabled = true) => {
  const context = await browser.newContext({ viewport, javaScriptEnabled });
  await context.addCookies([
    { name: "wb_session", value: session.token, url: baseUrl, httpOnly: true, sameSite: "Lax" },
    { name: "wb_csrf", value: session.csrf, url: baseUrl, sameSite: "Lax" },
  ]);
  return context;
};

const cardLink = async (page) => {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const input = page.locator("#q");
  await input.fill("Anonymisierte Canary-Ausschreibung 0035e38a");
  const card = page.locator("article.card").filter({ hasText: "Anonymisierte Canary-Ausschreibung 0035e38a" }).first();
  await card.waitFor();
  const link = card.getByRole("link", { name: "Portalzugang verwalten" });
  const evidence = await link.evaluate((node) => ({
    tagName: node.tagName,
    href: node.getAttribute("href"),
    onclick: node.getAttribute("onclick"),
  }));
  if (evidence.tagName !== "A" || !evidence.href || evidence.onclick)
    throw new Error(`semantic link contract failed: ${JSON.stringify(evidence)}`);
  return { link, evidence };
};

const assertDirectForm = async (page, companyName) => {
  await page.locator("#portal-direct-credential-form").waitFor();
  const text = await page.locator("main").innerText();
  for (const expected of [companyName, "MeinAuftrag / RIB", "www.meinauftrag.rib.de", "Benutzername oder E-Mail", "Passwort", "Sicher speichern", "Abbrechen", "Zur Ausschreibung zurück"])
    if (!text.includes(expected)) throw new Error(`direct form missing: ${expected}`);
  const meta = await page.locator('meta[name="wb-portal-navigation-release"]').getAttribute("content");
  if (meta !== release) throw new Error(`release mismatch: ${meta}`);
  const url = new URL(page.url());
  for (const forbidden of ["username", "password", "token", "secret", "credentialId"])
    if (url.searchParams.has(forbidden)) throw new Error(`secret-like URL parameter: ${forbidden}`);
};

const results = [];
try {
  const viewports = [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]];
  for (let index = 0; index < viewports.length; index++) {
    const [name, viewport] = viewports[index],
      company = companies[index],
      companyId = String(company.company_id);
    await pool.query("UPDATE tender.tenders SET company_id=$2 WHERE id=$1", [tenderId, companyId]);
    await pool.query(
      "UPDATE tender.tender_versions SET normalized_data=$2::jsonb WHERE tender_id=$1 AND version=(SELECT max(version) FROM tender.tender_versions WHERE tender_id=$1)",
      [tenderId, JSON.stringify(original.normalized_data)],
    );
    const recognizedContext = await contextFor(viewport), recognizedPage = await recognizedContext.newPage();
    const recognized = await cardLink(recognizedPage);
    const recognizedUrl = new URL(recognized.evidence.href, baseUrl);
    if (recognizedUrl.pathname !== "/admin/ausschreibungen/portalzugaenge/bearbeiten" || recognizedUrl.searchParams.get("portalId") !== portalId || recognizedUrl.searchParams.get("companyId") !== companyId || recognizedUrl.searchParams.get("tenderId") !== tenderId)
      throw new Error(`recognized href incorrect: ${recognizedUrl}`);

    const middlePagePromise = recognizedContext.waitForEvent("page");
    await recognized.link.click({ button: "middle" });
    const middlePage = await middlePagePromise;
    await middlePage.waitForLoadState("domcontentloaded");
    await assertDirectForm(middlePage, company.legal_name);
    await middlePage.close();

    await recognized.link.focus();
    await recognizedPage.keyboard.press("Enter");
    await assertDirectForm(recognizedPage, company.legal_name);

    const noJsContext = await contextFor(viewport, false), noJsPage = await noJsContext.newPage();
    await noJsPage.goto(new URL(recognized.evidence.href, baseUrl).href, { waitUntil: "domcontentloaded" });
    await assertDirectForm(noJsPage, company.legal_name);
    await noJsContext.close();
    await recognizedContext.close();

    const missingPayload = { raw: { uri: "https://oeffentlichevergabe.de/api/notices/canary-portal-access-button?format=ocds", tender: {} } };
    await pool.query(
      "UPDATE tender.tender_versions SET normalized_data=$2::jsonb WHERE tender_id=$1 AND version=(SELECT max(version) FROM tender.tender_versions WHERE tender_id=$1)",
      [tenderId, JSON.stringify(missingPayload)],
    );
    const missingContext = await contextFor(viewport), missingPage = await missingContext.newPage();
    const missing = await cardLink(missingPage), missingUrl = new URL(missing.evidence.href, baseUrl);
    if (missingUrl.pathname !== "/admin/ausschreibungen/portalzugaenge" || missingUrl.searchParams.get("mode") !== "search")
      throw new Error(`missing href incorrect: ${missingUrl}`);
    await missing.link.click();
    const search = missingPage.getByRole("textbox", { name: /Portalname, Betreiber, Domain oder Alias/ });
    await search.waitFor();
    if (!(await search.evaluate((node) => node === document.activeElement))) throw new Error("portal search not focused");
    await missingPage.getByText("Das Vergabeportal wurde in der Quelle nicht eindeutig angegeben. Bitte suchen und wählen Sie den korrekten Anbieter.", { exact: true }).waitFor();
    const choice = missingPage.locator(`[data-select-portal="${portalId}"]`);
    await choice.click();
    await assertDirectForm(missingPage, company.legal_name);
    results.push({ name, company: company.legal_name, recognizedHref: recognized.evidence.href, missingHref: missing.evidence.href, enter: true, middleClick: true, noJavaScriptNavigation: true, focusedSearch: true, directForm: true, release });
    await missingContext.close();
  }
  console.log(JSON.stringify({ passed: true, isolated: true, productionMutation: false, results }, null, 2));
} finally {
  await pool.query(
    "UPDATE tender.tender_versions SET normalized_data=$2::jsonb WHERE tender_id=$1 AND version=(SELECT max(version) FROM tender.tender_versions WHERE tender_id=$1)",
    [tenderId, JSON.stringify(original.normalized_data)],
  );
  await pool.query("UPDATE tender.tenders SET company_id=$2 WHERE id=$1", [tenderId, original.company_id]);
  await browser.close();
  await pool.end();
  await new Promise((resolve) => proxy.close(resolve));
}
