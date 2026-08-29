import assert from "node:assert/strict";
import test from "node:test";
import { buildTenderLinkEvidence, safeExternalHttpsUrl } from "../platform/tender-link-evidence.mjs";

const portal = {
  id: "11111111-1111-4111-8111-111111111111",
  display_name: "Offizielles Vergabeportal",
  canonical_domain: "vergabe.example.de",
  allowed_subdomains: ["docs.vergabe.example.de"],
  authentication_entry_url: "https://vergabe.example.de/login",
  registration_entry_url: "https://vergabe.example.de/register",
  adapter_validation_status: "PRODUCTION_VALIDATED",
  last_verified_at: "2026-08-19T00:00:00Z",
};

test("external URL policy is HTTPS-only and rejects credentials, sessions and tokens", () => {
  assert.equal(safeExternalHttpsUrl("http://ted.europa.eu/notice/1"), null);
  assert.equal(safeExternalHttpsUrl("https://user:secret@ted.europa.eu/notice/1"), null);
  assert.equal(safeExternalHttpsUrl("https://ted.europa.eu/notice/1?access_token=secret"), null);
  assert.equal(safeExternalHttpsUrl("https://ted.europa.eu/notice;jsessionid=secret"), null);
  assert.equal(safeExternalHttpsUrl("https://ted.europa.eu/de/notice/-/detail/1#part"), "https://ted.europa.eu/de/notice/-/detail/1");
});

test("TED evidence separates the original notice from documents and never invents a portal", () => {
  const evidence = buildTenderLinkEvidence({
    source_code: "TED",
    source_url: "https://ted.europa.eu/de/notice/-/detail/570348-2026",
    external_id: "570348-2026",
    normalized_data: { raw: { links: { html: { DEU: "https://ted.europa.eu/de/notice/-/detail/570348-2026" }, pdf: { DEU: "https://ted.europa.eu/de/notice/-/detail/570348-2026/pdf" } } } },
  }, []);
  assert.equal(evidence.originalNotice.targetType, "ORIGINAL_NOTICE");
  assert.equal(evidence.documents[0].targetType, "DOCUMENTS");
  assert.equal(evidence.procurementPortal, null);
  assert.equal(evidence.missingReasons.procurementPortal, "Kein autoritatives Vergabeportal ermittelt – Portalzuordnung prüfen");
  assert.equal(evidence.electronicSubmission, null);
  assert.equal(evidence.documentEvidence.code, "FETCH_NOT_RUN");
});

test("DOE OCDS API is technical evidence while an explicit registry-bound tender page is the procurement portal", () => {
  const evidence = buildTenderLinkEvidence({
    source_code: "DOE",
    source_url: "https://oeffentlichevergabe.de/api/notices/abc?format=ocds",
    external_id: "abc",
    normalized_data: { raw: { uri: "https://oeffentlichevergabe.de/api/notices/abc?format=ocds", tender: { documents: [{ title: "Unterlagen", url: "https://docs.vergabe.example.de/project/abc" }] } } },
    enrichment_id: "enrichment",
    enrichment_documents: [],
  }, [portal]);
  assert.equal(evidence.originalNotice, null);
  assert.equal(evidence.technicalSource.url, "https://oeffentlichevergabe.de/api/notices/abc?format=ocds");
  assert.equal(evidence.technicalSource.label, "OCDS-Quelldatensatz anzeigen");
  assert.equal(evidence.procurementPortal.url, "https://docs.vergabe.example.de/project/abc");
  assert.equal(evidence.login.url, "https://vergabe.example.de/login");
  assert.equal(evidence.registration.url, "https://vergabe.example.de/register");
  assert.equal(evidence.portalMapping.status, "EINDEUTIG_ZUGEORDNET");
  assert.equal(evidence.electronicSubmission, null);
  assert.equal(evidence.documentEvidence.code, "LINKS_NOT_EXTRACTED");
});

test("persisted role resolution outranks TED publication links and binds the external portal", () => {
  const evidence = buildTenderLinkEvidence({
    source_code: "TED",
    source_url: "https://ted.europa.eu/en/notice/1",
    external_id: "1",
    normalized_data: { raw: { links: { html: { ENG: "https://ted.europa.eu/en/notice/1" } } } },
    authoritative_portal_resolutions: [{
      evidence_role: "SUBMISSION",
      resolution_status: "UNIQUE_EVIDENCE",
      portal_id: portal.id,
      exact_host: portal.canonical_domain,
      evidence_url: "https://vergabe.example.de/project/1",
    }],
  }, [portal]);
  assert.equal(evidence.procurementPortal.portalId, portal.id);
  assert.equal(evidence.procurementPortal.canonicalHost, "vergabe.example.de");
  assert.equal(evidence.portalMapping.evidenceRole, "SUBMISSION");
  assert.notEqual(evidence.procurementPortal.canonicalHost, "ted.europa.eu");
});

test("an unregistered or merely related host is not promoted to procurement portal", () => {
  const evidence = buildTenderLinkEvidence({
    source_code: "DOE",
    source_url: "https://oeffentlichevergabe.de/api/notices/abc",
    normalized_data: { raw: { tender: { documents: [{ url: "https://unlisted.example.org/file.pdf" }] } } },
  }, [portal]);
  assert.equal(evidence.procurementPortal, null);
  assert.equal(evidence.login, null);
  assert.equal(evidence.documents[0].url, "https://unlisted.example.org/file.pdf");
});

test("a RIB tenderId URL is promoted to the procurement portal and internal provenance names are absent", () => {
  const rib = { ...portal, display_name: "MeinAuftrag / RIB", canonical_domain: "www.meinauftrag.rib.de", allowed_subdomains: [] };
  const evidence = buildTenderLinkEvidence({
    source_code: "DOE",
    source_url: "https://oeffentlichevergabe.de/api/notices/abc?format=ocds",
    normalized_data: { raw: { tender: { documents: [{ url: "https://www.meinauftrag.rib.de/public/DetailsByPlatformIdAndTenderId/platformId/7/tenderId/121016017" }] } } },
  }, [rib]);
  assert.match(evidence.procurementPortal.url, /tenderId\/121016017/);
  assert.equal(evidence.procurementPortal.portalName, "MeinAuftrag / RIB");
  assert.doesNotMatch(JSON.stringify(evidence), /DOE_QUELLPAYLOAD|ENRICHMENT_DOCUMENT/);
});

test("document truth distinguishes success, login requirement, failure and no source links", () => {
  const base = { source_code: "DOE", source_url: "https://oeffentlichevergabe.de/api/notices/abc", enrichment_id: "e" };
  assert.equal(buildTenderLinkEvidence({ ...base, enrichment_documents: [{ source_url: "https://files.example.org/a.pdf", resolution_status: "DOWNLOAD_SUCCEEDED" }] }).documentEvidence.code, "DOCUMENTS_FOUND");
  assert.equal(buildTenderLinkEvidence({ ...base, enrichment_documents: [{ source_url: "https://files.example.org/a.pdf", resolution_status: "PORTAL_ACCESS_REQUIRED" }] }).documentEvidence.code, "LOGIN_REQUIRED");
  assert.equal(buildTenderLinkEvidence({ ...base, enrichment_documents: [{ source_url: "https://files.example.org/a.pdf", resolution_status: "DOWNLOAD_FAILED" }] }).documentEvidence.code, "FETCH_FAILED");
  assert.equal(buildTenderLinkEvidence(base).documentEvidence.code, "SOURCE_HAS_NO_DOCUMENT_LINKS");
});
