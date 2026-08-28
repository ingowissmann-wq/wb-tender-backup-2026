import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const worker=fs.readFileSync(new URL("../platform/autopilot-pipeline-worker.mjs",import.meta.url),"utf8");
const overlayUrl=new URL("../deployment/context-portal-readiness-128-overlay/platform/autopilot-pipeline-worker.mjs",import.meta.url);
const overlay=fs.existsSync(overlayUrl)?fs.readFileSync(overlayUrl,"utf8"):worker;
const recovery=fs.readFileSync(new URL("../scripts/recover-stored-parser-failures.mjs",import.meta.url),"utf8");

test("stored parser recovery is restricted to hash-valid, malware-clean procurement documents",()=>{
  for(const source of [worker,overlay]){
    assert.match(source,/safeRelevantOnly/);
    assert.match(source,/tender_association_verified AND magic_bytes_verified/);
    assert.match(source,/scan\.status='CLEAN'/);
    assert.match(source,/actualHash !== row\.payload_sha256/);
    assert.match(source,/lower\.endsWith\("\.docx"\)[\s\S]{0,180}"application\/msword"/);
    assert.match(source,/lower\.endsWith\("\.xlsx"\)[\s\S]{0,180}"application\/vnd\.ms-excel"/);
  }
  assert.match(recovery,/safeRelevantOnly:true/);
  assert.match(recovery,/externalSubmission:false,transmitted:false/);
});
