const number = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const cellValue = cell => number(cell?.result ?? cell?.displayed ?? cell?.value);

const lotNumberFromKey = value => {
  const match = String(value || "").match(/(?:LOT-0*|LOS\s*0*)(\d+)/i);
  return match ? Number(match[1]) : null;
};

const explicitLotNumbers = value => [
  ...String(value || "").matchAll(/(?:^|[^A-Za-z0-9])(?:los|lot)[\s_-]*0*(\d+)\b/gi),
].map(match => Number(match[1])).filter(Number.isFinite);

const workbookLotNumbers = document => {
  const numbers = [];
  for (const sheet of document?.extracted_data?.worksheets || [])
    for (const row of (sheet.rows || []).filter(row => Number(row.rowNumber) <= 12))
      for (const cell of row.cells || [])
        numbers.push(...explicitLotNumbers(cell?.displayed ?? cell?.result ?? cell?.value));
  return numbers;
};

export function declaredDocumentLotNumbers(document) {
  return [...new Set([
    ...explicitLotNumbers(document?.filename),
    ...explicitLotNumbers(document?.provenance?.archivePath),
    ...workbookLotNumbers(document),
  ])].sort((left, right) => left - right);
}

const explicitlyConflictsWithSelectedLot = (document, selectedLotKey) => {
  const selectedLotNumber = lotNumberFromKey(selectedLotKey);
  if (selectedLotNumber === null) return false;
  const declared = declaredDocumentLotNumbers(document);
  return declared.length > 0 &&
    (declared.length !== 1 || declared[0] !== selectedLotNumber);
};

const explicitlyMatchesSelectedLot = (document, selectedLotKey) => {
  const selectedLotNumber = lotNumberFromKey(selectedLotKey);
  if (selectedLotNumber === null) return false;
  const declared = declaredDocumentLotNumbers(document);
  return declared.length === 1 && declared[0] === selectedLotNumber;
};

