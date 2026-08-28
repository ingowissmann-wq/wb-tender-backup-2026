import crypto from "node:crypto";
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from "docx";
import JSZip from "jszip";
import PDFDocument from "pdfkit";

export const GENERATOR_VERSION = "wb-document-generators/2.1.0";
export const GENERATED_TYPES = Object.freeze([
  "BOARD_BRIEF","TENDER_SUMMARY","REQUIREMENT_MATRIX","EVIDENCE_MATRIX",
  "DEADLINE_OVERVIEW","CALCULATION_OVERVIEW","PRICE_APPROVAL","OFFER_CHECKLIST",
  "COVER_LETTER_DRAFT","SERVICE_CONCEPT_DRAFT","STAFFING_CONCEPT_DRAFT",
  "QUALITY_CONCEPT_DRAFT","DOCUMENT_LIST","SIGNATURE_LIST",
]);
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const value = (input) => input === undefined || input === null || input === "" ? "noch zu pflegen" : String(input);
const safeCell = (input) => /^[=+\-@\t\r]/.test(value(input)) ? `'${value(input)}` : value(input);
const entries = (data) => Object.entries(data || {}).filter(([,item]) =>
  typeof item !== "object" || item === null).map(([key,item]) => [key,value(item)]);

function assertInput(input) {
  if (!GENERATED_TYPES.includes(input.type)) throw new Error("generator_type_invalid");
  if (!["DOCX","XLSX","PDF"].includes(input.format)) throw new Error("generator_format_invalid");
  for (const field of ["company","tenderVersion","generatorRequestedBy"])
    if (!input.metadata?.[field]) throw new Error(`generator_${field}_required`);
  if (input.metadata?.binding === true || input.metadata?.externalUpload === true ||
      input.metadata?.electronicSignature === true) throw new Error("generator_external_effect_forbidden");
}

async function docxBuffer(input,manifest) {
  const rows = entries(input.data);
  const table = new Table({rows:[
    new TableRow({children:[new TableCell({children:[new Paragraph({children:[new TextRun({text:"Feld",bold:true})]})]}),
      new TableCell({children:[new Paragraph({children:[new TextRun({text:"Wert",bold:true})]})]})]}),
    ...rows.map(([key,item]) => new TableRow({children:[
      new TableCell({children:[new Paragraph(key)]}),new TableCell({children:[new Paragraph(item)]}),
    ]})),
  ]});
  const doc = new Document({creator:"WB Tender-Autopilot",description:JSON.stringify(manifest),
    sections:[{properties:{},children:[
      new Paragraph({text:input.title || input.type,heading:HeadingLevel.TITLE}),
      new Paragraph({text:`Gesellschaft: ${manifest.company}`}),
      new Paragraph({text:`Tender-Version: ${manifest.tenderVersion}`}),
      new Paragraph({text:`Kalkulationsversion: ${manifest.calculationVersion}`}),
      new Paragraph({text:"Interner Entwurf – keine rechtsverbindliche Erklärung",heading:HeadingLevel.HEADING_2}),
      table,
    ]}]});
  return Buffer.from(await Packer.toBuffer(doc));
}

async function xlsxBuffer(input,manifest) {
  const escape = (text) => String(text).replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&apos;");
  const sheet = (rows) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"/></sheetViews>
<cols><col min="1" max="1" width="32" customWidth="1"/><col min="2" max="2" width="80" customWidth="1"/></cols><sheetData>${
    rows.map((row,index)=>`<row r="${index+1}"><c r="A${index+1}" t="inlineStr"><is><t>${escape(safeCell(row[0]))}</t></is></c><c r="B${index+1}" t="inlineStr"><is><t>${escape(safeCell(row[1]))}</t></is></c></row>`).join("")
  }</sheetData></worksheet>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml",`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  zip.file("_rels/.rels",`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file("xl/workbook.xml",`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Inhalt" sheetId="1" r:id="rId1"/><sheet name="Versionen" sheetId="2" r:id="rId2"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels",`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`);
  zip.file("xl/worksheets/sheet1.xml",sheet([["Feld","Wert"],...entries(input.data)]));
  zip.file("xl/worksheets/sheet2.xml",sheet([["Metadatum","Wert"],...Object.entries(manifest)]));
  return zip.generateAsync({type:"nodebuffer",compression:"DEFLATE",compressionOptions:{level:6}});
}

async function pdfBuffer(input,manifest) {
  return new Promise((resolve,reject) => {
    const document = new PDFDocument({size:"A4",margin:50,info:{
      Title:input.title || input.type,Author:"WB Tender-Autopilot",
      Subject:JSON.stringify(manifest),Creator:GENERATOR_VERSION,
    }});
    const chunks = [];
    document.on("data",(chunk) => chunks.push(chunk));
    document.on("error",reject);
    document.on("end",() => resolve(Buffer.concat(chunks)));
    document.fontSize(18).text(input.title || input.type);
    document.moveDown().fontSize(10).text(`Gesellschaft: ${manifest.company}`);
    document.text(`Tender-Version: ${manifest.tenderVersion}`);
    document.text(`Kalkulationsversion: ${manifest.calculationVersion}`);
    document.moveDown().fontSize(12).text("Interner Entwurf – keine rechtsverbindliche Erklärung");
    document.moveDown();
    for (const [key,item] of entries(input.data)) {
      if (document.y > 740) document.addPage();
      document.fontSize(9).font("Helvetica-Bold").text(key,{continued:true});
      document.font("Helvetica").text(`: ${item}`);
    }
    document.end();
  });
}

export async function generateDocument(input) {
  assertInput(input);
  const createdAt = input.metadata.createdAt || new Date().toISOString();
  const manifest = Object.freeze({
    company:value(input.metadata.company),
    tenderVersion:value(input.metadata.tenderVersion),
    calculationVersion:value(input.metadata.calculationVersion),
    generatorVersion:GENERATOR_VERSION,
    createdAt,
    binding:false,
    externalUpload:false,
    electronicSignature:false,
    missingFields:Object.entries(input.data || {}).filter(([,item]) =>
      item === undefined || item === null || item === "").map(([key]) => key),
  });
  const buffer = input.format === "DOCX" ? await docxBuffer(input,manifest)
    : input.format === "XLSX" ? await xlsxBuffer(input,manifest)
    : await pdfBuffer(input,manifest);
  return {status:"INTERNAL_DRAFT_READY",type:input.type,format:input.format,buffer,
    sizeBytes:buffer.length,sha256:sha256(buffer),manifest};
}
