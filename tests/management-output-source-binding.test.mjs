import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";

import {buildCalculationViewModel} from "../platform/calculation-view-model.mjs";

const routes=await readFile(new URL("../platform/autopilot-routes.mjs",import.meta.url),"utf8");

test("management API binds output, approval, snapshot and documents to the latest exact calculation",()=>{
  const start=routes.indexOf('app.get(\n    "/api/autopilot/calculation/:id"');
  const end=routes.indexOf('app.post(\n    "/api/tenders/:id/calculation-inputs"',start);
  assert.ok(start>=0&&end>start);
  const source=routes.slice(start,end);
  assert.match(source,/JOIN latest_calculation c ON c\.id=m\.calculation_id/);
  assert.match(source,/JOIN latest_calculation c ON c\.id=a\.calculation_id/);
  assert.match(source,/snapshot\.id=calculation\.calculation_input_snapshot_id/);
  assert.match(source,/snapshot\.tenant_id=calculation\.tenant_id/);
  assert.match(source,/snapshot\.tender_id=calculation\.tender_id/);
  assert.match(source,/snapshot\.company_id=calculation\.company_id/);
  assert.match(source,/snapshot\.lot_key=coalesce\(calculation\.lot_key,''\)/);
  assert.match(source,/jsonb_array_elements\(snapshot\.document_fingerprints\)/);
  assert.match(source,/lower\(d\.payload_sha256\)=exact\.sha256/);
  assert.doesNotMatch(source,/canonical_read_snapshots/);
  assert.doesNotMatch(source,/d\.procurement_relevant=true/);
});

const base={
  tender:{title:"Tender",buyer:"Buyer",source_code:"TED",external_id:"x"},
  company:{company_id:"company-1",legal_name:"WB Cleaning"},lot:null,
  calculation:{id:"calculation-1",calculation_input_snapshot_id:"snapshot-1",company_id:"company-1",lot_key:"LOT-0001",status:"CALCULATION_PARTIAL",version:1,scenario:"REAL",totals:{missingPositions:["C13","C14"]}},
  managementOutput:{id:"output-1",calculation_id:"calculation-1",output_sha256:"e".repeat(64),status:"MANAGEMENT_OUTPUT_GENERATED",payload:{recommendation:{decision:"MANAGEMENT_REVIEW_REQUIRED_PARTIAL"}}},
  approval:null,
};

test("browser sources are reconstructed only from the immutable calculation snapshot",()=>{
  const calculationInputSnapshot={id:"snapshot-1",snapshot_sha256:"a".repeat(64),contract_version:"wb-tender-calculation-contract/1.0.0",contract_state:"READY",fact_records:[
    {key:"annualCleaningArea",value:2589414.889362,unit:"SQUARE_METRES",classification:"DOCUMENT_VERIFIED",source:{type:"VERIFIED_PROCUREMENT_DOCUMENT",documentId:"document-1",documentSha256:"b".repeat(64),location:{worksheet:"P4, Aufmaß",row:8,cell:"M8"}}},
    {key:"groupedCleaningPerformance",value:{groups:[]},unit:"M2_PER_HOUR_BY_GROUP",classification:"CASE_APPROVED",source:{type:"EXPLICIT_MANAGEMENT_INPUT",inputId:"decision-1",approvedBy:"actor-1",approvedAt:"2026-08-29"}},
  ],parameter_records:[{key:"C23",value:1670,unit:"HOURS_PER_YEAR",classification:"COMPANY_APPROVED",versionId:"version-1",approvedBy:"actor-1",approvedAt:"2026-08-29"}]};
  const view=buildCalculationViewModel({...base,calculationInputSnapshot,snapshotId:"snapshot-1",documents:[
    {id:"document-1",filename:"Preisblatt.xlsx",payload_sha256:"b".repeat(64),source_url:"https://example.invalid/price-sheet"},
    {id:"unbound",filename:"Nicht verwendet.pdf",payload_sha256:"c".repeat(64),source_url:"https://example.invalid/unbound"},
  ]});
  assert.equal(view.evidenceSummary.inputSnapshotBound,true);
  assert.equal(view.evidenceSummary.managementOutputBound,true);
  assert.equal(view.evidenceSummary.sourceCount,3);
  assert.deepEqual(view.sources.map(source=>source.type),["Dokument","Fallentscheidung","Gesellschaftsparameter"]);
  assert.equal(view.sources[0].documentId,"document-1");
  assert.equal(view.sources[0].worksheet,"P4, Aufmaß");
  assert.equal(view.sources.some(source=>source.name==="Nicht verwendet.pdf"),false);
  assert.equal(view.technicalDetails.calculationInputSnapshotSha256,"a".repeat(64));
  assert.equal(view.technicalDetails.managementOutputSha256,"e".repeat(64));
});

test("historical rows without an exact snapshot/output binding expose no invented sources",()=>{
  const view=buildCalculationViewModel({...base,managementOutput:{...base.managementOutput,calculation_id:"older-calculation"},calculationInputSnapshot:null,documents:[{id:"document-1",filename:"Unbound.pdf"}]});
  assert.equal(view.evidenceSummary.calculationBasisComplete,false);
  assert.equal(view.evidenceSummary.inputSnapshotBound,false);
  assert.equal(view.evidenceSummary.managementOutputBound,false);
  assert.deepEqual(view.sources,[]);
});
