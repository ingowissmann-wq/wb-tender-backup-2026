import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
const up=readFileSync(new URL("../migrations/148_wb_protect_authoritative_scope_profile_activation.sql",import.meta.url),"utf8");
const down=readFileSync(new URL("../migrations/148_wb_protect_authoritative_scope_profile_activation.down.sql",import.meta.url),"utf8");
test("WB-Protect v3 activation is exact, authority/hash bound, scope-only and submission inert",()=>{
  for(const value of ["b8bc1f97-60cb-4c5d-b42a-d31d44839c5a","WB-Protect & Service GmbH","1adb176774ea65163fed02d1bf7917a020b8179c2a3cde0b030db9f2996cfa9f","dfbe01ff7d47b290a43410c017cccaf508f15a84036dce76c76850b70873cd60","security","Ingo Wissmann"])assert.match(up,new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  assert.match(up,/SELECT id INTO STRICT profile[\s\S]*company_id=company AND version=3 AND profile_sha256=expected_hash/);
  assert.match(up,/approvalKind','AUTHORITATIVE_TENDER_SCOPE_ONLY'/);
  assert.match(up,/profileComplete',false/);
  assert.match(up,/calculationRemainsBlocked',true/);
  assert.match(up,/externalSubmissionAuthorized',false/);
  assert.doesNotMatch(up,/UPDATE tender\.company_profiles[\s\S]*WHERE company_id<>/);
});
test("rollback retains approval and audit history",()=>{
  assert.match(down,/decision='REVOKED'/);
  assert.match(down,/historyRetained',true/);
  assert.doesNotMatch(down,/DELETE FROM tender\./);
});
