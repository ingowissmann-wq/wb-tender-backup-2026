import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
const up=fs.readFileSync(new URL("../migrations/144_munich_ai_netserver_public_adapter.sql",import.meta.url),"utf8");
const down=fs.readFileSync(new URL("../migrations/144_munich_ai_netserver_public_adapter.down.sql",import.meta.url),"utf8");
test("Munich migration is exact, public-read-only and capability scoped",()=>{
  for(const value of ["71c824fd-1775-47f8-ae48-2d1c73b5e851","vergabe.muenchen.de","ai-vergabe-manager",
    "BROWSER_NETSERVER_ARCHIVE","VALIDATED_READ_ONLY","DOCUMENT_DOWNLOAD","submissionValidated',false","externalSubmission',false"])
    assert.ok(up.includes(value),value);
  assert.doesNotMatch(up,/DELETE FROM|SUBMISSION'.*SUPPORTED|kill_switch=false/);
});
test("rollback disables execution without deleting retained evidence",()=>{
  assert.match(down,/adapter_enabled=false/);
  assert.match(down,/enabled=false,validation_status='PARTIALLY_VALIDATED'/);
  assert.match(down,/'physicalDeletes',0/);
  assert.doesNotMatch(down,/DELETE FROM/);
});
