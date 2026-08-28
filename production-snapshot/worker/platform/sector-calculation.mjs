import {isExplicitlySupplied,snapshotHash} from "./canonical-truth.mjs";

const numeric=value=>{
  if(Array.isArray(value)){for(const item of value){const parsed=numeric(item);if(parsed!==null)return parsed}return null}
  const candidate=typeof value==="object"&&value!==null?(value.value??value.amount??value.percent??value.hours??value.rate):value;
  if(candidate===null||candidate===undefined||String(candidate).trim()==="")return null;
  const match=String(candidate).replace(/\s/g,"").replace(",",".").match(/-?\d+(?:\.\d+)?/),parsed=match?Number(match[0]):NaN;
  return Number.isFinite(parsed)?parsed:null;
};
const rate=(parameters,key,fallback=0)=>numeric(parameters[key])??fallback;
const money=value=>Math.round((value+Number.EPSILON)*100)/100;
const durationMonths=(value,fallback=12)=>{const values=Array.isArray(value)?value:[value];for(const item of values){const dates=[...String(item??"").matchAll(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/g)].map(x=>new Date(Date.UTC(Number(x[3]),Number(x[2])-1,Number(x[1]))));if(dates.length>=2&&dates.at(-1)>=dates[0])return Math.max(1,(dates.at(-1).getUTCFullYear()-dates[0].getUTCFullYear())*12+dates.at(-1).getUTCMonth()-dates[0].getUTCMonth()+1)}const parsed=numeric(value);return parsed&&parsed>0?parsed:fallback};

