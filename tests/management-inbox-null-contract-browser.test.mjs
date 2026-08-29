import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "playwright";

const browserPath = process.env.CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
const browserAvailable = existsSync(browserPath);
const ui = readFileSync(new URL("../platform/assets/inbox-regions.js", import.meta.url));
const company = "22222222-2222-4222-8222-222222222222";
const tenderWithoutPortal = "33333333-3333-4333-8333-333333333331";
const tenderWithPortal = "33333333-3333-4333-8333-333333333332";
const portal = "88888888-8888-4888-8888-888888888888";

const item = (tenderId, title, procurementPortal, mode) => ({
  tender_id: tenderId,
  company_id: company,
  lot_key: "LOT-1",
  title,
  buyer: "Synthetische Vergabestelle",
  classification: "CORE_REGION",
  company_name: "WB-Cleaning GmbH",
  service_line: "cleaning",
  source_code: "TED",
  offer_deadline: "2026-12-31T12:00:00Z",
  calculationStatus: "NOT_STARTED",
  managementOutputStatus: "NOT_CREATED",
  missingCalculationInputs: [],
  linkEvidence: {
    procurementPortal,
    missingReasons: { procurementPortal: procurementPortal ? null : "Kein autoritatives Vergabeportal ermittelt – Portalzuordnung prüfen" },
    documentEvidence: { code: "FETCH_NOT_RUN", label: "Abruf noch nicht ausgeführt", reason: "Noch kein Abruf.", fetched: 0, failed: 0, linksFound: 0 },
  },
  portal_navigation_href: mode === "edit"
    ? `/admin/ausschreibungen/portalzugaenge/bearbeiten?portalId=${portal}&companyId=${company}&tenderId=${tenderId}`
    : `/admin/ausschreibungen/portalzugaenge?companyId=${company}&tenderId=${tenderId}&mode=search`,
  portal_navigation_mode: mode,
});

test("management inbox renders null portal evidence and malformed portal items without collapsing the list", { skip: !browserAvailable }, async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (req.url === "/") {
      res.setHeader("content-type", "text/html");
      return res.end('<!doctype html><body><nav id="tabs"><button>Management-Inbox</button></nav><main id="content"></main><script src="/inbox-regions.js"></script></body>');
    }
    if (req.url === "/inbox-regions.js") {
      res.setHeader("content-type", "application/javascript; charset=utf-8");
      return res.end(ui);
    }
    if (req.url.startsWith("/api/management-inbox?")) return json(res, {
      items: [
        item(tenderWithoutPortal, "Ohne Portalauflösung", null, "search"),
        item(tenderWithPortal, "Mit Portalauflösung", { portalId: portal, portalName: "Testportal", url: "https://portal.example.invalid/tender" }, "edit"),
      ],
      total: 2,
      page: 1,
      pageSize: 50,
      hasMore: false,
      selectedCompany: "all",
      companies: [{ company_id: company, legal_name: "WB-Cleaning GmbH", service_line: "cleaning" }],
      counts: { CORE_REGION: 2 },
      recalculations: [],
    });
    if (req.url.startsWith(`/api/portal-access/for-tender/${tenderWithoutPortal}`)) return json(res, { items: [] });
    if (req.url.startsWith(`/api/portal-access/for-tender/${tenderWithPortal}`)) return json(res, { items: [null, {
      portal_id: portal,
      portal_name: "Testportal",
      domain: "portal.example.invalid",
      credential_status: "VALID",
      credential_status_label: "Gültiger Portalzugang vorhanden",
      credential_status_message: "Gültiger Portalzugang vorhanden.",
      document_status: "DOCUMENTS_AVAILABLE",
      documents_complete: true,
      credential: { configured: true, usernameMasked: "t***@example.invalid" },
      login_action: { type: "NONE", binding: { portal_id: portal, tender_id: tenderWithPortal, company_id: company, lot_key: "LOT-1" } },
      affected_document_items: [],
      missing_calculation_inputs: [],
    }] });
    res.statusCode = 404;
    return json(res, { error: "fixture_not_found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, executablePath: browserPath });
  t.after(() => browser.close());
  const page = await browser.newPage(), pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole("button", { name: "Management-Inbox" }).click();
  await page.getByRole("heading", { name: "Ohne Portalauflösung" }).waitFor();
  await page.getByRole("heading", { name: "Mit Portalauflösung" }).waitFor();
  await page.locator(`[data-portal-slot="${tenderWithPortal}"]`).scrollIntoViewIfNeeded();
  assert.equal(await page.getByText("Portalzuordnung prüfen", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Zugangsdaten hinterlegen", { exact: true }).count(), 0);
  await page.locator(`[data-portal-access="${portal}"]`).waitFor({ timeout: 10000 }).catch(async (error) => {
    throw new Error(`${error.message}\nREQUESTS=${JSON.stringify(requests)}\nHTML=${await page.locator("#content").innerHTML()}\nPAGE_ERRORS=${pageErrors.join(" | ")}`);
  });
  await page.getByText("Gültiger Portalzugang vorhanden", { exact: true }).first().waitFor();
  assert.equal(await page.getByText("Kein erneuter Abruf erforderlich", { exact: true }).count(), 1);
  assert.equal(await page.getByText(/ungültige Portalzugangsdatensätze wurden nicht als fehlender Zugang interpretiert/).count(), 1);
  assert.deepEqual(pageErrors, []);
  assert.equal(requests.some((request) => request.method !== "GET"), false);
});

const json = (res, value) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
};
