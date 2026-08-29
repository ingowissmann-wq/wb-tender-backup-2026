import test from "node:test";
import assert from "node:assert/strict";
import {calculateScenario} from "../platform/calculation.mjs";

const input={
  productiveHours:1000,
  baseHourlyRate:20,
  employerBurdenRate:0.25,
  overheadRate:0.08,
  riskRate:0.03,
  targetMarginRate:0.1,
  contractMonths:12,
};

test("manual calculation is an explicit non-persistent canonical sandbox",()=>{
  const result=calculateScenario(input,{C23:1600,C23Unit:"HOURS_PER_YEAR"});
  assert.equal(result.status,"CALCULATED");
  assert.equal(result.schemaVersion,5);
  assert.equal(result.canonical.schemaVersion,5);
  assert.equal(result.sandbox,true);
  assert.equal(result.persisted,false);
  assert.equal(result.externalTransmission,false);
});

test("manual sandbox blocks without canonical C23 configuration",()=>{
  const result=calculateScenario(input,{});
  assert.equal(result.status,"BLOCKED");
  assert.ok(result.missing.includes("C23"));
  assert.ok(result.missing.includes("C23Unit"));
});