export function calculateSectorTender({
  serviceArea,
  parameters = {},
  units = {},
  facts = {},
  provenance = {},
  contractMonths = 12,
} = {}) {
  const productiveHours = numeric(
    facts.productiveHours ??
    facts.requiredHours ??
    facts.hours
  );

  const baseWage = rate(parameters, "C01", null);
  const missing = [];

  if (productiveHours === null || productiveHours <= 0)
    missing.push("Produktivstunden");

  if (baseWage === null)
    missing.push("C01 Grundlohn");

  if (
    (productiveHours === null || productiveHours <= 0) &&
    !isExplicitlySupplied(facts.workdays)
  )
    missing.push("Arbeitstage");

  if (!isExplicitlySupplied(facts.duration ?? contractMonths))
    missing.push("Vertragslaufzeit");

  if (missing.length)
    return {
      status: "CALCULATION_BLOCKED_MISSING_INPUT",
      missing,
      provenance,
      externalTransmission: false,
    };

  const months = durationMonths(
    facts.duration,
    contractMonths
  );

  const years = months / 12;

  const fteAnnualHours =
    numeric(
      facts.fteAnnualHours ??
      parameters.fteAnnualHours ??
      parameters.FTE_ANNUAL_HOURS
    ) ?? 1600;

  if (
    !Number.isFinite(fteAnnualHours) ||
    fteAnnualHours <= 0
  )
    missing.push(
      "Produktive Jahresstunden je Vollzeitkraft"
    );

  const fte =
    productiveHours /
    (fteAnnualHours * Math.max(years, 1 / 12));

  const unitDefaults = {
    C08: "PERCENT",
    C09: "EUR_PER_HOUR",
    C10: "EUR_PER_HOUR",
    C11: "EUR_PER_UNIT",
    C12: "EUR_PER_HOUR",
    C13: "EUR_PER_KM",
    C14: "EUR_PER_KM",
    C15: "EUR_PER_FTE",
    C16: "EUR_PER_UNIT",
    C17: "EUR_PER_YEAR",
    C19: "PERCENT",
    C20: "PERCENT",
    C21: "PERCENT",
  };

  const unitFor = (key) => {
    const value = units[key];

    if (typeof value === "string" && value.trim())
      return value.trim().toUpperCase();

    if (value && typeof value === "object")
      return String(
        value.id ??
        value.unitId ??
        value.unit_id ??
        ""
      ).toUpperCase();

    return unitDefaults[key] || null;
  };

  const hourlyPricePositions =
    Array.isArray(facts.pricePositions) &&
    facts.pricePositions.length > 0 &&
    facts.pricePositions.every((position) =>
      /stunde|hour/i.test(String(position.unit || ""))
    );

  const inferredUnitCount =
    numeric(facts.unitCount) ??
    (hourlyPricePositions ? productiveHours : null);

  const quantityForUnit = (unit) => {
    switch (unit) {
      case "EUR_PER_HOUR":
        return productiveHours;
      case "EUR_PER_MONTH":
        return months;
      case "EUR_PER_YEAR":
        return years;
      case "EUR_PER_FTE":
        return fte;
      case "EUR_PER_OBJECT":
        return numeric(facts.objectCount);
      case "EUR_PER_UNIT":
        return inferredUnitCount;
      case "EUR_PER_KM":
        return numeric(facts.kilometers);
      default:
        return null;
    }
  };

  const unappliedConditionalCosts = [];

  const configuredCost = (
    key,
    {
      percentBase = 0,
      conditionalWhenQuantityMissing = false,
    } = {}
  ) => {
    const value = rate(parameters, key, 0);
    if (!value) return 0;

    const unit = unitFor(key);

    if (unit === "PERCENT")
      return percentBase * value / 100;

    if (unit === "EUR")
      return value;

    const quantity = quantityForUnit(unit);

    if (
      quantity === null ||
      !Number.isFinite(quantity) ||
      quantity < 0
    ) {
      if (conditionalWhenQuantityMissing) {
        unappliedConditionalCosts.push({
          parameterKey: key,
          configuredValue: value,
          configuredUnit: unit,
          reasonCode: "NO_COMPATIBLE_QUANTITY_SOURCE",
          appliedAmount: 0,
        });
        return 0;
      }

      missing.push(
        key + " Bezugsmenge für " + unit
      );
      return 0;
    }

    return value * quantity;
  };

  const directWages = productiveHours * baseWage;

  const supplementText = String(
    parameters.C03 ?? ""
  );

  const supplementRate = (pattern) => {
    const match = supplementText.match(pattern);
    if (!match) return 0;
    return numeric(match[1]) ?? 0;
  };

  const nightRate = supplementRate(
    /nacht[^0-9]{0,30}([0-9]+(?:[.,][0-9]+)?)\s*%/i
  );

  const sundayRate = supplementRate(
    /sonntag[^0-9]{0,30}([0-9]+(?:[.,][0-9]+)?)\s*%/i
  );

  const holidayRate = supplementRate(
    /feiertag[^0-9]{0,30}([0-9]+(?:[.,][0-9]+)?)\s*%/i
  );

  const structuredSupplements =
    nightRate || sundayRate || holidayRate;

  const supplements = structuredSupplements
    ? (
        (numeric(facts.nightHours) || 0) *
          baseWage * nightRate / 100 +
        (numeric(facts.sundayHours) || 0) *
          baseWage * sundayRate / 100 +
        (numeric(facts.holidayHours) || 0) *
          baseWage * holidayRate / 100
      )
    : directWages * rate(parameters, "C03", 0) / 100;

  const employerOnCosts =
    (directWages + supplements) *
    rate(parameters, "C04", 0) / 100;

  const holidayReserve =
    directWages * rate(parameters, "C05", 0) / 100;

  const sicknessReserve =
    directWages * rate(parameters, "C06", 0) / 100;

  const otherAbsenceReserve =
    directWages * rate(parameters, "C07", 0) / 100;

  const laborCostBase =
    directWages +
    supplements +
    employerOnCosts +
    holidayReserve +
    sicknessReserve +
    otherAbsenceReserve;

  const siteManagement =
    configuredCost("C09", {
      percentBase: laborCostBase,
    });

  const operationsManagement =
    configuredCost("C10", {
      percentBase: laborCostBase,
    });

  const material =
    configuredCost("C11", {
      percentBase: laborCostBase,
    });

  const equipment =
    configuredCost("C12", {
      percentBase: laborCostBase,
    });

  const vehicles =
    configuredCost("C13", {
      percentBase: laborCostBase,
      conditionalWhenQuantityMissing: true,
    });

  const travel =
    configuredCost("C14", {
      percentBase: laborCostBase,
      conditionalWhenQuantityMissing: true,
    });

  const recruiting =
    configuredCost("C15", {
      percentBase: laborCostBase,
    });

  const subcontractors =
    configuredCost("C16", {
      percentBase: laborCostBase,
    });

  const insurance =
    configuredCost("C17", {
      percentBase: laborCostBase,
    });

  const contractWeeks =
    Math.max(1, months) * 52 / 12;

  const securityVideo =
    serviceArea === "security"
      ? rate(parameters, "S01")
      : 0;

  const securityFacilityWeeks =
    serviceArea === "security"
      ? rate(parameters, "S02") * contractWeeks
      : 0;

  const securityEmergencyWeeks =
    serviceArea === "security"
      ? rate(parameters, "S03") * contractWeeks
      : 0;

  const securitySiteEquipment =
    serviceArea === "security"
      ? rate(parameters, "S04")
      : 0;

  const securityNonPersonnelCosts =
    securityVideo +
    securityFacilityWeeks +
    securityEmergencyWeeks +
    securitySiteEquipment;

  const indirectObjectCosts =
    siteManagement +
    operationsManagement +
    material +
    equipment +
    vehicles +
    travel +
    recruiting +
    subcontractors +
    insurance +
    securityNonPersonnelCosts;

  const overheadBase =
    laborCostBase + indirectObjectCosts;

  const overhead =
    configuredCost("C08", {
      percentBase: overheadBase,
    });

  const riskBase =
    overheadBase + overhead;

  const risk =
    riskBase * rate(parameters, "C18", 0) / 100;

  if (missing.length)
    return {
      status: "CALCULATION_BLOCKED_MISSING_INPUT",
      missing: [...new Set(missing)],
      provenance: {
        ...provenance,
        parameterUnits: units,
        fteAnnualHours,
      },
      externalTransmission: false,
    };

  const db1Target = rate(parameters, "C19", 0);
  const db2Target = rate(parameters, "C20", 0);
  const db3Target = rate(parameters, "C21", 0);

  const priceForTarget = (
    costBase,
    target,
    unit
  ) => unit === "EUR"
    ? costBase + target
    : costBase /
      (1 - Math.min(95, target) / 100);

  const db1Base = laborCostBase;

  const db2Base =
    laborCostBase + indirectObjectCosts;

  const db3Base =
    laborCostBase +
    indirectObjectCosts +
    overhead +
    risk;

  const targetPrice = Math.max(
    db1Base,
    db2Base,
    db3Base,
    priceForTarget(
      db1Base,
      db1Target,
      unitFor("C19")
    ),
    priceForTarget(
      db2Base,
      db2Target,
      unitFor("C20")
    ),
    priceForTarget(
      db3Base,
      db3Target,
      unitFor("C21")
    )
  );

  const contribution1 =
    targetPrice - db1Base;

  const contribution2 =
    targetPrice - db2Base;

  const contribution3 =
    targetPrice - db3Base;

  const result = {
    schemaVersion: 4,
    status: "CALCULATED",
    serviceArea,
    productiveHours: money(productiveHours),
    hoursPerMonth: money(productiveHours / months),
    hoursPerYear: money(productiveHours / months * 12),
    nightHours: money(numeric(facts.nightHours) || 0),
    sundayHours: money(numeric(facts.sundayHours) || 0),
    holidayHours: money(numeric(facts.holidayHours) || 0),
    staffingStrength: numeric(facts.staffingStrength),
    fte: money(fte),
    fteAnnualHours: money(fteAnnualHours),
    directWages: money(directWages),
    supplements: money(supplements),
    employerOnCosts: money(employerOnCosts),
    holidayReserve: money(holidayReserve),
    sicknessReserve: money(sicknessReserve),
    otherAbsenceReserve: money(otherAbsenceReserve),
    overhead: money(overhead),
    recruiting: money(recruiting),
    siteAndOperationsManagement:
      money(siteManagement + operationsManagement),
    material: money(material),
    equipment: money(equipment),
    clothing: 0,
    vehicles: money(vehicles),
    travel: money(travel),
    unappliedConditionalCosts,
    subcontractors: money(subcontractors),
    insurance: money(insurance),
    securityNonPersonnelCosts:
      money(securityNonPersonnelCosts),
    securityCostParameters: {
      S01: securityVideo,
      S02: rate(parameters, "S02"),
      S03: rate(parameters, "S03"),
      S04: securitySiteEquipment,
      contractWeeks: money(contractWeeks),
    },
    risk: money(risk),
    db1Percent: db1Target,
    db2Percent: db2Target,
    db3Percent: db3Target,
    db1: money(contribution1),
    db2: money(contribution2),
    db3: money(contribution3),
    profit: money(contribution3),
    hourlyRate: money(targetPrice / productiveHours),
    squareMeterPrice:
      serviceArea === "cleaning" &&
      numeric(facts.areas)
        ? money(targetPrice / numeric(facts.areas))
        : null,
    monthlyPrice: money(targetPrice / months),
    annualPrice: money(targetPrice / months * 12),
    totalPrice: money(targetPrice),
    pricePositions: facts.pricePositions || [],
    provenance: {
      ...provenance,
      parameterUnits: units,
      fteAnnualHours,
      formulaVersion:
        "global-unit-aware-calculation-v2",
      conditionalCostPolicy:
        "APPLY_ONLY_WITH_COMPATIBLE_QUANTITY_SOURCE",
      unappliedConditionalCosts,
    },
    externalTransmission: false,
  };

  return {
    ...result,
    calculationHash: snapshotHash(result),
  };
}

