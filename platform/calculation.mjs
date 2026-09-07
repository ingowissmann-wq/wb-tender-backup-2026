// Retained as a fail-closed compatibility boundary for obsolete callers.
// The only productive engine is calculateSectorTender in sector-calculation.mjs.
export function calculateScenario() {
  throw Object.assign(new Error("legacy_calculation_engine_disabled"), {statusCode: 410});
}
export function sensitivity() {
  throw Object.assign(new Error("legacy_calculation_engine_disabled"), {statusCode: 410});
}
