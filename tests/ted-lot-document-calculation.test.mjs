import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {parseNotice} from "../platform/enrichment-core.mjs";
import {resolveLotChoice} from "../platform/ted-notice-context.mjs";
import {buildTenderLinkEvidence} from "../platform/tender-link-evidence.mjs";
import {resolvePortalEvidence} from "../platform/portal-evidence.mjs";

const routes=readFileSync(new URL("../platform/autopilot-routes.mjs",import.meta.url),"utf8");
const worker=readFileSync(new URL("../platform/autopilot-pipeline-worker.mjs",import.meta.url),"utf8");
const ui=readFileSync(new URL("../platform/assets/inbox-regions.js",import.meta.url),"utf8");
const migration=readFileSync(new URL("../migrations/106_ted_lot_document_context.sql",import.meta.url),"utf8");

const exactLot={lot_key:"LOT-0000",lot_id:"11111111-1111-4111-8111-111111111111",lifecycle_status:"ACTIVE",participation_status:"ELIGIBLE",deadline_quality:"EXACT",offer_deadline:"2026-09-07T10:00:00.000Z",deadline_evidence_id:"22222222-2222-4222-8222-222222222222"};

test("one exact future eligible lot is bound automatically and a choice is required for several",()=>{
  assert.equal(resolveLotChoice({eligibleLots:[exactLot]}).source,"SINGLE_ELIGIBLE_LOT");
  assert.equal(resolveLotChoice({eligibleLots:[exactLot]}).lot.lot_key,"LOT-0000");
  const second={...exactLot,lot_key:"LOT-0001",lot_id:"33333333-3333-4333-8333-333333333333"};
  assert.deepEqual(resolveLotChoice({eligibleLots:[exactLot,second]}),{lot:null,source:"MULTIPLE_ELIGIBLE_LOTS",selectionRequired:true});
  assert.equal(resolveLotChoice({requestedLotKey:"LOT-0001",eligibleLots:[exactLot,second]}).lot.lot_key,"LOT-0001");
});

test("TED eForms parsing retains procedure, source lot, exact zoned deadline and semantic document evidence",()=>{
  const xml=`<Notice><cbc:NoticePublicationID xmlns:cbc="urn:cbc">547290-2026</cbc:NoticePublicationID><efac:Procedure xmlns:efac="urn:efac"><cbc:ID xmlns:cbc="urn:cbc">2026-083-Kun-O-EU</cbc:ID></efac:Procedure><cac:ProcurementProjectLot xmlns:cac="urn:cac"><cbc:ID xmlns:cbc="urn:cbc">LOT-0000</cbc:ID><cac:ProcurementProject><cbc:Name xmlns:cbc="urn:cbc">Wachdienstleistungen</cbc:Name><cbc:Description xmlns:cbc="urn:cbc">Bewachungsdienste</cbc:Description><cbc:ItemClassificationCode xmlns:cbc="urn:cbc">79713000</cbc:ItemClassificationCode></cac:ProcurementProject><cac:TenderingTerms><cac:TenderSubmissionDeadlinePeriod><cbc:EndDate xmlns:cbc="urn:cbc">2026-09-07+02:00</cbc:EndDate><cbc:EndTime xmlns:cbc="urn:cbc">12:00:00+02:00</cbc:EndTime></cac:TenderSubmissionDeadlinePeriod><cac:CallForTendersDocumentReference><cac:Attachment><cac:ExternalReference><cbc:URI xmlns:cbc="urn:cbc">https://lhs-vpbw.vmstart.de/NetServer/TenderingProcedureDetails?function=_Details&amp;TenderOID=54321-Tender-test</cbc:URI></cac:ExternalReference></cac:Attachment></cac:CallForTendersDocumentReference></cac:TenderingTerms></cac:ProcurementProjectLot></Notice>`;
  const parsed=parseNotice(Buffer.from(xml),{source:"TED",url:"https://ted.europa.eu/de/notice/547290-2026/xml",fallback:{external_id:"547290-2026"}});
  assert.equal(parsed.structured.procedureId,"2026-083-Kun-O-EU");
  assert.equal(parsed.lots[0].lotKey,"LOT-0000");
  assert.equal(parsed.lots[0].deadline,"2026-09-07T10:00:00.000Z");
  assert.equal(parsed.linkEvidence.find(link=>link.url.includes("lhs-vpbw"))?.role,"PROCUREMENT_DOCUMENT");
});

