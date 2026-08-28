import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildJobContinuation as rootContinuation } from "../platform/autopilot-routes.mjs";

const scope={
  tender_id:"11111111-1111-4111-8111-111111111111",
  company_id:"22222222-2222-4222-8222-222222222222",
  portal_id:"33333333-3333-4333-8333-333333333333",
  lot_key:"LOT-0007",
  enrichment_version_id:"44444444-4444-4444-8444-444444444444",
};
const expectations=new Map([
  ["ACCOUNT_SETUP_REQUIRED","MANAGE_PORTAL_ACCESS"],
  ["MANUAL_MFA_REQUIRED","CONTINUE_PORTAL_AUTHENTICATION"],
  ["MANUAL_CAPTCHA_REQUIRED","CONTINUE_PORTAL_AUTHENTICATION"],
  ["DATA_CONTEXT_REPAIR_REQUIRED","REVIEW_TENDER_CONTEXT"],
  ["ADAPTER_REPAIR_REQUIRED","REVIEW_PORTAL_ADAPTER"],
  ["UNSUPPORTED_PORTAL_REQUIRES_ADAPTER","REVIEW_PORTAL_ADAPTER"],
  ["EXTERNAL_PORTAL_UNAVAILABLE","REVIEW_PORTAL_AVAILABILITY"],
]);

for(const builder of [rootContinuation]){
  test("route exposes safe executable continuation contracts",()=>{
    for(const [status,actionType] of expectations){
      const result=builder({...scope,terminal_result:status,result_summary:{reasonCode:"SAFE_REASON",repairAction:"SAFE_REPAIR"}});
      assert.equal(result.status,status);
      assert.equal(result.actionType,actionType);
      assert.equal(result.tenderId,scope.tender_id);
      assert.equal(result.companyId,scope.company_id);
      assert.equal(result.portalId,scope.portal_id);
      assert.equal(result.lotKey,scope.lot_key);
      assert.equal(result.externalWrite,false);
      assert.equal(result.automaticExternalAction,false);
      assert.match(result.message,/\S/);
      assert.match(result.actionLabel,/\S/);
    }
  });
}

test("presentation suppresses arbitrary result text and ignores unknown terminal states",()=>{
  const result=rootContinuation({...scope,terminal_result:"ACCOUNT_SETUP_REQUIRED",result_summary:{reasonCode:"password=hunter2",repairAction:"<script>"}});
  assert.equal(result.reasonCode,null);
  assert.equal(result.repairAction,null);
  assert.equal(rootContinuation({...scope,terminal_result:"SOMETHING_UNKNOWN"}),null);
});

test("browser renders a scoped link without starting an external action",()=>{
  const ui=fs.readFileSync(new URL("../platform/assets/autopilot-navigation.js",import.meta.url),"utf8"),
    dockerfileUrl=new URL("../deployment/Dockerfile.context-portal-readiness-128",import.meta.url),
    overlayUrl=new URL("../deployment/context-portal-readiness-128-overlay/platform/autopilot-routes.mjs",import.meta.url);
  for(const token of ["job-continuation-action","dataset.continuationType","CONTINUE_PORTAL_AUTHENTICATION","REVIEW_TENDER_CONTEXT","REVIEW_PORTAL_ADAPTER"])
    assert.match(ui,new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  assert.match(ui,/action\.href = target/);
  assert.doesNotMatch(ui,/job\.continuation[^\n]{0,200}(?:fetch|post)\(/);
  if(fs.existsSync(dockerfileUrl))assert.match(fs.readFileSync(dockerfileUrl,"utf8"),/COPY --chown=root:root platform\/assets\/autopilot-navigation\.js \/app\/platform\/assets\/autopilot-navigation\.js/);
  if(fs.existsSync(overlayUrl)){
    const overlay=fs.readFileSync(overlayUrl,"utf8");
    for(const status of expectations.keys())assert.match(overlay,new RegExp(status));
    assert.match(overlay,/continuation: continuationPresentation\(row\)/);
  }
});
