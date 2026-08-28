const definitions = Object.freeze({
  "Produktivstunden": Object.freeze({
    key: "productive_hours",
    label: "Produktivstunden für die gesamte Vertragslaufzeit",
    inputLabel: "Produktivstunden",
    type: "number",
    unit: "Stunden",
    minExclusive: 0,
    step: "0.01",
    explanation: "Dieser Wert bestimmt Personalbedarf, Lohnkosten und Angebotspreis und muss fachlich durch den Bieter kalkuliert werden.",
  }),
});

export const calculationInputDefinition = (field) => definitions[String(field || "")] || null;

export function calculationMissingInputAction(item = {}) {
  const definition = calculationInputDefinition(item.field || item.label);
  if (definition && item.documentStatus === "EVIDENCE_REQUIRED_BIDDER_INPUT") {
    return {
      kind: "internal-input",
      view: "calculation",
      anchor: `calculation-input-${definition.key}`,
      label: `${definition.inputLabel} jetzt erfassen`,
      input: definition,
    };
  }
  if (item.parameterKey) {
    return {
      kind: "company-configuration",
      view: "settings",
      parameterKey: item.parameterKey,
      label: `${item.parameterKey} in der Gesellschaftskonfiguration öffnen`,
    };
  }
  return {
    kind: "documents",
    view: "documents",
    label: "Geprüfte Vergabeunterlagen öffnen",
  };
}

export function presentMissingCalculationInput(item = {}) {
  const raw = typeof item === "object" && item ? item : { field: String(item) };
  const definition = calculationInputDefinition(raw.field || raw.label);
  return {
    field: String(raw.field || raw.label || "Fehlender Kalkulationswert"),
    label: definition?.label || String(raw.label || raw.field || "Fehlender Kalkulationswert"),
    quantity: raw.quantity ?? null,
    unit: raw.unit || definition?.unit || null,
    reason: raw.reason || raw.nextAction || "Der Wert ist aus den geprüften Quellen nicht belastbar ableitbar.",
    requiredSource: raw.source || raw.checkedSource || "Vergabeunterlagen",
    documentStatus: raw.documentStatus || null,
    action: calculationMissingInputAction(raw),
  };
}

export function validateExplicitCalculationInput(fieldKey, value, unit) {
  const definition = Object.values(definitions).find((item) => item.key === fieldKey);
  if (!definition) return { valid: false, error: "calculation_input_not_supported" };
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= definition.minExclusive)
    return { valid: false, error: "calculation_input_value_invalid" };
  if (String(unit || definition.unit) !== definition.unit)
    return { valid: false, error: "calculation_input_unit_invalid" };
  return { valid: true, definition, value: parsed, unit: definition.unit };
}

