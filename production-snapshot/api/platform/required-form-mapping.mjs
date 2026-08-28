import { inspectPdfAcroForm } from "./required-pdf-form.mjs";

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const EDITABLE = new Set([DOCX, XLSX]);
const TENDER_CONTAINER_PDF = /(?:vergabe|ausschreibungs|gesamt|komplett)[-_ ]*unterlagen/i;

export const hasPdfAcroForm = async (content) => {
  try { return (await inspectPdfAcroForm(content)).editable; }
  catch { return false; }
};

export async function resolveRequiredOriginalForm(requirement = {}, candidates = []) {
  if (requirement.satisfaction_status === "SUPERSEDED")
    return { status: "SUPERSEDED", downloadable: false, editable: false, candidate: null };
  const exact = candidates.filter((candidate) =>
    String(candidate.id) === String(requirement.source_document_id || "") &&
    String(candidate.tender_id) === String(requirement.tender_id) &&
    String(candidate.company_id || requirement.company_id) === String(requirement.company_id) &&
    String(candidate.lot_key || "") === String(requirement.lot_key || "") &&
    candidate.payload_sha256 && candidate.content &&
    candidate.procurement_verification_status === "VERIFIED" &&
    candidate.explicit_form_mapping === true &&
    !(String(candidate.mime_type || "").toLowerCase() === PDF && TENDER_CONTAINER_PDF.test(String(candidate.filename || ""))),
  );
  if (!requirement.source_document_id || !exact.length)
    return { status: "NO_PROVEN_MAPPING", downloadable: false, editable: false, candidate: null };
  if (exact.length !== 1)
    return { status: "AMBIGUOUS_MAPPING", downloadable: false, editable: false, candidate: null };
  const candidate = exact[0], mime = String(candidate.mime_type || "").toLowerCase();
  const editable = EDITABLE.has(mime) || (mime === PDF && await hasPdfAcroForm(candidate.content));
  return {
    status: editable ? "PROVEN_EDITABLE_FORM" : "PROVEN_ORIGINAL_ONLY",
    downloadable: true,
    editable,
    candidate,
    mimeType: mime,
    documentId: candidate.id,
    documentVersion: candidate.document_version || candidate.enrichment_version || null,
    page: requirement.source_page || null,
    sha256: candidate.payload_sha256,
  };
}

export const hasExactOriginalFormProvenance = (requirement = {}, provenance = {}) => {
  const mapping=provenance?.originalFormMapping;
  return Boolean(mapping &&
    String(mapping.requirementId || "") === String(requirement.id || "") &&
    String(mapping.tenderId || "") === String(requirement.tender_id || "") &&
    String(mapping.companyId || "") === String(requirement.company_id || "") &&
    String(mapping.lotKey || "") === String(requirement.lot_key || ""));
};

export const safeOriginalFilename = (name, fallback = "Originalformular") => {
  const leaf = String(name || "").replaceAll("\\", "/").split("/").pop().replace(/[\r\n\0]/g, "").trim();
  return (leaf || fallback).slice(0, 180);
};
