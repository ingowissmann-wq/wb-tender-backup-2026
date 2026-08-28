import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import {extractArchiveDocuments,parseBinaryDocument} from "../platform/binary-parsers.mjs";
import {htmlLinks,inferArchiveLotNumber,resolveArchiveChildLotBinding,resolveSingleLotBinding} from "../platform/autopilot-pipeline-worker.mjs";
import {downloadPublicAIBietercockpitArchive,downloadPublicDuesseldorfNetServerArchive,downloadPublicNetServerArchive,downloadPublicEvergabeOnlineArchive} from "../platform/semantic-browser-auth.mjs";

test("ODS keeps hidden sheets, rows, values and formulas",async()=>{
  const zip=new JSZip();zip.file("mimetype","application/vnd.oasis.opendocument.spreadsheet");zip.file("content.xml",`<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet><table:table table:name="Hilfstabelle" table:display="false"><table:table-row table:visibility="collapse"><table:table-cell table:formula="of:=1+1"><text:p>2</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`);
  const buffer=await zip.generateAsync({type:"nodebuffer"}),parsed=await parseBinaryDocument({buffer,name:"preise.ods",mediaType:"application/vnd.oasis.opendocument.spreadsheet"});
  assert.equal(parsed.type,"ODS");assert.equal(parsed.worksheets[0].hidden,true);assert.equal(parsed.worksheets[0].rows[0].hidden,true);assert.equal(parsed.worksheets[0].rows[0].cells[0].formula,"of:=1+1");
});

test("GAEB XML materializes positions, quantities, units and prices",async()=>{
  const buffer=Buffer.from(`<?xml version="1.0"?><GAEB><BoQ><BoQBody><Item><RNoPart>01.001</RNoPart><Qty>12.5</Qty><QU>h</QU><BriefDescr>Winterdienst</BriefDescr><UP>42.00</UP></Item></BoQBody></BoQ></GAEB>`),parsed=await parseBinaryDocument({buffer,name:"leistungsverzeichnis.x83",mediaType:"application/xml"});
  assert.equal(parsed.type,"GAEB");assert.equal(parsed.gaeb.items[0].position,"01.001");assert.equal(parsed.gaeb.items[0].quantity,"12.5");assert.equal(parsed.gaeb.items[0].unit,"h");
});

test("official DWG plans and LOG attachments are retained with safe manual-review parsing",async()=>{
  const dwg=await parseBinaryDocument({buffer:Buffer.concat([Buffer.from("AC1032"),Buffer.alloc(32)]),name:"Werkplan.DWG",mediaType:"image/vnd.dwg"});
  assert.equal(dwg.type,"DWG");assert.equal(dwg.status,"VORHANDEN_MANUELL_ZU_PRÜFEN");assert.equal(dwg.formatVersion,"AC1032");
  const log=await parseBinaryDocument({buffer:Buffer.from("Prüfprotokoll\nStatus: ok\n"),name:"Pruefung.log",mediaType:"text/plain"});
  assert.equal(log.type,"LOG");assert.equal(log.status,"VORHANDEN_MANUELL_ZU_PRÜFEN");
});

test("archive extraction retains DWG plans and LOG evidence",async()=>{
  const zip=new JSZip();zip.file("Plan/anlage.dwg",Buffer.concat([Buffer.from("AC1032"),Buffer.alloc(8)]));zip.file("Plan/pruefung.log","ok");
  const children=await extractArchiveDocuments(await zip.generateAsync({type:"nodebuffer"}));
  assert.deepEqual(children.map(item=>[item.archivePath,item.mediaType]),[["Plan/anlage.dwg","image/vnd.dwg"],["Plan/pruefung.log","text/plain"]]);
});

