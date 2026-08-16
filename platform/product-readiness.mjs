export const BINDING_PORTAL_ACTIONS = Object.freeze([
  "SUBMISSION",
  "PARTICIPATION",
  "BIDDER_COMMUNICATION",
  "WITHDRAWAL",
  "REVOCATION",
  "AMENDMENT_SEND",
]);

export const PRODUCT_BOUNDARY = Object.freeze({
  edition: "INTERNAL_TENDER_ASSISTANT_WITH_PORTAL_PREFLIGHT",
  marketableAs: "Produktiver interner Tender-Assistent mit sicherem Portal-Preflight",
  mustNotBeMarketedAs: "Autonome externe Angebotsabgabe",
  external_submission_enabled: false,
  transmitted: false,
  bindingPortalActionsHttpStatus: 423,
  bindingPortalActions: BINDING_PORTAL_ACTIONS,
});

export const capabilityState = (feature = {}) => ({
  portalSupported: feature.portalSupport || feature.portal_support || "UNKNOWN",
  autopilotSupported: feature.autopilotSupported === true || feature.autopilot_supported === true,
  configured: feature.activelyConfigured === true || feature.actively_configured === true,
  technicallyTested: feature.productionTested === true || feature.production_tested === true,
  productiveBrowserVerified: feature.browserAcceptancePassed === true || feature.browser_acceptance_passed === true,
  verifiedAt: feature.verifiedAt || feature.verified_at || null,
  evidenceNote: feature.evidenceNote || feature.evidence_note || null,
});

export function readinessGate({ transmittedTrue = 0, portals = [] } = {}) {
  const unsafeTransmission = Number(transmittedTrue) !== 0;
  const configuredWithoutBrowserEvidence = portals.flatMap((portal) =>
    Object.entries(portal.features || {})
      .filter(([, feature]) => feature.configured && !feature.productiveBrowserVerified)
      .map(([featureKey]) => ({ portalId: portal.portalId, featureKey })),
  );
  return {
    editionReady: !unsafeTransmission,
    externalSubmissionReady: false,
    status: unsafeTransmission ? "NOT_READY_SAFETY_VIOLATION" : "READY_WITH_EXPLICIT_PRODUCT_BOUNDARY",
    configuredWithoutBrowserEvidence,
    boundary: PRODUCT_BOUNDARY,
  };
}
