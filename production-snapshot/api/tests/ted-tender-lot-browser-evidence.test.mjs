import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const up=readFileSync(new URL("../migrations/142_ted_tender_lot_browser_evidence.sql",import.meta.url),"utf8");
const down=readFileSync(new URL("../migrations/142_ted_tender_lot_browser_evidence.down.sql",import.meta.url),"utf8");

test("migration records only the two verified TED read capabilities",()=>{
  assert.match(up,/feature\.feature_key IN\('DISCOVERY','NOTICES'\)/);
  assert.match(up,/production_tested=true,browser_acceptance_passed=true/);
  assert.match(up,/requestMethods',jsonb_build_array\('GET'\)/);
  assert.match(up,/externalWrite',false,'transmitted',false/);
  assert.match(up,/005b4e696c7705d1df4b41825573b28dcaee8374504a78c3282df650d5914d7c/);
  assert.doesNotMatch(up,/SUBMISSION|UPLOAD|LOGIN/);
});

test("down migration restores the exact prior capability evidence",()=>{
  assert.match(down,/production_tested=false,browser_acceptance_passed=false/);
  assert.match(down,/https:\/\/ted\.europa\.eu\/en\/about-ted/);
  assert.match(down,/DELETE FROM app\.schema_migrations WHERE version='0142-ted-tender-lot-browser-evidence'/);
});
