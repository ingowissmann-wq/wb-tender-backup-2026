import test from "node:test";
import assert from "node:assert/strict";
import {calculateSectorTender} from "../platform/sector-calculation.mjs";

test("authoritative productive hours do not require a redundant workday input",()=>{
  const result=calculateSectorTender({
    serviceArea:"cleaning",
    parameters:{C01:14.25,C03:0,C04:20,C05:13.5,C06:10,C07:5,C08:8,C09:0,C10:0,C11:0,C12:0,C13:0,C14:0,C15:0,C16:0,C17:0,C18:3,C19:10,C20:8,C21:5,C23:1600},
    units:{C23:"HOURS_PER_YEAR"},
    facts:{productiveHours:862.017311,duration:48,areas:369.27},
  });
  assert.equal(result.status,"CALCULATED");
  assert.equal(result.productiveHours,862.02);
  assert.ok(result.totalPrice>0);
});

test("missing productive hours remains a hard calculation blocker",()=>{
  const result=calculateSectorTender({serviceArea:"cleaning",parameters:{C01:14.25},facts:{duration:48}});
  assert.equal(result.status,"CALCULATION_BLOCKED_MISSING_INPUT");
  assert.ok(result.missing.includes("Produktivstunden"));
});

test("security non-personnel parameters are company values and use the documented contract term",()=>{
  const result=calculateSectorTender({serviceArea:"security",parameters:{C01:20,C23:1600,S01:1000,S02:10,S03:5,S04:500},units:{C23:"HOURS_PER_YEAR"},facts:{productiveHours:14175,workdays:364,duration:"01.01.2027 bis 31.12.2029"}});
  assert.equal(result.status,"CALCULATED");
  assert.equal(result.securityCostParameters.contractWeeks,156);
  assert.equal(result.securityNonPersonnelCosts,3840);
});

test("C23 is mandatory and facts cannot bypass the company parameter",()=>{
  const result=calculateSectorTender({
    serviceArea:"cleaning",
    parameters:{C01:14.25},
    units:{C23:"HOURS_PER_YEAR"},
    facts:{productiveHours:1000,workdays:250,duration:12,fteAnnualHours:1600},
  });
  assert.equal(result.status,"CALCULATION_BLOCKED_MISSING_INPUT");
  assert.ok(result.missing.includes("C23 Produktive Jahresstunden je Vollzeitkraft"));
});

test("C23 requires the canonical annual-hours unit",()=>{
  const result=calculateSectorTender({
    serviceArea:"cleaning",
    parameters:{C01:14.25,C23:1600},
    units:{C23:"HOURS_PER_MONTH"},
    facts:{productiveHours:1000,workdays:250,duration:12},
  });
  assert.equal(result.status,"CALCULATION_BLOCKED_MISSING_INPUT");
  assert.ok(result.missing.includes("C23 Einheit HOURS_PER_YEAR"));
});

test("legacy C05 divisor semantics are rejected",()=>{
  const result=calculateSectorTender({
    serviceArea:"cleaning",
    parameters:{C01:14.25,C05:173.33,C23:1600},
    units:{C23:"HOURS_PER_YEAR"},
    facts:{productiveHours:1000,workdays:250,duration:12},
  });
  assert.equal(result.status,"CALCULATION_BLOCKED_MISSING_INPUT");
  assert.ok(result.missing.includes("C05 Prozentwert außerhalb 0–100"));
});
