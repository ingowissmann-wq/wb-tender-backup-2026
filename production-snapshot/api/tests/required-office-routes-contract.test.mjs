import test from "node:test";
import assert from "node:assert/strict";
import {existsSync,readFileSync} from "node:fs";

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),"utf8");

test("runtime and release overlay expose the same fail-closed Office working-copy contract",()=>{
  const paths=["platform/autopilot-routes.mjs","deployment/context-portal-readiness-128-overlay/platform/autopilot-routes.mjs"].filter(path=>existsSync(new URL(`../${path}`,import.meta.url)));
  assert.ok(paths.length>=1);for(const path of paths){const routes=read(path);
    assert.match(routes,/requiredOfficeSourceContext/);assert.match(routes,/original_malware_scan_status!=="CLEAN"/);assert.match(routes,/required_source_integrity_mismatch/);assert.match(routes,/office_form_structured_fields_missing/);
    assert.match(routes,/working-copy\/office\/fields/);assert.match(routes,/working_copy_version_conflict/);assert.match(routes,/REQUIRED_OFFICE_WORKING_COPY/);assert.match(routes,/MANUAL_REVIEW_REQUIRED/);assert.match(routes,/rereadVerified:true/);assert.match(routes,/automaticVisualCompletenessProven:false/);assert.match(routes,/externalWrite:false,transmitted:false/);
  }
});

test("migration adds a distinct Office source type and refuses lossy rollback",()=>{
  const up=read("migrations/141_required_office_form_working_copies.sql"),down=read("migrations/141_required_office_form_working_copies.down.sql");
  assert.match(up,/REQUIRED_OFFICE_WORKING_COPY/);assert.match(up,/pg_advisory_xact_lock/);assert.match(up,/0141-required-office-form-working-copies/);assert.match(down,/IF EXISTS\(SELECT 1 FROM tender\.required_document_uploads WHERE source_type='REQUIRED_OFFICE_WORKING_COPY'\)/);assert.match(down,/RAISE EXCEPTION/);assert.match(down,/DELETE FROM app\.schema_migrations WHERE version='0141-required-office-form-working-copies'/);
});

test("browser contract provides versioned server autosave and mandatory visual review",()=>{const ui=read("platform/assets/autopilot-navigation.js");
  assert.match(ui,/data-office-edit/);assert.match(ui,/setTimeout\(\(\)=>save\(\{automatic:true\}\),1200\)/);assert.match(ui,/native visuelle Endkontrolle.*verpflichtend/);assert.match(ui,/Arbeitskopie zur visuellen Kontrolle herunterladen/);assert.match(ui,/REQUIRED_OFFICE_WORKING_COPY/);
});
