import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  portalNavigationHref,
  safePortalReturnTo,
} from "../platform/portal-navigation.mjs";
import { buildTenderLinkEvidence } from "../platform/tender-link-evidence.mjs";

const ui = readFileSync(
  new URL("../platform/assets/ui.js", import.meta.url),
  "utf8",
);
const routes = readFileSync(
  new URL("../platform/autopilot-routes.mjs", import.meta.url),
  "utf8",
);

const tenderId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const portalId = "33333333-3333-4333-8333-333333333333";

test("recognized portal link is a complete edit deep link without secrets", () => {
  const href = portalNavigationHref({ tenderId, companyId, portalId });
  const url = new URL(href, "https://admin.wb-holding.ag");
  assert.equal(url.pathname, "/admin/ausschreibungen/portalzugaenge/bearbeiten");
  assert.equal(url.searchParams.get("portalId"), portalId);
  assert.equal(url.searchParams.get("companyId"), companyId);
  assert.equal(url.searchParams.get("tenderId"), tenderId);
  assert.equal(url.searchParams.get("returnTo"), "/admin/ausschreibungen");
  assert.doesNotMatch(href, /password|username|token|secret|credentialId/i);
});

test("missing or ambiguous portal link is a focused search deep link", () => {
  const href = portalNavigationHref({ tenderId, companyId });
  const url = new URL(href, "https://admin.wb-holding.ag");
  assert.equal(url.pathname, "/admin/ausschreibungen/portalzugaenge");
  assert.equal(url.searchParams.get("mode"), "search");
  assert.equal(url.searchParams.get("companyId"), companyId);
  assert.equal(url.searchParams.get("tenderId"), tenderId);
});

test("return target is restricted to safe internal admin routes", () => {
  assert.equal(
    safePortalReturnTo(
      `/admin/ausschreibungen/autopilot/detail?tender=${tenderId}&company=${companyId}`,
    ),
    `/admin/ausschreibungen/autopilot/detail?tender=${tenderId}&company=${companyId}`,
  );
  for (const unsafe of [
    "https://evil.example/",
    "//evil.example/",
    "/admin/cms/",
    "/admin/ausschreibungen?token=secret",
  ])
    assert.equal(safePortalReturnTo(unsafe), "/admin/ausschreibungen");
});

test("rendered control is a semantic anchor with a server-provided href", () => {
  assert.match(
    ui,
    /<a class="button-link" data-portal-navigation="'\+esc\(item\.portal_navigation_mode\|\|"search"\)\+'" href="'\+esc\(item\.portal_navigation_href\)\+'">Portalzugang verwalten<\/a>/,
  );
  assert.doesNotMatch(ui, /onclick[^\n]*Portalzugang verwalten/i);
  assert.doesNotMatch(ui, /data-open-portal-access/);
});

test("deep links re-authorize tender, company, portal and exact credential scope", () => {
  const editRoute = routes.slice(
    routes.indexOf('"/portalzugaenge/bearbeiten"'),
    routes.indexOf('"/portalzugaenge"', routes.indexOf('"/portalzugaenge/bearbeiten"')),
  );
  for (const contract of [
    /visibleTender\(req, reply, tenderId\)/,
    /company_scope_forbidden/,
    /tender_company_scope_forbidden/,
    /tender_portal_scope_forbidden/,
  ]) assert.match(routes, contract);
  for (const contract of [
    /scope\.company_id=\$2/,
    /credential\.portal_id=\$1/,
    /credential_scope_ambiguous/,
  ]) assert.match(editRoute, contract);
  assert.match(routes, /safePortalReturnTo/);
});

test("TED and DOE publication sources are never treated as procurement portals", () => {
  const ted = buildTenderLinkEvidence({
    source_code: "TED",
    source_url: "https://ted.europa.eu/en/notice/-/detail/1-2026",
    normalized_data: { raw: { links: { html: { ENG: "https://ted.europa.eu/en/notice/-/detail/1-2026" } } } },
    enrichment_documents: [],
  });
  const doe = buildTenderLinkEvidence({
    source_code: "DOE",
    source_url: "https://oeffentlichevergabe.de/api/notices/example?format=ocds",
    normalized_data: { raw: { uri: "https://oeffentlichevergabe.de/api/notices/example?format=ocds" } },
    enrichment_documents: [],
  });
  assert.equal(ted.portalMapping.status, "PORTAL_ASSIGNMENT_REVIEW_REQUIRED");
  assert.equal(doe.portalMapping.status, "PORTAL_ASSIGNMENT_REVIEW_REQUIRED");
  assert.equal(ted.missingReasons.procurementPortal, "Kein autoritatives Vergabeportal ermittelt – Portalzuordnung prüfen");
  assert.equal(doe.missingReasons.procurementPortal, "Kein autoritatives Vergabeportal ermittelt – Portalzuordnung prüfen");
});
