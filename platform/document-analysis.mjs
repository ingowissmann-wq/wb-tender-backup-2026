import path from "node:path";
import { sha256 } from "./autopilot-core.mjs";

export const ALLOWED_TYPES = new Set(["application/pdf","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","text/csv","application/xml","text/xml","application/zip"]);
export function validateDocument(input, limits={maxBytes:50_000_000,maxArchiveBytes:250_000_000,maxEntries:2000}) {
  if (!ALLOWED_TYPES.has(input.mediaType)) throw new Error("document_type_forbidden");
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > limits.maxBytes) throw new Error("document_size_invalid");
  if (input.name.includes("\0") || path.isAbsolute(input.name) || input.name.split(/[\\/]/).includes("..")) throw new Error("path_traversal");
  if (input.archive) {
    if (input.archive.entries > limits.maxEntries || input.archive.uncompressedBytes > limits.maxArchiveBytes) throw new Error("zip_bomb");
    if ((input.archive.names || []).some((name) => path.isAbsolute(name) || name.split(/[\\/]/).includes(".."))) throw new Error("path_traversal");
    if ((input.archive.names || []).some((name) => /\.(exe|dll|com|bat|cmd|ps1|js|jar|msi|scr)$/i.test(name))) throw new Error("embedded_executable");
  }
  return {accepted:true,sha256:sha256(input.bytes || ""),scanRequired:true};
}

const patterns = [
  ["DEADLINE",/\b(?:abgabefrist|frist|abgabe|submission deadline)\b/iu],
  ["LOT",/\b(?:los|lot)\s*\d+/iu],["QUANTITY",/\b\d+(?:[.,]\d+)?\s*(?:m²|stunden|hours|stück)\b/iu],
  ["QUALIFICATION",/\b(?:qualifikation|sachkunde)\b/iu],
  ["CERTIFICATE",/\b(?:zertifikat|certificate)\b/iu],
  ["TARIFF",/\b(?:tarif|mindestlohn)\b/iu],
  ["SUPPLEMENT",/\b(?:zuschlag|nachtarbeit|sonntagsarbeit|feiertagsarbeit)\b/iu],
  ["PENALTY",/\b(?:vertragsstrafe|penalty)\b/iu],
  ["AWARD",/\b(?:zuschlagskriter\w*|award criterion|preisgewicht\w*)\b/iu],
];
export function extractRequirements(text, source={}) {
  const sections=String(text||"").split(/\n+/).filter(Boolean);
  return sections.flatMap((section,index)=>patterns.filter(([,rx])=>rx.test(section)).map(([type])=>({
    type,value:section,provenance:"RULE",page:source.page||null,section:source.section||String(index+1),confidence:0.8,
  })));
}
export function buildRequirementMatrix(findings) {
  return findings.map((finding,index)=>({
    id:`REQ-${String(index+1).padStart(4,"0")}`,category:finding.type,requirement:finding.value,
    mandatory:true,status:"OPEN",source:finding,evidenceStatus:"MISSING",
  }));
}
