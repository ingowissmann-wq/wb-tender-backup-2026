const SAFE_MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

export function resolveRequiredSourceDocument(requirement = {}, candidates = []) {
  if (requirement.satisfaction_status === "SUPERSEDED")
    return { status: "SUPERSEDED", available: false, candidate: null };
  const exact = candidates.filter((candidate) =>
    requirement.source_document_id &&
    String(candidate.id) === String(requirement.source_document_id) &&
    String(candidate.tender_id) === String(requirement.tender_id) &&
    String(candidate.required_document_id) === String(requirement.id) &&
    String(candidate.company_id) === String(requirement.company_id) &&
    String(candidate.lot_key || "") === String(requirement.lot_key || "") &&
    Buffer.isBuffer(candidate.content) && candidate.content.length > 0 &&
    /^[a-f0-9]{64}$/i.test(String(candidate.payload_sha256 || "")) &&
    SAFE_MIME.test(String(candidate.mime_type || "")) &&
    String(candidate.filename || "").trim(),
  );
  if (!requirement.source_document_id || exact.length === 0)
    return { status: "NO_EXACT_SOURCE", available: false, candidate: null };
  if (exact.length !== 1)
    return { status: "AMBIGUOUS_SOURCE", available: false, candidate: null };
  const candidate = exact[0];
  return {
    status: "EXACT_SOURCE",
    available: true,
    candidate,
    documentId: candidate.id,
    filename: candidate.filename,
    mimeType: String(candidate.mime_type).toLowerCase(),
    sha256: candidate.payload_sha256,
    documentVersion: candidate.document_version || null,
    page: Number.isSafeInteger(Number(requirement.source_page)) && Number(requirement.source_page) > 0
      ? Number(requirement.source_page) : null,
  };
}
