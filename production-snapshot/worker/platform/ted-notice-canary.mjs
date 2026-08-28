import crypto from "node:crypto";

const text = value => String(value || "").trim();

export function verifyTedNoticeArtifact({content,contentType,status,externalId,lotKeys}) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content || "");
  const html = buffer.toString("utf8");
  const expectedLots = [...new Set((lotKeys || []).map(text).filter(Boolean))].sort();
  const errors = [];
  if (Number(status) !== 200) errors.push("HTTP_STATUS_INVALID");
  if (!/^text\/html(?:;|$)/i.test(text(contentType))) errors.push("MIME_TYPE_INVALID");
  if (buffer.length < 512 || buffer.length > 5 * 1024 * 1024) errors.push("SIZE_INVALID");
  if (!/^\s*<!doctype html/i.test(html) && !/<html[\s>]/i.test(html)) errors.push("HTML_MAGIC_INVALID");
  if (!text(externalId) || !html.includes(text(externalId))) errors.push("TENDER_ID_MISSING");
  const missingLots = expectedLots.filter(lotKey => !html.includes(lotKey));
  if (!expectedLots.length) errors.push("LOTS_REQUIRED");
  if (missingLots.length) errors.push("LOT_IDS_MISSING");
  return {
    valid: errors.length === 0,
    errors,
    missingLots,
    bytes: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    tenderIdPresent: Boolean(text(externalId) && html.includes(text(externalId))),
    lotCount: expectedLots.length,
  };
}