test("TED account, publication, documents and procurement portal remain separate",()=>{
  const evidence=buildTenderLinkEvidence({source_code:"TED",source_url:"https://ted.europa.eu/de/notice/547290-2026/xml",external_id:"547290-2026",external_links:[{role:"PROCUREMENT_DOCUMENT",original_url:"https://lhs-vpbw.vmstart.de/NetServer/TenderingProcedureDetails?function=_Details",public_access:true,verification_status:"HTTP_VERIFIED"}]},[]);
  assert.equal(evidence.account.submissionPortal,false);
  assert.ok(evidence.account.login.url);
  assert.equal(evidence.procurementPortal,null);
  assert.ok(evidence.documents.some(link=>link.url.includes("lhs-vpbw")));
  assert.equal(evidence.electronicSubmission,null);
});

test("official TED and OCDS fields resolve only a unique registered procurement host",()=>{
  const portals=[{id:"11111111-1111-4111-8111-111111111111",canonical_domain:"www.dtvp.de",allowed_subdomains:["satellite.dtvp.de"],authentication_domains:[],download_domains:[]}];
  const ted=resolvePortalEvidence({sourceCode:"TED",sourceUrl:"https://ted.europa.eu/de/notice/1-2026/xml",normalizedData:{"submission-url-lot":["https://www.dtvp.de/tender/1"],links:{xml:{MUL:"https://ted.europa.eu/en/notice/1-2026/xml"}}},portals});
  assert.equal(ted.status,"UNIQUE_EVIDENCE");
  assert.equal(ted.portal.id,portals[0].id);
  const unknown=resolvePortalEvidence({sourceCode:"DOE",sourceUrl:"https://oeffentlichevergabe.de/api/notices/1?format=ocds",normalizedData:{uri:"https://oeffentlichevergabe.de/api/notices/1?format=ocds",description:"https://www.dtvp.de/not-authoritative"},portals});
  assert.equal(unknown.status,"NOT_FOUND");
});

test("route, worker and UI contract support lazy bound enrichment without weakening submission",()=>{
  assert.match(routes,/tender_lot_selections/);
  assert.match(routes,/region-detail\/:tenderId\/lot-selection/);
  assert.match(routes,/requirePermission\("tender\.inbox\.view"\),csrf/);
  assert.match(routes,/enrichment_context_bindings/);
  assert.match(routes,/resolveDocumentScope/);
  assert.match(routes,/publicDocumentActions\.has\(action\)[\s\S]{0,120}resolveDocumentScope/);
  assert.match(worker,/PUBLIC_DOCUMENT_AVAILABLE/);
  assert.match(worker,/enrichment_context_bindings/);
  assert.match(worker,/persistedPublicEvidence=.*tender_external_links/);
  assert.match(worker,/authHeaders=persistedPublicEvidence\|\|publicRib/);
  assert.match(ui,/Unterlagen abrufen und analysieren/);
  assert.match(ui,/field !== "enrichment_version_id"/);
  assert.match(routes,/reply\.code\(423\)/);
  assert.match(routes,/external_submission_disabled/);
});

test("migration is additive, bounded and contains no cascade deletion",()=>{
  assert.match(migration,/WHERE t\.source_code='TED' AND t\.external_id='547290-2026'/);
  assert.match(migration,/ON CONFLICT \(tender_id,external_id\)/);
  assert.doesNotMatch(migration,/\bDROP\b|\bDELETE\b|\bCASCADE\b/i);
});