export function selectLotAuthoritativeDocuments(documents,selectedLotIds,selectedLotKey=null){
  if(selectedLotIds.size!==1)return documents;
  return documents.filter(document=>{
    if(explicitlyConflictsWithSelectedLot(document,selectedLotKey))return false;
    if(explicitlyMatchesSelectedLot(document,selectedLotKey))return true;
    if(selectedLotIds.has(document.lot_id))return true;

    const tenderVerified =
        document.tender_association_verified === true,
      lotVerified =
        document.lot_association_verified === true,
      procurementVerified =
        document.procurement_verification_status === "VERIFIED";

    if (
      tenderVerified &&
      lotVerified &&
      procurementVerified
    )
      return true;

    const lotSensitive=/(?:raumbuch|raumaufma(?:ß|ss)|aufma(?:ß|ss)|leistungsverzeichnis|preisblatt|\blos\s*\d+|\blot\s*\d+)/i.test(document.filename||document.provenance?.archivePath||"");

    if(document.lot_id)
      return document.provenance?.lotBindingSource==="PARENT_DOCUMENT"&&!lotSensitive;

    if(document.provenance?.lotBindingSource==="EXPLICIT_PATH_CONFLICT")
      return false;

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

const explicitSingleLotContractPeriod = documents => {
  const candidates = [];
  const periodPattern =
    /(?:Rahmenvereinbarung|Vertrag|Leistungs(?:beziehung|zeitraum))[\s\S]{0,100}?beginnt(?:\s+voraussichtlich)?\s+am\s+(\d{2}\.\d{2}\.\d{4})[\s\S]{0,180}?endet(?:\s+voraussichtlich)?\s+am\s+(\d{2}\.\d{2}\.\d{4})/gi;

  for (const document of documents.filter(
    item => item?.procurement_verification_status === "VERIFIED",
  ))
    for (const page of document.extracted_data?.pages || []) {
      const text = String(page.text || "").replace(/\s+/g, " ");
      periodPattern.lastIndex = 0;

      for (const match of text.matchAll(periodPattern)) {
        const start = parseGermanDate(match[1]);
        const end = parseGermanDate(match[2]);
        if (end < start) continue;

        const months = inclusiveMonths(start, end);
        const context = text.slice(
          match.index,
          Math.min(text.length, match.index + match[0].length + 260),
        );
        const explicitMonths = Number(
          context.match(
            /Vertragslaufzeit\s+beträgt[^\d]{0,40}(\d{1,3})\s+Monate/i,
          )?.[1],
        );

        if (
          !Number.isInteger(months) ||
          months <= 0 ||
          months > 240 ||
          !Number.isInteger(explicitMonths) ||
          explicitMonths !== months
        ) continue;

        candidates.push({
          months,
          start: match[1],
          end: match[2],
          evidence: {
            documentId: document.id,
            filename: document.filename,
            hash: document.payload_sha256,
            page: page.pageNumber || null,
            match: context.slice(0, 700),
            explicitMonths,
          },
        });
      }
    }

  const identities = new Set(
    candidates.map(item => `${item.start}|${item.end}|${item.months}`),
  );
  if (identities.size !== 1) return null;

  const selected = candidates[0];
  return {
    months: selected.months,
    start: selected.start,
    end: selected.end,
    evidence: candidates.map(item => item.evidence),
  };
};

const explicitInitialContractPeriod = documents => {
  const candidates = [];
  const pattern = /Vertrag\s+beginnt\s+am\s+(\d{2}\.\d{2}\.\d{4})\s+und\s+endet\s+am\s+(\d{2}\.\d{2}\.\d{4})/gi;

  for (const document of documents.filter(
    item => item?.procurement_verification_status === "VERIFIED",
  ))
    for (const page of document.extracted_data?.pages || []) {
      const text = String(page.text || "").replace(/\s+/g, " ");
      for (const match of text.matchAll(pattern)) {
        const start = parseGermanDate(match[1]);
        const end = parseGermanDate(match[2]);
        if (end < start) continue;
        const maximumEnd = text.match(
          /endet\s+spätestens\s+mit\s+Ablauf\s+des\s+(\d{2}\.\d{2}\.\d{4})/i,
        )?.[1] ?? null;
        candidates.push({
          start: match[1],
          end: match[2],
          months: inclusiveMonths(start, end),
          maximumEnd,
          maximumMonths: maximumEnd
            ? inclusiveMonths(start, parseGermanDate(maximumEnd))
            : null,
          evidence: {
            documentId: document.id,
            filename: document.filename,
            hash: document.payload_sha256,
            page: page.pageNumber || null,
            match: text.slice(match.index, Math.min(text.length, match.index + 650)),
          },
        });
      }
    }

  const identities = new Set(
    candidates.map(item => `${item.start}|${item.end}|${item.months}|${item.maximumEnd ?? ""}`),
  );
  return identities.size === 1 ? candidates[0] : null;
};

export function deriveCleaningContractFacts(documents = [], selectedLotKey = null) {
  const lotNumber=lotNumberFromKey(selectedLotKey);
  if(lotNumber===null)return [];
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
  const initialPeriod=explicitInitialContractPeriod(documents);
  if(initialPeriod){
    const facts=[
      {key:"contract_duration_months",value:initialPeriod.months,unit:"Monate",formula:"Einschließlich gezählte Kalendermonate zwischen eindeutigem Vertragsbeginn und regulärem Vertragsende",evidence:[initialPeriod.evidence]},
      {key:"contract_periods",value:[{start:initialPeriod.start,end:initialPeriod.end}],unit:"Zeiträume",formula:"Verifizierte Grundlaufzeit ohne optionale Verlängerungen",evidence:[initialPeriod.evidence]},
    ];
    if(initialPeriod.maximumEnd&&initialPeriod.maximumMonths)
      facts.push({key:"contract_maximum_duration_months",value:initialPeriod.maximumMonths,unit:"Monate",formula:"Maximale Laufzeit einschließlich sämtlicher vertraglicher Verlängerungsoptionen",evidence:[initialPeriod.evidence]});
    return facts;
  }
  if(lotNumber===0){
    const period=explicitSingleLotContractPeriod(documents);
    if(period)return [
      {key:"contract_duration_months",value:period.months,unit:"Monate",formula:"Eindeutige verifizierte Vertragsdaten; explizite Monatsangabe entspricht den einschließlich gezählten Kalendermonaten",evidence:period.evidence},
      {key:"contract_periods",value:[{start:period.start,end:period.end}],unit:"Zeiträume",formula:"Verifizierter Beginn und verifiziertes Ende der ausdrücklich bezifferten Vertragslaufzeit",evidence:period.evidence},
    ];
  }
  return [];
}

function deriveLegacyCleaningRoomBookFacts(documents = [], selectedLotKey = null) {
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


const cleaningNumber = value => {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : null;

  const text = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s/g, "");

  if (!text) return null;

  const normalized = text.includes(",")
    ? text.replaceAll(".", "").replace(",", ".")
    : text;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const cleaningCellValue = cell =>
  cell?.result ??
  cell?.displayed ??
  cell?.value ??
  null;

const cleaningColumnNumber = cell => {
  const address =
    String(cell?.address || "")
      .trim()
      .toUpperCase(),
    letters =
      address.match(/^([A-Z]+)/)?.[1];

  if (letters) {
    let number = 0;

    for (const letter of letters)
      number =
        number * 26 +
        letter.charCodeAt(0) -
        64;

    return number;
  }

  const fallback = Number(cell?.column);

  return Number.isInteger(fallback) &&
    fallback > 0
    ? fallback
    : null;
};

const workbookRevision = filename => {
  const revisions = [...String(filename || "").matchAll(/\b(20\d{6})\b/g)]
    .map(match => Number(match[1]))
    .filter(Number.isFinite);
  return revisions.length ? Math.max(...revisions) : 0;
};

export const priceSheetForSelectedLot = (documents, selectedLotKey) => {
  const selectedLotNumber = lotNumberFromKey(selectedLotKey);
  if (selectedLotNumber === null) return null;
  const candidates = documents.filter(document => {
    if (document?.procurement_verification_status !== "VERIFIED") return false;
    if (!/preisblatt/i.test(document.filename || "")) return false;
    if (!/\.(?:xlsx|ods)(?:\.ods)?$/i.test(document.filename || "")) return false;
    const filenameLots = explicitLotNumbers(document.filename);
    const workbookLots = workbookLotNumbers(document);
    return filenameLots.length === 1 && filenameLots[0] === selectedLotNumber &&
      workbookLots.length > 0 && workbookLots.every(number => number === selectedLotNumber);
  });
  if (!candidates.length) return null;
  const highestRevision = Math.max(...candidates.map(document => workbookRevision(document.filename)));
  const preferred = candidates.filter(document => workbookRevision(document.filename) === highestRevision);
  const uniqueHashes = new Set(preferred.map(document => document.payload_sha256).filter(Boolean));
  return preferred.length === 1 && uniqueHashes.size === 1 ? preferred[0] : null;
};

export function derivePriceSheetCleaningFacts(documents = [], selectedLotKey = null) {
  const document = priceSheetForSelectedLot(documents, selectedLotKey);
  if (!document) return [];
  const sheet = (document.extracted_data?.worksheets || []).find(item =>
    /(?:aufma(?:ß|ss)|flächenverzeichnis)/i.test(item.name || "") &&
    !/(?:glas|fenster)/i.test(item.name || "")
  );
  if (!sheet) return [];
  const rows = sheet.rows || [];
  const normalized = value => String(value ?? "").normalize("NFKC").trim().toLowerCase();
  const header = rows.find(row => {
    const labels = (row.cells || []).map(cell => normalized(cleaningCellValue(cell)));
    return labels.includes("fläche in m2") && labels.includes("tage/jahr") &&
      labels.includes("fläche in m2 pro jahr");
  });
  if (!header) return [];
  const headerColumns = new Map(
    (header.cells || []).map(cell => [normalized(cleaningCellValue(cell)), cleaningColumnNumber(cell)]),
  );
  const areaColumn = headerColumns.get("fläche in m2"),
    daysColumn = headerColumns.get("tage/jahr"),
    annualColumn = headerColumns.get("fläche in m2 pro jahr"),
    groupColumn = headerColumns.get("reinigungsgruppe"),
    performanceColumn = headerColumns.get("m2/stunde"),
    hoursColumn = headerColumns.get("stunde/jahr");
  if (![areaColumn, daysColumn, annualColumn].every(Number.isInteger)) return [];
  const derivedRows = [];
  for (const row of rows) {
    if (Number(row.rowNumber) <= Number(header.rowNumber)) continue;
    const byColumn = new Map((row.cells || []).map(cell => [cleaningColumnNumber(cell), cell]));
    const areaCell = byColumn.get(areaColumn), daysCell = byColumn.get(daysColumn),
      annualCell = byColumn.get(annualColumn), area = cleaningNumber(cleaningCellValue(areaCell)),
      days = cleaningNumber(cleaningCellValue(daysCell)), annualArea = cleaningNumber(cleaningCellValue(annualCell));
    if (![area, days, annualArea].every(value => Number.isFinite(value) && value > 0)) continue;
    const formula = String(annualCell?.formula || "");
    if (!/Fläche in m²/i.test(formula) || !/Tage\/Jahr/i.test(formula)) continue;
    const expected = area * days, tolerance = Math.max(0.01, Math.abs(expected) * 1e-9);
    if (Math.abs(expected - annualArea) > tolerance) continue;
    const group = Number.isInteger(groupColumn)
      ? String(cleaningCellValue(byColumn.get(groupColumn)) ?? "").normalize("NFKC").trim().toUpperCase()
      : null;
    const performance = Number.isInteger(performanceColumn)
      ? cleaningNumber(cleaningCellValue(byColumn.get(performanceColumn)))
      : null;
    const annualHours = Number.isInteger(hoursColumn)
      ? cleaningNumber(cleaningCellValue(byColumn.get(hoursColumn)))
      : null;
    derivedRows.push({ rowNumber: Number(row.rowNumber), area, days, annualArea, group: group || null,
      performance: Number.isFinite(performance) && performance > 0 ? performance : null,
      annualHours: Number.isFinite(annualHours) && annualHours > 0 ? annualHours : null,
      areaCell: areaCell?.address, daysCell: daysCell?.address, annualCell: annualCell?.address });
  }
  if (!derivedRows.length) return [];
  const sourceArea = derivedRows.reduce((sum, row) => sum + row.area, 0),
    annualArea = derivedRows.reduce((sum, row) => sum + row.annualArea, 0),
    evidence = [{
      documentId: document.id,
      filename: document.filename,
      sha256: document.payload_sha256,
      selectedLotKey,
      declaredLotNumbers: declaredDocumentLotNumbers(document),
      worksheet: sheet.name,
      headerRow: header.rowNumber,
      columns: { area: areaColumn, daysPerYear: daysColumn, annualArea: annualColumn },
      includedRows: derivedRows.length,
      firstIncludedRow: Math.min(...derivedRows.map(row => row.rowNumber)),
      lastIncludedRow: Math.max(...derivedRows.map(row => row.rowNumber)),
      formula: "Fläche in m² × Tage/Jahr = Fläche in m² pro Jahr",
      cachedFormulaResultsVerified: true,
    }];
  const result = [
    { key: "annual_cleaning_area_occurrences", value: Number(annualArea.toFixed(6)), unit: "m²/Jahr",
      formula: "Summe der verifizierten Excel-Cachewerte Fläche in m² × Tage/Jahr", evidence },
    { key: "areas", value: Number(sourceArea.toFixed(4)), unit: "m²",
      formula: "Summe der Grundflächen aller Zeilen mit positiver Jahresreinigungsfläche", evidence },
  ];
  if (Number.isInteger(groupColumn)) {
    const grouped = new Map();
    for (const row of derivedRows) {
      const key = row.group || "UNASSIGNED";
      const current = grouped.get(key) || { group: key, sourceArea: 0, annualCleaningArea: 0, rows: 0 };
      current.sourceArea += row.area;
      current.annualCleaningArea += row.annualArea;
      current.rows += 1;
      grouped.set(key, current);
    }
    result.push({
      key: "annual_cleaning_area_by_group",
      value: [...grouped.values()].sort((left, right) => left.group.localeCompare(right.group)).map(item => ({
        group: item.group,
        sourceArea: Number(item.sourceArea.toFixed(4)),
        annualCleaningArea: Number(item.annualCleaningArea.toFixed(6)),
        rows: item.rows,
      })),
      unit: "m²/Jahr je Reinigungsgruppe",
      formula: "Gruppierte Summe der verifizierten Excel-Cachewerte Fläche in m² × Tage/Jahr",
      evidence: evidence.map(item => ({ ...item, columns: { ...item.columns, cleaningGroup: groupColumn } })),
    });
  }
  if (Number.isInteger(performanceColumn) || Number.isInteger(hoursColumn)) {
    const grouped = new Map();
    for (const row of derivedRows) {
      const key = row.group || "UNASSIGNED";
      const current = grouped.get(key) || {
        group: key,
        rows: 0,
        rowsWithPerformance: 0,
        rowsWithAnnualHours: 0,
        rowsWithConsistentPerformanceHours: 0,
        performanceValues: new Set(),
        annualHours: 0,
      };
      current.rows += 1;
      if (row.performance) {
        current.rowsWithPerformance += 1;
        current.performanceValues.add(row.performance);
      }
      if (row.annualHours) {
        current.rowsWithAnnualHours += 1;
        current.annualHours += row.annualHours;
      }
      if (row.performance && row.annualHours) {
        const expected = row.annualArea / row.performance;
        const tolerance = Math.max(0.01, Math.abs(expected) * 1e-6);
        if (Math.abs(expected - row.annualHours) <= tolerance)
          current.rowsWithConsistentPerformanceHours += 1;
      }
      grouped.set(key, current);
    }
    result.push({
      key: "price_sheet_productivity_inventory",
      value: [...grouped.values()].sort((left, right) => left.group.localeCompare(right.group)).map(item => ({
        group: item.group,
        rows: item.rows,
        rowsWithPerformance: item.rowsWithPerformance,
        rowsWithAnnualHours: item.rowsWithAnnualHours,
        rowsWithConsistentPerformanceHours: item.rowsWithConsistentPerformanceHours,
        performanceValues: [...item.performanceValues].sort((left, right) => left - right),
        annualHours: Number(item.annualHours.toFixed(6)),
      })),
      unit: "Read-only Preisblatt-Inventar",
      formula: "Inventar vorhandener Preisblattwerte; keine fehlenden Werte werden ergänzt",
      evidence: evidence.map(item => ({
        ...item,
        columns: {
          ...item.columns,
          cleaningGroup: groupColumn ?? null,
          performance: performanceColumn ?? null,
          annualHours: hoursColumn ?? null,
        },
      })),
    });
  }
  return result;
}

export function deriveCleaningRoomBookFacts(
  documents = [],
  selectedLotKey = null
) {
  const legacy =
    deriveLegacyCleaningRoomBookFacts(
      documents,
      selectedLotKey
    );

  if (
    legacy.some(
      fact =>
        fact.key === "productive_hours" ||
        fact.key === "productive_hours_per_year"
    )
  )
    return legacy;

  const priceSheet = derivePriceSheetCleaningFacts(documents, selectedLotKey);
  if (priceSheet.length)
    return [
      ...priceSheet,
      ...legacy.filter(fact => !priceSheet.some(existing => existing.key === fact.key)),
    ];

  const verified = documents.filter(
    document =>
      document?.procurement_verification_status ===
      "VERIFIED"
  );

  const evidence = [];

  for (
    const document of verified.filter(
      document =>
        /(?:raumbuch|raumaufma(?:ß|ss)|aufma(?:ß|ss))/i
          .test(document.filename || "") &&
        /\.(?:xlsx|ods)(?:\.ods)?$/i
          .test(document.filename || "")
    )
  )
    for (
      const sheet of
        document.extracted_data?.worksheets || []
    ) {
      const sheetName = String(sheet.name || "");

      if (
        !/pivot/i.test(sheetName) ||
        !/boden/i.test(sheetName) ||
        /glas|fenster/i.test(sheetName)
      )
        continue;

      const rows = sheet.rows || [];

      const header = rows.find(row => {
        const values =
          (row.cells || []).map(
            cleaningCellValue
          );

        return (
          values.some(
            value =>
              /^Gesamtergebnis$/i.test(
                String(value || "").trim()
              )
          ) &&
          values.some(value => {
            const parsed =
              cleaningNumber(value);

            return (
              parsed !== null &&
              parsed > 0
            );
          })
        );
      });

      const total = rows.find(row => {
        const first =
          [...(row.cells || [])]
            .sort(
              (left, right) =>
                left.column - right.column
            )[0];

        return /^Gesamtergebnis$/i.test(
          String(
            cleaningCellValue(first) ?? ""
          ).trim()
        );
      });

      if (!header || !total) continue;

      const frequencies =
        [...(header.cells || [])]
          .map(cell => ({
            column:
              cleaningColumnNumber(cell),
            value:
              cleaningNumber(
                cleaningCellValue(cell)
              ),
            address: cell.address
          }))
          .filter(
            entry =>
              entry.column !== null &&
              entry.value !== null &&
              entry.value > 0
          );

      const totalsByColumn =
        new Map(
          [...(total.cells || [])]
            .map(cell => ({
              column:
                cleaningColumnNumber(cell),
              value:
                cleaningNumber(
                  cleaningCellValue(cell)
                ),
              address: cell.address
            }))
            .filter(
              entry =>
                entry.column !== null &&
                entry.value !== null &&
                entry.value >= 0
            )
            .map(entry => [
              entry.column,
              entry
            ])
        );

      if (!frequencies.length)
        continue;

      for (const frequency of frequencies) {
        const area =
          totalsByColumn.get(
            frequency.column
          );

        if (!area)
          continue;

        const annualArea =
          frequency.value * area.value;

        if (
          !Number.isFinite(annualArea) ||
          annualArea <= 0
        )
          continue;

        evidence.push({
          annualArea,
          area: area.value,
          provenance: {
            documentId: document.id,
            filename: document.filename,
            sha256: document.payload_sha256,
            worksheet: sheetName,
            column:
              frequency.column,
            frequencyCell:
              frequency.address,
            areaCell:
              area.address,
            frequencyPerYear:
              frequency.value,
            areaSquareMetres:
              area.value,
            annualAreaSquareMetres:
              annualArea,
            formula:
              "Reinigungshäufigkeit pro Jahr × zugehörige Gesamtfläche derselben Excel-Spalte"
          }
        });
      }
    }

  const unique = [
    ...new Map(
      evidence.map(entry => [
        [
          entry.provenance.sha256,
          entry.provenance.worksheet,
          entry.provenance.frequencyCell,
          entry.provenance.areaCell
        ].join("|"),
        entry
      ])
    ).values()
  ];

  if (!unique.length) return legacy;

  const annualArea = unique.reduce(
      (sum, entry) =>
        sum + entry.annualArea,
      0
    ),
    sourceArea = unique.reduce(
      (sum, entry) =>
        sum + entry.area,
      0
    ),
    pivotFacts = [
      {
        key:
          "annual_cleaning_area_occurrences",
        value:
          Number(annualArea.toFixed(6)),
        unit: "m²/Jahr",
        formula:
          "Summe aus Reinigungshäufigkeit pro Jahr × zugehöriger Gesamtfläche",
        evidence:
          unique.map(
            entry => entry.provenance
          )
      },
      {
        key: "areas",
        value:
          Number(sourceArea.toFixed(4)),
        unit: "m²",
        formula:
          "Quellengebundene Flächen der ausgewerteten Häufigkeitsspalten",
        evidence:
          unique.map(
            entry => entry.provenance
          )
      }
    ];

  return [
    ...pivotFacts,
    ...legacy.filter(
      fact =>
        !pivotFacts.some(
          existing =>
            existing.key === fact.key
        )
    )
  ];
}
