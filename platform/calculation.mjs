import {
  CALCULATION_SCHEMA_VERSION,
} from "./sector-calculation.mjs";
import {
  CALCULATION_CONTRACT_STATES,
  createCalculationContractSnapshot,
  executeCalculationContractSnapshot,
} from "./calculation-contract.mjs";

const REQUIRED_INPUTS = Object.freeze([
  "productiveHours", "baseHourlyRate", "employerBurdenRate",
  "overheadRate", "riskRate", "targetMarginRate",
]);
const FLAT_COST_INPUTS = Object.freeze([
  "material", "machines", "vehicles", "travel", "accommodation",
  "insurance", "subcontractors", "recruitment", "training",
  "clearances", "certificates", "financing",
]);
const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
const percentage = (value) => {
  const parsed = number(value);
  return parsed === null ? null : parsed * 100;
};
const blocked = (missing) => ({
  status: "BLOCKED",
  schemaVersion: CALCULATION_SCHEMA_VERSION,
  missing: [...new Set(missing)],
  items: [],
  totals: {},
  sandbox: true,
  persisted: false,
  externalTransmission: false,
});

export function calculateScenario(input = {}, config = {}) {
  const missing = [...REQUIRED_INPUTS, ...(config.requiredInputs || [])]
    .filter((key) => input[key] === undefined || input[key] === null || input[key] === "");
  const fteAnnualHours = number(config.C23);
  if (fteAnnualHours === null || fteAnnualHours === 0) missing.push("C23");
  if (config.C23Unit !== "HOURS_PER_YEAR") missing.push("C23Unit");
  if (missing.length) return blocked(missing);

  const flatCosts = FLAT_COST_INPUTS.reduce(
    (sum, key) => sum + (number(input[key]) || 0), 0,
  );
  const supplementHours = input.supplementHours || {};
  const supplementRates = config.supplementRates || {};
  const supplementPercent = Object.entries(supplementHours).reduce(
    (sum, [code, hours]) =>
      sum + (number(hours) || 0) * (number(supplementRates[code]) || 0),
    0,
  ) / Math.max(number(input.productiveHours) || 1, 1);

  const engineInput = {
    serviceArea: config.serviceArea || input.serviceArea || null,
    parameters: {
      C01: number(input.baseHourlyRate),
      C03: supplementPercent * 100,
      C04: percentage(input.employerBurdenRate),
      C05: 0,
      C06: 0,
      C07: percentage(input.absenceReserveRate || 0),
      C08: percentage(input.overheadRate),
      C11: flatCosts,
      C18: percentage(input.riskRate),
      C21: percentage(input.targetMarginRate),
      C23: fteAnnualHours,
    },
    units: {
      C08: "PERCENT", C11: "EUR", C21: "PERCENT",
      C23: "HOURS_PER_YEAR",
    },
    facts: {
      productiveHours: number(input.productiveHours),
      duration: number(input.contractMonths) || 12,
      workdays: input.workdays ?? "SANDBOX_SCENARIO",
    },
    provenance: {
      source: "NON_PERSISTENT_MANUAL_SANDBOX",
      configVersion: config.version || null,
    },
    contractMonths: number(input.contractMonths) || 12,
  };
  const inputSnapshot = createCalculationContractSnapshot({
    mode: "MANUAL_SANDBOX",
    state: CALCULATION_CONTRACT_STATES.SHADOW,
    engineInput,
  });
  const canonical = executeCalculationContractSnapshot(inputSnapshot);
  if (canonical.status !== "CALCULATED")
    return blocked(canonical.missing || []);

  const strategyPremium = number(input.strategyPremiumRate) || 0;
  const strategic = canonical.totalPrice * (1 + strategyPremium);
  const db1Base = canonical.totalPrice - canonical.db1;
  const db2Base = canonical.totalPrice - canonical.db2;
  const db3Base = canonical.totalPrice - canonical.db3;
  const direct = canonical.directWages + canonical.supplements + canonical.employerOnCosts;
  const selfCost = db3Base;
  const months = number(input.contractMonths) || 12;
  const items = [
    ["WAGE", "Lohnkosten", canonical.directWages],
    ["SUPPLEMENTS", "Zuschläge", canonical.supplements],
    ["EMPLOYER", "Arbeitgebernebenkosten", canonical.employerOnCosts],
    ["ABSENCE", "Ausfallreserve", canonical.otherAbsenceReserve],
    ["DIRECT_COSTS", "Direkte Sachkosten", canonical.material],
    ["OVERHEAD", "Verwaltung", canonical.overhead],
    ["RISK", "Risikopuffer", canonical.risk],
  ].map(([code, label, amount]) => ({
    code, label, amount, unit: "EUR",
    source: "NON_PERSISTENT_MANUAL_SANDBOX",
    assumptionStatus: "USER_SUPPLIED_SANDBOX_VALUE",
    configVersion: config.version || null,
  }));

  return {
    status: "CALCULATED",
    schemaVersion: CALCULATION_SCHEMA_VERSION,
    missing: [],
    items,
    totals: {
      direct,
      selfCost,
      floor: selfCost,
      recommended: canonical.totalPrice,
      strategic,
      db1: strategic - db1Base,
      db2: strategic - db2Base,
      db3: strategic - db3Base,
      db1Pct: strategic ? (strategic - db1Base) / strategic : 0,
      db2Pct: strategic ? (strategic - db2Base) / strategic : 0,
      db3Pct: strategic ? (strategic - db3Base) / strategic : 0,
      monthly: strategic / months,
      annual: strategic / months * 12,
      totalContractValue: strategic,
      fTE: canonical.fte,
    },
    canonical,
    calculationContractVersion: canonical.calculationContractVersion,
    inputSnapshotSha256: canonical.inputSnapshotSha256,
    sandbox: true,
    persisted: false,
    managementComparable: true,
    externalTransmission: false,
  };
}

export function sensitivity(input = {}, config = {}) {
  const scaled = (riskFactor, hoursFactor = 1) => ({
    ...input,
    riskRate: Number(input.riskRate) * riskFactor,
    productiveHours: Number(input.productiveHours) * hoursFactor,
  });
  return {
    best: calculateScenario(scaled(0.75), config),
    base: calculateScenario(input, config),
    worst: calculateScenario(scaled(1.5, 1.1), config),
  };
}