test("ZIP recursively extracts supported procurement documents",async()=>{
  const nested=new JSZip();nested.file("lv.x83",`<?xml version="1.0"?><GAEB><BoQ><BoQBody><Item><RNoPart>01</RNoPart><Qty>1</Qty><QU>h</QU></Item></BoQBody></BoQ></GAEB>`);
  const outer=new JSZip();outer.file("docs/preise.csv","Position;Preis\n01;42");outer.file("docs/nested.zip",await nested.generateAsync({type:"nodebuffer"}));
  const children=await extractArchiveDocuments(await outer.generateAsync({type:"nodebuffer"}));
  assert.deepEqual(children.map(item=>item.archivePath).sort(),["docs/nested.zip/lv.x83","docs/preise.csv"]);
  assert.equal(children[0].buffer.length>0,true);
});

test("ZIP extracts Windows-style portal entry paths",async()=>{
  const zip=new JSZip();zip.file("Unterlagen\\Weitere Dokumente\\Kalkulation.xlsx",Buffer.from("PK\u0003\u0004"));
  const children=await extractArchiveDocuments(await zip.generateAsync({type:"nodebuffer"}));
  assert.equal(children.length,1);assert.equal(children[0].archivePath,"Unterlagen/Weitere Dokumente/Kalkulation.xlsx");
});

test("archive children inherit the only selected production lot",()=>{
  assert.deepEqual(resolveSingleLotBinding(null,[{lotKey:"LOT-0001",lot:{id:"lot-uuid"}}]),{lotId:"lot-uuid",lotKey:"LOT-0001",source:"SINGLE_SELECTED_LOT"});
  assert.deepEqual(resolveSingleLotBinding(null,[{lot:{id:"a"}},{lot:{id:"b"}}]),{lotId:null,lotKey:null,source:"UNRESOLVED"});
  assert.deepEqual(resolveSingleLotBinding("bound",[{lot:{id:"other"}}]),{lotId:"bound",lotKey:null,source:"PARENT_DOCUMENT"});
});

test("archive lot paths cannot be bound to a conflicting selected lot",()=>{
  const selected=[{lotKey:"LOT-0001",lot:{id:"lot-1"}}];
  assert.deepEqual(resolveArchiveChildLotBinding("Vergabeunterlagen/Los 1/L1_Preisblatt.xlsx",null,selected),{lotId:"lot-1",lotKey:"LOT-0001",source:"EXPLICIT_PATH_MATCHED_SELECTED_LOT"});
  assert.deepEqual(resolveArchiveChildLotBinding("Vergabeunterlagen/Los 2/L2_Preisblatt.xlsx",null,selected),{lotId:null,lotKey:null,source:"EXPLICIT_PATH_CONFLICT"});
  assert.deepEqual(resolveArchiveChildLotBinding("Vergabeunterlagen/Los 2/L2_Preisblatt.xlsx","inherited-lot-1",selected),{lotId:null,lotKey:null,source:"EXPLICIT_PATH_CONFLICT"});
  assert.equal(resolveArchiveChildLotBinding("Vergabeunterlagen/allgemein.pdf",null,selected).lotId,"lot-1");
});