export function buildManagementOutput({tender,lotKey,company,profileSnapshot,documentRevision,calculation,missing=[],jobId,correlationId,now=new Date().toISOString()}={}) {
  const calculated=["CALCULATED","CALCULATED_REAL","CALCULATION_PARTIAL"].includes(calculation?.status),partial=calculation?.status==="CALCULATION_PARTIAL",missingFacilityProfile=calculation?.status==="CALCULATION_BLOCKED_MISSING_FACILITY_PROFILE";
  const output={schemaVersion:3,status:calculated?"MANAGEMENT_OUTPUT_GENERATED":missingFacilityProfile?"CALCULATION_BLOCKED_MISSING_FACILITY_PROFILE":"NICHT_KALKULIERBAR_FEHLENDE_TENDERUNTERLAGEN",executiveSummary:{buyer:tender?.buyer||null,tender:tender?.title||null,lot:lotKey||null,serviceArea:company?.sector_slug||null,deadline:tender?.offer_deadline||null},recommendation:{decision:partial?"MANAGEMENT_REVIEW_REQUIRED_PARTIAL":calculated?"CONDITIONAL_GO":"NICHT_ANGEBOTSFÄHIG",reason:partial?"Belastbare Teilkalkulation liegt vor; ausgewiesene Einzelpositionen benötigen noch einen quellengebundenen Kostenansatz.":calculated?"Kalkulation liegt vollständig und quellengebunden zur fachlichen Entscheidung vor.":missingFacilityProfile?"Für company_id und Facility-Service-Line existiert kein aktives, freigegebenes Kalkulationsprofil; eine fachfremde Fallback-Auflösung ist gesperrt.":"Tenderbezogene Pflichtangaben fehlen.",requiredActions:missing.map(item=>item.field||item)},calculation:calculated?calculation:null,personnel:calculated?{productiveHours:calculation.productiveHours,fte:calculation.fte}:null,risks:{classification:calculated?"FACHLICHE_PRÜFUNG_ERFORDERLICH":missingFacilityProfile?"FACILITY_PROFILE_MISSING":"DOKUMENTENRISIKO",items:[]},capacity:{status:calculated?"AUS_EFFECTIVE_PROFILE_GEBUNDEN":missingFacilityProfile?"FACILITY_PROFILE_REQUIRED":"NACH_DOKUMENTEINGANG_NEU_BEWERTEN"},awardChance:{value:null,confidence:"NOT_ENOUGH_AUTHORITATIVE_DATA",invented:false},evidence:{missing,profileComplete:!missingFacilityProfile},nextSteps:calculated?[{action:"BOARD_REVIEW",priority:"HIGH"}]:missingFacilityProfile?[{action:"APPROVE_FACILITY_CALCULATION_PROFILE",priority:"HIGH"}]:[{action:"AUTOMATIC_DOCUMENT_REFETCH",priority:"HIGH"}],provenance:{profileSnapshotId:profileSnapshot?.id||null,profileRevision:profileSnapshot?.revision||null,documentRevision,calculationVersion:calculation?.schemaVersion||null,managementOutputVersion:3,jobId,correlationId,generatedAt:now},externalTransmission:false};
  return {...output,outputHash:snapshotHash(output)};
}
