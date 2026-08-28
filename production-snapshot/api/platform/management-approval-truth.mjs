const same = (left, right) => String(left ?? "") === String(right ?? "");
const sameVersion = (left, right) => Number(left) === Number(right);
const lot = (value) => (String(value ?? "") === "GLOBAL" ? "" : String(value ?? ""));

const change = (code, label, approved, current, changedAt = null) => ({
  code,
  label,
  approved,
  current,
  changedAt,
});

export function evaluateManagementApprovalTruth(input) {
  const approval = input?.approval || {};
  const manifest = approval.payloadManifest || approval.payload_manifest || {};
  const current = input?.current || {};
  const context = input?.context || {};
  const pkg = input?.bidPackage || input?.package || {};
  const gate = pkg.approvalGate || {};
  const changes = [];
  const scopeValid =
    same(manifest.tenderId, context.tender_id) &&
    same(manifest.companyId, context.company_id) &&
    same(lot(manifest.lotKey), lot(context.lot_key));
  const exactApprovalBinding =
    (same(pkg.manifest?.approvalRequestId, approval.id) && same(pkg.manifest?.approvalPayloadHash, approval.payloadSha256 || approval.payload_sha256)) ||
    (same(gate.approvalRequestId, approval.id) && same(gate.bindingSha256, approval.payloadSha256 || approval.payload_sha256));
  const bindingValid =
    same(context.approval_request_id, approval.id) &&
    same(context.bid_package_id, pkg.id) &&
    exactApprovalBinding &&
    same(pkg.calculation_id, manifest.calculationId) &&
    sameVersion(pkg.calculation_version, manifest.calculationVersion) &&
    same(pkg.management_output_id, manifest.managementOutputId) &&
    sameVersion(pkg.manifest?.managementVersion, manifest.managementVersion) &&
    same(pkg.tender_version_id, manifest.tenderVersionId) &&
    same(pkg.document_revision_sha256, manifest.documentVersion);

  if (current.tenderVersionId && !same(current.tenderVersionId, manifest.tenderVersionId))
    changes.push(change("TENDER_VERSION_CHANGED", "Tender-Version", manifest.tenderVersionId, current.tenderVersionId, current.tenderChangedAt));
  if (current.documentVersion && !same(current.documentVersion, manifest.documentVersion))
    changes.push(change("DOCUMENT_VERSION_CHANGED", "Dokumentenstand", manifest.documentVersion, current.documentVersion, current.documentChangedAt));
  if (current.calculationId && (!same(current.calculationId, manifest.calculationId) || !sameVersion(current.calculationVersion, manifest.calculationVersion)))
    changes.push(change("CALCULATION_VERSION_CHANGED", "Kalkulationsversion", manifest.calculationVersion, current.calculationVersion, current.calculationChangedAt));
  if (current.managementOutputId && (!same(current.managementOutputId, manifest.managementOutputId) || !sameVersion(current.managementVersion, manifest.managementVersion)))
    changes.push(change("MANAGEMENT_VERSION_CHANGED", "Managementausgabe", manifest.managementVersion, current.managementVersion, current.managementChangedAt));

  let reason = null;
  if (!scopeValid) reason = "Die Managementfreigabe gehört nicht exakt zu Tender, Gesellschaft und Los dieses Abgabekontexts.";
  else if (!bindingValid) reason = "Die gespeicherte Freigabe ist nicht durchgängig an das kanonische Bid Package gebunden.";
  else if (changes.length) {
    const details = changes.map((item) => `${item.label}: freigegeben ${item.approved}, aktuell ${item.current}${item.changedAt ? ` seit ${new Date(item.changedAt).toISOString()}` : ""}`).join("; ");
    reason = `Die Managementfreigabe ist wegen einer materiellen Änderung veraltet (${details}).`;
  }
  else if (approval.status !== "APPROVED") reason = "Die Managementfreigabe wurde nicht erteilt oder ausdrücklich aufgehoben.";
  const valid = reason === null;
  return {
    valid,
    status: valid ? "APPROVED_CURRENT" : "APPROVAL_STALE_OR_INVALID",
    scope: { tenderId: context.tender_id, companyId: context.company_id, lotKey: lot(context.lot_key) },
    approvedAt: approval.approvedAt || null,
    approvalRequestId: approval.id || null,
    payloadSha256: approval.payloadSha256 || approval.payload_sha256 || null,
    approvedVersions: {
      tenderVersionId: manifest.tenderVersionId || null,
      documentVersion: manifest.documentVersion || null,
      calculationId: manifest.calculationId || null,
      calculationVersion: manifest.calculationVersion ?? null,
      managementOutputId: manifest.managementOutputId || null,
      managementVersion: manifest.managementVersion ?? null,
      offerVersion: manifest.offerVersion ?? null,
    },
    currentVersions: current,
    changes,
    reason,
  };
}

export function managementApprovalBlocker(truth) {
  if (truth?.valid) return null;
  return {
    code: "MANAGEMENT_APPROVAL_INVALID",
    message: truth?.reason || "Eine exakt versionsgebundene Managementfreigabe fehlt.",
    approvalTruth: truth || null,
  };
}
