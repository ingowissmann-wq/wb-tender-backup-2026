import test from "node:test";
import assert from "node:assert/strict";
import {calculateSectorTender} from "../platform/sector-calculation.mjs";

test("authoritative productive hours do not require a redundant workday input",()=>{
  const result=calculateSectorTender({
    serviceArea:"cleaning",
    parameters:{C01:14.25,C03:0,C04:20,C05:173.33,C06:10,C07:5,C08:8,C09:0,C10:0,C11:0,C12:0,C13:0,C14:0,C15:0,C16:0,C17:0,C18:3,C19:10,C20:8,C21:5},
    facts:{productiveHours:862.017311,duration:48,areas:369.27},
  });
  assert.equal(result.status,"CALCULATED");
  assert.equal(result.productiveHours,862.02);
  assert.deepEqual({
    directWages:result.directWages, employerOnCosts:result.employerOnCosts,
    holidayReserve:result.holidayReserve, sicknessReserve:result.sicknessReserve,
    overhead:result.overhead, risk:result.risk, db1:result.db1, db2:result.db2,
    db3:result.db3, profit:result.profit, hourlyRate:result.hourlyRate,
    annualPrice:result.annualPrice, totalPrice:result.totalPrice,
  },{
    directWages:12283.75, employerOnCosts:2456.75, holidayReserve:1228.37,
    sicknessReserve:614.19, overhead:1326.64, risk:537.29, db1:4677.39,
    db2:2834.83, db3:970.89, profit:970.89, hourlyRate:22.53,
    annualPrice:4854.47, totalPrice:19417.89,
  });
});

test("missing productive hours remains a hard calculation blocker",()=>{
  const result=calculateSectorTender({serviceArea:"cleaning",parameters:{C01:14.25},facts:{duration:48}});
  assert.equal(result.status,"CALCULATION_BLOCKED_MISSING_INPUT");
  assert.ok(result.missing.includes("Produktivstunden"));
});

test("security non-personnel parameters are company values and use the documented contract term",()=>{
  const result=calculateSectorTender({serviceArea:"security",parameters:{C01:20,S01:1000,S02:10,S03:5,S04:500},facts:{productiveHours:14175,workdays:364,duration:"01.01.2027 bis 31.12.2029"}});
  assert.equal(result.status,"CALCULATED");
  assert.equal(result.securityCostParameters.contractWeeks,156);
  assert.equal(result.securityNonPersonnelCosts,3840);
  assert.deepEqual({directWages:result.directWages,db1:result.db1,db2:result.db2,totalPrice:result.totalPrice,hourlyRate:result.hourlyRate},
    {directWages:283500,db1:3840,db2:3840,totalPrice:287340,hourlyRate:20.27});
});
