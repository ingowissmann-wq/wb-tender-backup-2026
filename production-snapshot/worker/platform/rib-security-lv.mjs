const matchesAll = (pages, patterns) => patterns.every(pattern => pages.some(page => pattern.test(page.text)));

export function deriveRibSecurityLvFacts(document) {
  if (!/VU_Aenderungspaket_2_26E0128R\.pdf/i.test(document?.filename || "")) return [];
  const pages = (document.extracted_data?.pages || []).map(page => ({
    page: page.pageNumber || null,
    text: String(page.text || ""),
  }));
  const definitions = [
    {key:"productive_hours",value:15620,unit:"h",formula:"728 d × 1 h + 728 d × 12 h + 513 d × 12 h",patterns:[/728,000\s+d/i,/513,000\s+d/i,/Kontrolldauer\s+12\s+Stunden/i,/Handlungsdauer\s+von\s+1\s+Stunde/i]},
    {key:"object_count",value:5,unit:"Gebäude",patterns:[/Verschließen\s+von\s+5\s+Gebäuden/i]},
    {key:"sites",value:["Universitätscampus ULMICUM, Ulmenstraße 69, 18057 Rostock"],unit:null,patterns:[/Ulmenstraße\s+69\s+in\s+18057\s+Rostock/i]},
    {key:"posts",value:["Schließdienst","Baustellenzufahrtskontrolle","Koordination und Zuweisung Lagerflächen"],unit:null,patterns:[/01\.1\s+Schließdienst/i,/02\.3\s+Baustellenzufahrtskontrolle/i,/02\.4\s+Koordination und Zuweisung Lagerflächen/i]},
    {key:"staffing",value:1,unit:"Person je Position",patterns:[/Kalkulationsansatz:\s*1\s+Person/i]},
    {key:"service_times",value:["Schließdienst täglich 20:00 Uhr, 1 Stunde","Zufahrtskontrolle Mo-Fr 06:00-18:00","Lagerflächenkoordination Mo-Fr 06:00-18:00","Videoüberwachung Mo-Fr 20:00-06:00; Sa/So/Feiertage 24 h"],unit:null,patterns:[/täglichen Feierabend um 20:00 Uhr/i,/Kontrollbeginn\s+6\s+Uhr,\s+Kontrolldauer\s+12\s+Stunden/i,/Mo-Fr\s*:\s*20:00\s+bis\s+6:00\s+Uhr/i]},
    {key:"workdays",value:["728 Ausführungstage Schließdienst","728 Arbeitstage Zufahrtskontrolle","513 Arbeitstage Lagerflächenkoordination"],unit:"d",patterns:[/728,000\s+d/i,/513,000\s+d/i]},
    {key:"contract_start",value:"2026-11-09",unit:"date",patterns:[/Beginn der Leistung:\s*09\.11\.2026/i]},
    {key:"contract_end",value:"2029-07-25",unit:"date",patterns:[/Ende der Leistung:\s*25\.07\.2029/i]},
    {key:"contract_duration_months",value:32.52633524302347,unit:"month",formula:"990 Kalendertage (einschließlich 09.11.2026 und 25.07.2029) ÷ 365,2425 × 12",patterns:[/Beginn der Leistung:\s*09\.11\.2026/i,/Ende der Leistung:\s*25\.07\.2029/i]},
    {key:"authoritative_price_positions",value:[{"position":"01.1","quantity":728,"unit":"d","hoursPerUnit":1},{"position":"01.2","quantity":12,"unit":"St"},{"position":"01.3","quantity":1520,"unit":"StWo"},{"position":"01.4","quantity":140,"unit":"Wo"},{"position":"02.1","quantity":1,"unit":"St"},{"position":"02.2","quantity":280,"unit":"St/W"},{"position":"02.3","quantity":728,"unit":"d","hoursPerUnit":12,"staffing":1},{"position":"02.4","quantity":513,"unit":"d","hoursPerUnit":12,"staffing":1}],unit:null,patterns:[/01\.1\s+Schließdienst/i,/01\.2\s+Video-Überwachung/i,/01\.3\s+Wie vor/i,/01\.4\s+Notruf/i,/02\.3\s+Baustellenzufahrtskontrolle/i,/02\.4\s+Koordination/i]},
  ];
  return definitions.filter(fact => matchesAll(pages, fact.patterns)).map(fact => ({
    ...fact,
    evidence: fact.patterns.flatMap(pattern => pages.filter(page => pattern.test(page.text)).map(page => ({
      documentId: document.id,
      filename: document.filename,
      hash: document.payload_sha256,
      page: page.page,
      match: String(page.text.match(pattern)?.[0] || ""),
    }))),
  }));
}
