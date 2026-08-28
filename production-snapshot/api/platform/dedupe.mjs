const norm = (value) => String(value || "").trim().toLocaleLowerCase("de-DE");
export function duplicateDecision(a,b) {
  for (const key of ["tedId","noticeNumber","procurementNumber"]) {
    if (a[key] && b[key] && norm(a[key]) === norm(b[key])) return { kind:"exact", reason:key };
  }
  if (a.sourceUrl && b.sourceUrl && norm(a.sourceUrl) === norm(b.sourceUrl))
    return { kind:"exact", reason:"sourceUrl" };
  const evidence = ["buyer","title","publicationDate","offerDeadline","cpvCode"]
    .filter((key) => a[key] && b[key] && norm(a[key]) === norm(b[key]));
  return evidence.length >= 4
    ? { kind:"possible", reason:evidence.join(",") }
    : { kind:"none", reason:"insufficient_evidence" };
}

export function assertProductionRecord(record) {
  const marker = JSON.stringify(record).toLowerCase();
  if (/(synthetic|replay|fixture|example|test-only|k21-t)/.test(marker))
    throw new Error("test_data_rejected");
  if (!record.source || !record.externalId || !record.sourceUrl) throw new Error("source_provenance_required");
}
