const number = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const cellValue = cell => number(cell?.result ?? cell?.displayed ?? cell?.value);

export function selectLotAuthoritativeDocuments(documents,selectedLotIds){
  if(selectedLotIds.size!==1)return documents;
  return documents.filter(document=>{
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
