const PRESENT = new Set(["PASSED", "VALIDATED", "COMPLETED", "AVAILABLE", "POSSIBLE", true]);
const FAILED = new Set(["FAILED", "REJECTED", "EXCLUDED", "IMPOSSIBLE", false]);
const number = value => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const status = value => PRESENT.has(value) ? "PASSED" : FAILED.has(value) ? "FAILED" : "UNKNOWN";
const clamp = value => Math.max(0, Math.min(100, value));

export const OPERATIONS_SCHEMA_VERSION = 1;

export function evaluateOperationsCandidate(input = {}) {
  const gates = {
    groupFit: status(input.groupFit),
    companyFit: status(input.companyFit),
    certificates: status(input.certificates),
    references: status(input.references),
    region: status(input.region),
    capacity: status(input.capacity),
    economics: status(input.economics),
    deadline: status(input.deadline),
    calculation: status(input.calculation),
    submission: status(input.submission),
  };
  const failed = Object.entries(gates).filter(([, value]) => value === "FAILED").map(([key]) => key);
  const unknown = Object.entries(gates).filter(([, value]) => value === "UNKNOWN").map(([key]) => key);
  const decision = failed.length ? "NO_GO" : unknown.length ? "GO_MIT_AUFLAGEN" : "GO";
  const totals = input.calculationTotals || {};
  const financials = {
    expectedRevenue: number(totals.contractValue ?? totals.totalPrice ?? totals.offerPriceNet),
    db1: number(totals.db1),
    db2: number(totals.db2),
    db3: number(totals.db3),
  };
  const completionFacts = [input.documentsComplete, input.requirementsComplete, input.calculationComplete, input.managementComplete, input.preflightComplete];
  const knownCompletion = completionFacts.filter(value => value === true || value === false);
  const offerCompletionProbability = knownCompletion.length
    ? {available:true, value:clamp(knownCompletion.filter(Boolean).length / knownCompletion.length * 100), basis:"Anteil real abgeschlossener Angebotsgates"}
    : {available:false, value:null, basis:"Keine belastbaren Workflowdaten"};
  const awardProbability = number(input.observedAwardProbability);
  const riskFacts = Array.isArray(input.risks) ? input.risks : [];
  const riskIndex = riskFacts.length && riskFacts.every(item => number(item.weight) !== null)
    ? {available:true, value:clamp(riskFacts.reduce((sum, item) => sum + Number(item.weight), 0)), basis:"Dokumentierte Einzelrisiken"}
    : {available:false, value:null, basis:"Keine vollständig bewerteten realen Risiken"};
  return {
    schemaVersion: OPERATIONS_SCHEMA_VERSION,
    tenderId: input.tenderId,
    lotKey: input.lotKey || "",
    companyId: input.companyId,
    title: input.title,
    buyer: input.buyer,
    deadline: input.offerDeadline || null,
    decision,
    gates,
    failedGates: failed,
    conditions: unknown,
    financials,
    calculationConfidence: input.calculationConfidence || (status(input.calculation) === "PASSED" ? "BELEGT" : "NICHT_BELASTBAR"),
    processingEffort: number(input.processingEffort),
    offerCompletionProbability,
    awardProbability: awardProbability === null
      ? {available:false, value:null, basis:"Keine reale historische Zuschlagsquote für diesen belegten Kontext"}
      : {available:true, value:clamp(awardProbability), basis:"Reale historische Zuschlagsdaten"},
    riskIndex,
    strategicImportance: number(input.strategicImportance),
    nextAction: determineNextAction({...input, gates}),
  };
}

