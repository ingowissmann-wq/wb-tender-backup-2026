const number = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const cellValue = cell => number(cell?.result ?? cell?.displayed ?? cell?.value);

export function selectLotAuthoritativeDocuments(documents,selectedLotIds){
  if(selectedLotIds.size!==1)return documents;
  return documents.filter(document=>{
    if(selectedLotIds.has(document.lot_id))return true;
    const lotSensitive=/(?:raumbuch|leistungsverzeichnis|preisblatt|\blos\s*\d+|\blot\s*\d+)/i.test(document.filename||document.provenance?.archivePath||"");
    if(document.lot_id)return document.provenance?.lotBindingSource==="PARENT_DOCUMENT"&&!lotSensitive;
    if(document.provenance?.lotBindingSource==="EXPLICIT_PATH_CONFLICT")return false;
    return !lotSensitive;
  });
}

export function selectLotEnrichmentFields(fields,selectedLotId){
  if(!selectedLotId)return fields;
  return fields.filter(field=>{
    const parser=String(field.provenance?.parser||"");
    const fieldLotId=field.provenance?.selectedLotId||null;
    if(fieldLotId)return String(fieldLotId)===String(selectedLotId);
    return !/^(?:cleaning-room-book-v[12]|rib-security-lv-26E0128R|document-scope-materializer)$/.test(parser);
  });
}

const parseGermanDate = value => { const [day, month, year] = value.split(".").map(Number); return new Date(Date.UTC(year, month - 1, day)); };
const inclusiveMonths = (from,to) => (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth() + 1;

const contractPeriod = documents => {
  const pages = documents.flatMap(document => (document.extracted_data?.pages || []).map(page => ({document,page:page.pageNumber || null,text:String(page.text || "")})));
  for (const entry of pages) {
    const start = entry.text.match(/Vertragsbeginn\s*:\s*(\d{2}\.\d{2}\.\d{4})/i)?.[1];
    const end = entry.text.match(/Vertragsende\s*:\s*(\d{2}\.\d{2}\.\d{4})/i)?.[1];
    if (!start || !end) continue;
    const from = parseGermanDate(start), to = parseGermanDate(end);
    const months = inclusiveMonths(from,to);
    if (months > 0) return {months,start,end,evidence:{documentId:entry.document.id,filename:entry.document.filename,hash:entry.document.payload_sha256,page:entry.page,match:`Vertragsbeginn ${start}; Vertragsende ${end}`}};
  }
  return null;
};

export function deriveCleaningContractFacts(documents = [], selectedLotKey = null) {
  const lotNumber=Number(String(selectedLotKey||"").match(/(?:LOT-0*|LOS\s*)(\d+)/i)?.[1]);
  if(!lotNumber)return [];
  for(const document of documents.filter(item=>item?.procurement_verification_status==="VERIFIED"))for(const page of document.extracted_data?.pages||[]){
    const text=String(page.text||"").replace(/\s+/g," ");
    if(!/Vertragsdauer und Kündigung/i.test(text))continue;
    const groupPattern=/hinsichtlich des\s+Los(?:es)?\s+(\d+)(?:\s+und\s+(\d+))?/gi,matches=[...text.matchAll(groupPattern)];
    const selectedSegments=matches.map((match,index)=>({group:[Number(match[1]),Number(match[2])].filter(Number.isFinite),segment:text.slice(match.index,matches[index+1]?.index??text.length)})).filter(entry=>entry.group.includes(lotNumber));
    const startEntry=selectedSegments.find(entry=>/nicht vor dem\s+\d{2}\.\d{2}\.\d{4}/i.test(entry.segment)),
      startText=startEntry?.segment.match(/nicht vor dem\s+(\d{2}\.\d{2}\.\d{4})/i)?.[1],
      endEntries=selectedSegments.map(entry=>({...entry,endTexts:[...entry.segment.matchAll(/(?:mit\s+)?Ablauf des\s+(\d{2}\.\d{2}\.\d{4})/gi)].map(match=>match[1])})).filter(entry=>entry.endTexts.length),
      endTexts=[...new Set(endEntries.flatMap(entry=>entry.endTexts))];
    if(startText&&endTexts.length){
      const start=parseGermanDate(startText),ends=endTexts.map(value=>({value,date:parseGermanDate(value)})).filter(item=>item.date>=start),overall=ends.sort((a,b)=>b.date-a.date)[0];
      if(!overall)continue;
      const group=startEntry.group,evidence={documentId:document.id,filename:document.filename,hash:document.payload_sha256,page:page.pageNumber||null,lotNumbers:group,start:startText,endDates:endTexts,match:[startEntry,...endEntries].map(entry=>entry.segment).join(" ").slice(0,900)};
      return [
        {key:"contract_duration_months",value:inclusiveMonths(start,overall.date),unit:"Monate",formula:"Kalendermonate einschließlich frühestem Leistungsbeginn und spätestem losbezogenen Vertragsende",evidence:[evidence]},
        {key:"contract_periods",value:endTexts.map(end=>({start:startText,end})),unit:"Zeiträume",formula:"Losbezogene Haupt- und Teilobjektzeiträume aus § 3 Vertragsdauer",evidence:[evidence]},
      ];
    }
  }
  return [];
}

export function deriveCleaningRoomBookFacts(documents = [], selectedLotKey = null) {
  const verified = documents.filter(document => document?.procurement_verification_status === "VERIFIED");
  const rows = [];
  for (const document of verified.filter(document => /Raumbuch.*\.xlsx$/i.test(document.filename || ""))) for (const sheet of document.extracted_data?.worksheets || []) {
    if (!/Raumbuch\s+UR/i.test(sheet.name || "")) continue;
    for (const row of sheet.rows || []) {
      const cells = new Map((row.cells || []).map(cell => [cell.column, cell]));
      const annualHours = cellValue(cells.get(10)), area = cellValue(cells.get(8));
      if (annualHours === null || annualHours <= 0) continue;
      rows.push({annualHours,area:area && area > 0 ? area : 0,evidence:{documentId:document.id,filename:document.filename,hash:document.payload_sha256,table:sheet.name,cell:cells.get(10)?.address,row:row.rowNumber}});
    }
  }
  if (!rows.length) return deriveCleaningContractFacts(verified,selectedLotKey);
  const annualHours = rows.reduce((sum, row) => sum + row.annualHours, 0), areas = rows.reduce((sum, row) => sum + row.area, 0), period = contractPeriod(verified);
  const facts = [
    {key:"areas",value:Number(areas.toFixed(4)),unit:"m²",formula:"Summe Grundfläche (Spalte H) aller Raumbuchzeilen mit positiven Jahresstunden in Spalte J",evidence:rows.map(row=>row.evidence)},
    {key:"productive_hours_per_year",value:Number(annualHours.toFixed(6)),unit:"h/Jahr",formula:"Summe der vom Auftraggeber berechneten Excel-Cachewerte in Spalte J (h/Jahr)",evidence:rows.map(row=>row.evidence)},
  ];
  if (period) {
    facts.push({key:"contract_duration_months",value:period.months,unit:"Monate",formula:"Kalendermonate einschließlich Vertragsbeginn und Vertragsende",evidence:[period.evidence]});
    facts.push({key:"productive_hours",value:Number((annualHours * period.months / 12).toFixed(6)),unit:"h",formula:`Jahresstunden × ${period.months} Vertragsmonate ÷ 12`,evidence:[...rows.map(row=>row.evidence),period.evidence]});
  }
  return [...facts,...deriveCleaningContractFacts(verified,selectedLotKey).filter(fact=>!facts.some(existing=>existing.key===fact.key))];
}
