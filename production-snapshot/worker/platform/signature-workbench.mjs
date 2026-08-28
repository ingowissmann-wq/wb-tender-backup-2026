import crypto from "node:crypto";

const sha256 = buffer => crypto.createHash("sha256").update(buffer).digest("hex");
const pdfMagic = buffer => Buffer.isBuffer(buffer) && buffer.length >= 5 && buffer.subarray(0,5).toString("ascii") === "%PDF-";
const unsafePdf = buffer => /\/(JavaScript|JS|Launch|EmbeddedFile)\b/i.test(buffer.toString("latin1"));

export function prepareSignatureCopy({content,filename}) {
  if (!pdfMagic(content)) throw new Error("signature_source_not_pdf");
  if (unsafePdf(content)) throw new Error("signature_source_contains_active_content");
  const hash=sha256(content);
  return {content:Buffer.from(content),sha256:hash,filename:`${String(filename||"Dokument").replace(/\.pdf$/i,"")}_SIGNATURKOPIE.pdf`,originalUnchanged:true};
}

export function inspectSignedPdf({content,sourceContent}) {
  const errors=[];
  if(!pdfMagic(content)) errors.push("Die Datei ist kein gültiges PDF.");
  if(content.length===0||content.length>30_000_000) errors.push("Die Dateigröße ist unzulässig.");
  if(unsafePdf(content)) errors.push("Aktive PDF-Inhalte sind nicht zulässig.");
  const sourcePages=(sourceContent?.toString("latin1").match(/\/Type\s*\/Page\b/g)||[]).length;
  const pages=(content.toString("latin1").match(/\/Type\s*\/Page\b/g)||[]).length;
  if(sourcePages&&pages&&sourcePages!==pages) errors.push("Die Seitenzahl weicht von der bereitgestellten Signaturkopie ab.");
  const cryptographicSignature=/\/ByteRange\s*\[[^\]]+\]/.test(content.toString("latin1"))&&/\/Contents\s*</.test(content.toString("latin1"));
  return {sha256:sha256(content),detectedMediaType:"application/pdf",errors,cryptographicSignature,pageCount:pages,sourcePageCount:sourcePages,malwareScanStatus:"NOT_AVAILABLE",status:errors.length?"SIGNATURE_REJECTED_WITH_REASON":"MANUAL_REVIEW_REQUIRED"};
}