test("unnumbered room books inherit only a unique object-specific lot anchor",()=>{
  const paths=["leistungsbeschreibungen/Los 1 Objektdatenblatt_Gebaeudereinigung_NP_VWG Neustädter Str. 13.pdf","leistungsbeschreibungen/Los 2 Objektdatenblatt_Gebaeudereinigung_NP_VWG Heinrich-Rau-Str. 27-30.pdf","leistungsbeschreibungen/Los 6 Objektdatenblatt_Gebaeudereinigung_WB Friedensstr. 6.pdf","leistungsbeschreibungen/Los 7 Objektdatenblatt_Gebaeudereinigung_NP Virchowstr. 14-16.pdf","leistungsbeschreibungen/Los 9 Objektdatenblatt_Gebaeudereinigung_NP Neustädter Str. 14.pdf"];
  assert.equal(inferArchiveLotNumber("leistungsbeschreibungen/Raumbuch_NP_Neustädter Str. 13_fin.xlsx",paths),"1");
  assert.equal(inferArchiveLotNumber("leistungsbeschreibungen/Raumbuch_NP_Heinrich-Rau-Str. 27-30_fin.xlsx",paths),"2");
  assert.equal(inferArchiveLotNumber("leistungsbeschreibungen/Raumbuch_WB_Friedensstr. 6_fin.xlsx",paths),"6");
  assert.equal(inferArchiveLotNumber("leistungsbeschreibungen/Raumbuch_NP_Virchowstr. 14-16_fin.xlsx",paths),"7");
  assert.equal(inferArchiveLotNumber("leistungsbeschreibungen/Raumbuch_NP_Neustädter Str. 14_fin.xlsx",paths),"9");
  assert.equal(inferArchiveLotNumber("leistungsbeschreibungen/Preisblatt Unterhaltsreinigung.xlsx",paths),null);
  assert.equal(inferArchiveLotNumber("leistungsbeschreibungen/Raumbuch_KY_Pritzwalker Str. 42_fin.xlsx",[
    ...paths,
    "leistungsbeschreibungen/Los 3 Objektdatenblatt_Gebaeudereinigung_KY_Pritzwalker Str. 42.pdf",
    "leistungsbeschreibungen/Los 3 Objektdatenblatt_Gebaeudereinigung_KY_Pritzwalker Str. 42.pdf",
  ]),"3");
});

