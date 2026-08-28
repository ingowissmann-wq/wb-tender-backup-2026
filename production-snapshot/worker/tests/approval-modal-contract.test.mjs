import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {BID_APPROVAL_CONFIRMATION_PHRASE} from "../platform/bid-workflow.mjs";

const ui=readFileSync(new URL("../platform/assets/autopilot-navigation.js",import.meta.url),"utf8");
const css=readFileSync(new URL("../platform/assets/autopilot-navigation.css",import.meta.url),"utf8");

test("enterprise approval modal uses the server-provided phrase and exact version contract",()=>{
  assert.match(ui,/openEnterpriseApprovalDialog/);
  assert.match(ui,/approvalSummary\?\.confirmationPhrase/);
  assert.ok(!ui.includes(`data-confirmation-phrase>${BID_APPROVAL_CONFIRMATION_PHRASE}`));
  for(const field of ["approvalRequestId","tenderId","companyId","documentVersion","calculationVersion","managementVersion","offerVersion"])assert.match(ui,new RegExp(`${field}:`));
});

test("approval modal is accessible and responsive",()=>{
  for(const token of ['aria-modal="true"','aria-labelledby="approval-dialog-title"','placeholder="Bestätigungssatz hier eingeben"','event.key!=="Tab"'])assert.ok(ui.includes(token));
  assert.match(css,/\.approval-enterprise/);
  assert.match(css,/@media\(max-width:700px\)/);
});
