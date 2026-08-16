const action = (view, label, anchor = "") => ({ view, label, anchor });

export function internalPreparationReadiness(input = {}) {
  const prerequisites = [
    {
      code: "CALCULATION_READY",
      label: "Kalkulation vollständig",
      satisfied: input.calculationReady === true,
      reason: input.calculationReady === true ? "Die aktuelle Kalkulation ist vollständig." : input.calculationReason || "Die aktuelle Kalkulation ist noch nicht vollständig.",
      action: action("calculation", "Fehlende Kalkulationswerte bearbeiten", "missing-calculation-inputs"),
    },
    {
      code: "MANAGEMENT_OUTPUT_CURRENT",
      label: "Aktuelle Managementausgabe vorhanden",
      satisfied: input.managementOutputCurrent === true,
      reason: input.managementOutputCurrent === true ? "Die Managementausgabe gehört zur aktuellen Kalkulation." : "Nach vollständiger Kalkulation muss die aktuelle Managementausgabe erzeugt werden.",
      action: action("management-output", "Managementausgabe öffnen"),
    },
    {
      code: "MANAGEMENT_APPROVAL_APPROVED",
      label: "Aktuelle Managementfreigabe erteilt",
      satisfied: input.managementApprovalApproved === true,
      reason: input.managementApprovalApproved === true ? "Die aktuelle, versionsgebundene Managementfreigabe ist erteilt." : "Die aktuelle Kalkulations- und Angebotsversion ist noch nicht freigegeben.",
      action: action("detail", "Managementfreigabe prüfen", "entscheidung"),
    },
    {
      code: "BID_PACKAGE_VALIDATED",
      label: "Validiertes Angebotspaket vorhanden",
      satisfied: input.bidPackageValidated === true,
      reason: input.bidPackageValidated === true ? "Das aktuelle Angebotspaket ist vollständig, validiert und versionsgebunden." : input.bidPackageReason || "Für die aktuelle Freigabe fehlt ein vollständiges, validiertes Angebotspaket.",
      action: action("offer-documents", "Angebotspaket vervollständigen"),
    },
  ];
  return {
    ready: prerequisites.every((item) => item.satisfied),
    prerequisites,
    label: "Angebotsabgabe intern vorbereiten",
    explanation: "Dabei wird ausschließlich ein interner Vorbereitungsdatensatz aus der aktuellen Managementfreigabe und dem validierten Angebotspaket erstellt.",
    confirmation: "Es erfolgt keine Übertragung an TED oder ein anderes Vergabeportal; transmitted=false und alle externen Abgabe-Endpunkte bleiben HTTP 423.",
  };
}

