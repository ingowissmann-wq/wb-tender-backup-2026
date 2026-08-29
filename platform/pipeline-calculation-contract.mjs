import {
  CALCULATION_CONTRACT_STATES,
  createCalculationContractSnapshot,
  executeCalculationContractSnapshot,
} from "./calculation-contract.mjs";

const immutable = value => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(immutable);
  return Object.freeze(value);
};

export function runPipelineCalculationContract({
  scope,
  engineInput,
  factRecords = [],
  parameterRecords = [],
  documentFingerprints = [],
  ruleTypes = [],
  blockingReasons = [],
} = {}) {
  const blocked = Array.isArray(blockingReasons) && blockingReasons.length > 0;
  const snapshot = createCalculationContractSnapshot({
    state: blocked
      ? CALCULATION_CONTRACT_STATES.QUARANTINED
      : CALCULATION_CONTRACT_STATES.READY,
    scope,
    engineInput,
    factRecords,
    parameterRecords,
    documentFingerprints,
    ruleTypes,
    blockingReasons,
  });

  if (blocked)
    return immutable({
      status: "CALCULATION_BLOCKED_CONTRACT",
      snapshot,
      calculation: null,
      blockingReasons: snapshot.blockingReasons,
      externalTransmission: false,
    });

  return immutable({
    status: "CALCULATION_CONTRACT_EXECUTED",
    snapshot,
    calculation: executeCalculationContractSnapshot(snapshot),
    blockingReasons: [],
    externalTransmission: false,
  });
}