export function determineNextAction(input = {}) {
  const gates = input.gates || {};
  if (gates.certificates === "UNKNOWN" || gates.references === "UNKNOWN") return {action:"NACHWEIS_ERGAENZEN", label:"Fehlenden Nachweis oder Referenz ergänzen"};
  if (input.siteVisitRequired && !input.siteVisitCompleted) return {action:"OBJEKTBEGEHUNG_DURCHFUEHREN", label:"Objektbegehung durchführen"};
  if (input.missingDocuments > 0 || input.documentsComplete === false) return {action:"DOKUMENT_HOCHLADEN", label:"Fehlende Angebotsunterlage hochladen"};
  if (input.requirementsComplete === false) return {action:"ANFORDERUNGEN_PRUEFEN", label:"Offene Anforderungen prüfen"};
  if (gates.calculation !== "PASSED") return {action:"KALKULATION_VERVOLLSTAENDIGEN", label:"Kalkulationsgrundlagen vervollständigen"};
  if (input.managementComplete === false) return {action:"MANAGEMENTFREIGABE", label:"Managementfreigabe einholen"};
  if (input.preflightComplete === false) return {action:"ANGEBOTSABGABE_VORBEREITEN", label:"Angebotsabgabe vorbereiten"};
  return {action:"BEARBEITUNGSSTAND_PRUEFEN", label:"Bearbeitungsstand prüfen"};
}

export function prioritizeOperationsCandidates(candidates = []) {
  const scored = candidates.map(evaluateOperationsCandidate).map(candidate => {
    const revenue = candidate.financials.expectedRevenue;
    const contribution = candidate.financials.db3 ?? candidate.financials.db2 ?? candidate.financials.db1;
    const effort = candidate.processingEffort;
    const strategic = candidate.strategicImportance;
    const completeness = candidate.offerCompletionProbability.value;
    const evidenceCount = [revenue, contribution, effort, strategic, completeness].filter(value => value !== null).length;
    const priorityScore = evidenceCount < 2 ? null :
      (candidate.decision === "GO" ? 30 : candidate.decision === "GO_MIT_AUFLAGEN" ? 15 : 0) +
      (completeness === null ? 0 : completeness * .25) +
      (strategic === null ? 0 : clamp(strategic) * .2) +
      (effort === null ? 0 : (100 - clamp(effort)) * .15) +
      (contribution === null || revenue === null || revenue <= 0 ? 0 : clamp(contribution / revenue * 100) * .1);
    return {...candidate, priorityScore};
  });
  scored.sort((a,b) => (b.priorityScore ?? -1) - (a.priorityScore ?? -1) || String(a.deadline || "9999").localeCompare(String(b.deadline || "9999")) || String(a.tenderId).localeCompare(String(b.tenderId)));
  return scored.map((candidate,index) => ({...candidate, priority: candidate.priorityScore === null ? null : index + 1}));
}

export function buildOperationsKpis(candidates = [], outcomes = []) {
  const items = prioritizeOperationsCandidates(candidates);
  const sum = key => items.reduce((total,item) => total + (item.financials[key] ?? 0), 0);
  return {
    found: items.length,
    economicallyInteresting: items.filter(item => item.gates.economics === "PASSED").length,
    go: items.filter(item => item.decision === "GO").length,
    conditionalGo: items.filter(item => item.decision === "GO_MIT_AUFLAGEN").length,
    noGo: items.filter(item => item.decision === "NO_GO").length,
    inProgress: items.filter(item => item.offerCompletionProbability.available && item.offerCompletionProbability.value < 100).length,
    readyForSubmission: items.filter(item => item.offerCompletionProbability.value === 100).length,
    submitted: outcomes.filter(item => item.transmitted === true).length,
    awards: outcomes.filter(item => item.outcome === "AWARDED").length,
    revenuePotential: sum("expectedRevenue"),
    expectedContribution: sum("db3") || sum("db2") || sum("db1"),
  };
}

export function learnFromRealOutcomes(records = []) {
  const real = records.filter(item => item.dataClass === "PUBLIC_REAL" && item.processed === true);
  const frequencies = field => Object.entries(real.flatMap(item => item[field] || []).reduce((map,value) => (map[value] = (map[value] || 0) + 1, map), {})).sort((a,b) => b[1]-a[1]).map(([value,count]) => ({value,count}));
  return {
    sampleSize: real.length,
    requirements: frequencies("requirements"),
    missingEvidence: frequencies("missingEvidence"),
    successfulConcepts: frequencies("successfulConcepts"),
    successfulCalculations: real.filter(item => item.outcome === "AWARDED" && item.calculationVersion).map(item => ({tenderId:item.tenderId, calculationVersion:item.calculationVersion})),
    syntheticValuesUsed: false,
  };
}
