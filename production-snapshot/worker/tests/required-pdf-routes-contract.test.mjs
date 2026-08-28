import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const routes=readFileSync(new URL("../platform/autopilot-routes.mjs",import.meta.url),"utf8");
const ui=readFileSync(new URL("../platform/assets/autopilot-navigation.js",import.meta.url),"utf8");
const server=readFileSync(new URL("../platform/server.mjs",import.meta.url),"utf8");
const migration=`${readFileSync(new URL("../migrations/066_required_original_forms.sql",import.meta.url),"utf8")}\n${readFileSync(new URL("../migrations/075_required_pdf_overlays.sql",import.meta.url),"utf8")}\n${readFileSync(new URL("../migrations/076_required_document_preflight_status_truth.sql",import.meta.url),"utf8")}`;

test("field save route preserves permission, CSRF, company, lot and required-document scope",()=>{
  assert.match(routes,/working-copy\/fields",\{preHandler:\[requirePermission\("tender\.document\.analyze"\),csrf\]/);
  assert.match(routes,/required_document_id=\$1 AND tender_id=\$2 AND company_id=\$3 AND lot_key=\$4 AND is_current FOR UPDATE/);
  assert.match(routes,/working_copy_version_conflict/);
  assert.match(routes,/requireRegisteredScope\(reply,req\.params\.id,companyId\)/);
  assert.match(routes,/company_scope_forbidden/);
});

test("universal overlay route is size-limited, permissioned, CSRF protected and source scoped",()=>{
  assert.match(routes,/working-copy\/overlays",\{bodyLimit:1_000_000,preHandler:\[requirePermission\("tender\.document\.analyze"\),csrf\]/);
  assert.match(routes,/requiredPdfSourceContext/);
  assert.match(routes,/required_source_integrity_mismatch/);
  assert.match(routes,/current\.source_document_id!==context\.candidate\.id\|\|current\.source_sha256!==context\.sha256/);
  assert.match(routes,/REQUIRED_PDF_WORKING_COPY_OVERLAYS_SAVED/);
});

test("save creates a new immutable-history version and audits provenance without field values",()=>{
  assert.match(routes,/coalesce\(max\(version\),0\)\+1 version FROM tender\.required_document_working_copies/);
  assert.match(routes,/REQUIRED_PDF_WORKING_COPY_FIELDS_SAVED/);
  assert.match(routes,/changedFieldNames:filled\.changedFields/);
  assert.doesNotMatch(routes,/changedFieldValues/);
  assert.match(routes,/originalUnchanged:true,signatureAdded:false,externalWrite:false,transmitted:false/);
  assert.match(migration,/original_unchanged boolean NOT NULL DEFAULT true CHECK\(original_unchanged=true\)/);
  assert.match(migration,/legal_confirmation_added boolean NOT NULL DEFAULT false CHECK\(legal_confirmation_added=false\)/);
  assert.match(migration,/UNIQUE\(required_document_id,version\)/);
  assert.match(migration,/overlay_data jsonb NOT NULL/);
  assert.match(migration,/jsonb_array_length\(overlay_data\)<=500/);
});

test("required-documents browser journey exposes editor only for fillable forms and retains AcroForm",()=>{
  const prepare=ui.indexOf("Versionierte PDF-Arbeitskopie wird vorbereitet"),open=ui.indexOf("openRequiredPdfEditor(s,id,sourcePage)"),fields=ui.indexOf("Vorhandene AcroForm-Felder"),save=ui.indexOf("Als neue Working-Copy-Version speichern");
  assert.ok(prepare>=0&&open>=0&&fields>=0&&save>=0);
  for(const token of ["PDF am Bildschirm ausfüllen","data-pdf-edit","data-pdf-field","data-overlay-add","data-page-number","baseVersion:Number(item.version)","${base}/overlays","Visuell ausgefüllte PDF herunterladen","Original unverändert"] )assert.ok(ui.includes(token),token);
  assert.match(ui,/Signaturfeld – wird nicht automatisch ausgefüllt/);
  assert.match(ui,/keine AcroForm-Felder/);
  assert.doesNotMatch(ui,/Original herunterladen, extern ausfüllen/);
  assert.match(ui,/x\.action_type==="PDF_EDITOR"/);
  assert.match(ui,/x\.action_type==="UPLOAD"/);
  assert.match(routes,/required_document_not_fillable/);
  for(const token of ["data-overlay-width","data-overlay-height","data-overlay-font-size","data-overlay-resize","event.altKey"]) assert.ok(ui.includes(token),token);
});

test("material save uses review-ready lifecycle and synchronizes every readiness reader",()=>{
  for(const token of ["materiallyEditedPdfWorkingCopy","MANUAL_REVIEW_REQUIRED","source_working_copy_id","REQUIRED_PDF_WORKING_COPY","runRequiredDocumentRecheck(client,requirement,upload"])
    assert.ok(`${routes}\n${migration}`.includes(token),token);
  assert.match(routes,/SET status=r\.satisfaction_status/);
  assert.match(routes,/persisted_satisfaction_status/);
});

test("overlay audit statement contains structural metadata but no element text",()=>{
  const statement=routes.match(/INSERT INTO tender\.audit_events\(actor_id,action,tender_id,metadata\) VALUES\(\$1,'REQUIRED_PDF_WORKING_COPY_OVERLAYS_SAVED'[\s\S]*?await client\.query\("COMMIT"\)/)?.[0]||"";
  assert.match(routes,/summary=summarizePdfOverlays\(rendered\.elements\)/);
  assert.match(statement,/\.\.\.summary/);
  assert.doesNotMatch(statement,/text:/);
});

test("source/original download, upload/review, signature and preflight workflows remain present",()=>{
  for(const token of [
    "/source/download","/original?","data-required-upload","data-required-review","/signature-workbench/prepare","/signature-workbench/:id/upload","/submission-preflight",
  ]) assert.ok(`${routes}\n${ui}`.includes(token),token);
  assert.match(routes,/external_submission_disabled/);
  assert.match(routes,/reply\.code\(423\)/);
});

test("production-equivalent candidate mode is database read-only and suppresses reconcilers",()=>{
  assert.match(server,/WB_TENDER_READ_ONLY_CANDIDATE/);
  assert.match(server,/default_transaction_read_only=on/);
  assert.match(routes,/readOnlyCandidate\?null:setInterval/);
  assert.match(routes,/if\(!readOnlyCandidate\)setTimeout/);
  assert.match(routes,/if\(!readOnlyCandidate\) await pool\.query\(`WITH matches AS/);
});

test("classifier repair locks only required-document rows across its optional source join",()=>{
  assert.match(routes,/LEFT JOIN tender\.enrichment_documents d ON d\.id=r\.source_document_id[\s\S]{0,500}FOR UPDATE OF r/);
});