test("XLSX preserves hidden structures, names, validations and comments",async()=>{
  const zip=new JSZip();
  zip.file("[Content_Types].xml",`<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`);
  zip.file("xl/workbook.xml",`<workbook><sheets><sheet name="Hilfsblatt" state="veryHidden" r:id="rId1"/></sheets><definedNames><definedName name="Tarif">Hilfsblatt!$A$1</definedName></definedNames></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels",`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`);
  zip.file("xl/worksheets/sheet1.xml",`<worksheet><cols><col min="2" max="3" hidden="1"/></cols><sheetData><row r="1" hidden="1"><c r="A1"><f>1+1</f><v>2</v></c></row></sheetData><dataValidations><dataValidation type="decimal" sqref="A1"><formula1>0</formula1><formula2>100</formula2></dataValidation></dataValidations></worksheet>`);
  const parsed=await parseBinaryDocument({buffer:await zip.generateAsync({type:"nodebuffer"}),name:"kalkulation.xlsx",mediaType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
  assert.equal(parsed.worksheets[0].hidden,true);assert.equal(parsed.worksheets[0].rows[0].hidden,true);assert.deepEqual(parsed.worksheets[0].hiddenColumns,[{min:2,max:3}]);assert.equal(parsed.worksheets[0].dataValidations[0].range,"A1");assert.equal(parsed.definedNames[0].name,"Tarif");assert.equal(parsed.worksheets[0].rows[0].cells[0].result,"2");
});

test("RIB public detail resolver follows only bound partner download paths",()=>{
  const html=Buffer.from(`<script>var rows=[{"value":"<a href=\\"https:\\/\\/my.vergabe.bayern.de\\/remote\\/download.php?k=abc123\\">LV.pdf</a>"},{"value":"<a href=\\"https:\\/\\/evil.example\\/remote\\/download.php?k=abc123\\">evil</a>"}]</script>`);
  const result=htmlLinks(html,"https://www.meinauftrag.rib.de/public/publications/604487");
  assert.deepEqual(result.links,["https://my.vergabe.bayern.de/remote/download.php?k=abc123"]);
});

test("public procurement archive wins over an unrelated login widget",()=>{
  const result=htmlLinks(Buffer.from(`<input type="password"><a href="/VMPSatellite/public/company/project/CXP/documents/archive/Vergabeunterlagen.zip">ZIP</a>`),"https://vergabemarktplatz.brandenburg.de/VMPSatellite/notice/CXP/documents");
  assert.equal(result.protected,false);assert.deepEqual(result.links,["https://vergabemarktplatz.brandenburg.de/VMPSatellite/public/company/project/CXP/documents/archive/Vergabeunterlagen.zip"]);
});

test("Cosinex session path parameters are removed before document persistence",()=>{
  const result=htmlLinks(Buffer.from(`<a href="./documents/archive/Vergabeunterlagen_CXP.zip;jsessionid=sensitive-session-value">ZIP</a>`),"https://vergabemarktplatz.brandenburg.de/VMPSatellite/public/company/project/CXP/de/documents");
  assert.deepEqual(result.links,["https://vergabemarktplatz.brandenburg.de/VMPSatellite/public/company/project/CXP/de/documents/archive/Vergabeunterlagen_CXP.zip"]);assert.equal(JSON.stringify(result).includes("sensitive-session-value"),false);
});

test("AUMASS public all-files archives are recognized only on the exact bound route",()=>{
  const html=Buffer.from(`<a href="/Document/GetDocument?doctype=allfiles&aumassid=AV269774-EU">Ohne Registrierung herunterladen.</a><a href="https://evil.example/Document/GetDocument?doctype=allfiles&aumassid=AV269774-EU">evil</a>`);
  const result=htmlLinks(html,"https://plattform.aumass.de/Publication/TenderPreview?id=fixture");
  assert.deepEqual(result.links,["https://plattform.aumass.de/Document/GetDocument?doctype=allfiles&aumassid=AV269774-EU"]);
});

test("eVergabe Online browser download rejects unbound targets before navigation",async()=>{
  await assert.rejects(()=>downloadPublicEvergabeOnlineArchive("https://evil.example/tenderdocuments.html?id=872681"),/evergabe_online_target_forbidden/);
  await assert.rejects(()=>downloadPublicEvergabeOnlineArchive("https://www.evergabe-online.de/tenderdocuments.html?id=not-a-number"),/evergabe_online_target_forbidden/);
});

test("Düsseldorf NetServer browser download rejects unbound targets before navigation",async()=>{
  await assert.rejects(()=>downloadPublicDuesseldorfNetServerArchive("https://evil.example/NetServer/TenderingProcedureDetails?function=_Details&TenderOID=54321-Tender-abc"),/netserver_target_forbidden/);
  await assert.rejects(()=>downloadPublicDuesseldorfNetServerArchive("https://vergabe.duesseldorf.de/NetServer/TenderingProcedureDetails?function=_DownloadTenderDocuments&TenderOID=54321-Tender-abc"),/netserver_target_forbidden/);
});

test("NetServer archive downloader requires an exact registry-provided host",async()=>{
  const url="https://vergabe.landbw.de/NetServer/TenderingProcedureDetails?function=_Details&TenderOID=54321-Tender-abc";
  await assert.rejects(()=>downloadPublicNetServerArchive(url),/netserver_target_forbidden/);
  await assert.rejects(()=>downloadPublicNetServerArchive(url,{expectedHost:"vergabe.stadt-frankfurt.de"}),/netserver_target_forbidden/);
  await assert.rejects(()=>downloadPublicNetServerArchive("https://vergabe.landbw.de/NetServer/TenderingProcedureDetails?function=_Details&TenderOID=unbound",{expectedHost:"vergabe.landbw.de"}),/netserver_target_forbidden/);
});

test("AI Bietercockpit archive downloader rejects every unbound target before navigation",async()=>{
  await assert.rejects(()=>downloadPublicAIBietercockpitArchive("https://evil.example/VN/X-BBS-2026-0112"),/ai_bietercockpit_target_forbidden/);
  await assert.rejects(()=>downloadPublicAIBietercockpitArchive("https://www.deutsches-ausschreibungsblatt.de/ausschreibung#/fixture"),/ai_bietercockpit_target_forbidden/);
});
