import crypto from "node:crypto";
import path from "node:path";
import JSZip from "jszip";
import iconv from "iconv-lite";
import { parse as parseCsv } from "csv-parse/sync";
import { XMLParser } from "fast-xml-parser";

// pdfjs 6 assumes browser matrix globals even in its legacy Node build.  Load it
// lazily after installing the small standards-compatible 2D matrix surface that
// Node <22 does not provide.  Non-PDF parsers must never fail merely because the
// host Node version has no DOMMatrix.
class NodeDOMMatrix {
  constructor(value = [1, 0, 0, 1, 0, 0]) {
    const v = Array.isArray(value) || ArrayBuffer.isView(value) ? value : [value.a, value.b, value.c, value.d, value.e, value.f];
    [this.a, this.b, this.c, this.d, this.e, this.f] = [Number(v[0] ?? 1), Number(v[1] ?? 0), Number(v[2] ?? 0), Number(v[3] ?? 1), Number(v[4] ?? 0), Number(v[5] ?? 0)];
    this.is2D = true;
  }
  multiply(other) { return new NodeDOMMatrix(this).multiplySelf(other); }
  preMultiplySelf(other) { const left = new NodeDOMMatrix(other), right = new NodeDOMMatrix(this); Object.assign(this, left.multiply(right)); return this; }
  multiplySelf(other) {
    const m = new NodeDOMMatrix(other), { a, b, c, d, e, f } = this;
    this.a = a * m.a + c * m.b; this.b = b * m.a + d * m.b;
    this.c = a * m.c + c * m.d; this.d = b * m.c + d * m.d;
    this.e = a * m.e + c * m.f + e; this.f = b * m.e + d * m.f + f;
    return this;
  }
  translate(x = 0, y = 0) { return this.multiply(new NodeDOMMatrix([1, 0, 0, 1, x, y])); }
  translateSelf(x = 0, y = 0) { return this.multiplySelf([1, 0, 0, 1, x, y]); }
  scale(x = 1, y = x) { return this.multiply(new NodeDOMMatrix([x, 0, 0, y, 0, 0])); }
  scaleSelf(x = 1, y = x) { return this.multiplySelf([x, 0, 0, y, 0, 0]); }
  rotate(angle = 0) { const r = angle * Math.PI / 180; return this.multiply(new NodeDOMMatrix([Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0])); }
  rotateSelf(angle = 0) { Object.assign(this, this.rotate(angle)); return this; }
  inverse() { return new NodeDOMMatrix(this).invertSelf(); }
  invertSelf() { const determinant = this.a * this.d - this.b * this.c; if (!determinant) { this.a = this.b = this.c = this.d = this.e = this.f = Number.NaN; return this; } const { a, b, c, d, e, f } = this; this.a = d / determinant; this.b = -b / determinant; this.c = -c / determinant; this.d = a / determinant; this.e = (c * f - d * e) / determinant; this.f = (b * e - a * f) / determinant; return this; }
  toFloat32Array() { return new Float32Array([this.a, this.b, 0, 0, this.c, this.d, 0, 0, 0, 0, 1, 0, this.e, this.f, 0, 1]); }
}
if (typeof globalThis.DOMMatrix === "undefined") globalThis.DOMMatrix = NodeDOMMatrix;
let pdfJsPromise;
const pdfJs = () => pdfJsPromise ||= import("pdfjs-dist/legacy/build/pdf.mjs");

const PDF_STANDARD_FONT_DATA_URL = new URL(
  "../node_modules/pdfjs-dist/standard_fonts/",
  import.meta.url,
).href;

export const PARSER_VERSION = "wb-binary-parsers/2.1.0";
export const PARSER_LIMITS = Object.freeze({
  maxBytes: 50_000_000,
  maxArchiveBytes: 250_000_000,
  maxArchiveEntries: 2_000,
  maxArchiveRatio: 100,
  maxArchiveDepth: 2,
  maxXmlDepth: 64,
  maxXmlNodes: 200_000,
  timeoutMs: 15_000,
});

const EXECUTABLE = /\.(?:exe|dll|com|bat|cmd|ps1|js|jar|msi|scr|sh|elf|dylib|so)$/i;
const OOXML = new Map([
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
]);
const ZIP_CONTAINERS = new Set([".docx",".xlsx",".ods",".zip"]);
const MIME_BY_EXT = new Map([
  [".pdf", "application/pdf"],
  ...OOXML,
  [".csv", "text/csv"],
  [".xml", "application/xml"],
  [".json", "application/json"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".xls", "application/vnd.ms-excel"],
  [".doc", "application/msword"],
  [".ods", "application/vnd.oasis.opendocument.spreadsheet"],
  [".gaeb", "application/xml"],
  [".x81", "application/xml"], [".x82", "application/xml"], [".x83", "application/xml"],
  [".d81", "application/xml"], [".d82", "application/xml"], [".d83", "application/xml"],
  [".p81", "application/xml"], [".p82", "application/xml"], [".p83", "application/xml"],
  [".zip", "application/zip"],
]);
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const entityDecode = (text) => String(text)
  .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")
  .replaceAll("&quot;", "\"").replaceAll("&apos;", "'");
const textNodes = (xml) => [...String(xml).matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
  .map((match) => entityDecode(match[1])).join("");
const spreadsheetTextNodes = (xml) => [...String(xml).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
  .map((match) => entityDecode(match[1])).join("");

function assertEnvelope({buffer, name, mediaType}) {
  if (!Buffer.isBuffer(buffer)) throw new Error("parser_buffer_required");
  if (!name || name.includes("\0") || path.isAbsolute(name) || name.split(/[\\/]/).includes(".."))
    throw new Error("parser_path_invalid");
  if (buffer.length === 0 || buffer.length > PARSER_LIMITS.maxBytes) throw new Error("parser_size_invalid");
  const extension = path.extname(name).toLowerCase();
  const expected = MIME_BY_EXT.get(extension);
  if (!expected) throw new Error("parser_extension_forbidden");
  const normalizedMime = mediaType === "text/xml" ? "application/xml" : mediaType;
  if (expected !== normalizedMime) throw new Error("parser_mime_mismatch");
  const pdf = buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  const zip = buffer[0] === 0x50 && buffer[1] === 0x4b &&
    [[0x03,0x04],[0x05,0x06],[0x07,0x08]].some(([a,b]) => buffer[2] === a && buffer[3] === b);
  if (extension === ".pdf" && !pdf) throw new Error("parser_signature_mismatch");
  if (ZIP_CONTAINERS.has(extension) && !zip) throw new Error("parser_signature_mismatch");
  if ([".csv",".xml",".json",".html",".htm"].includes(extension) && (pdf || zip)) throw new Error("parser_signature_mismatch");
  if (extension === ".xls" && !buffer.subarray(0,8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])))
    throw new Error("parser_signature_mismatch");
  if (extension === ".doc" && !buffer.subarray(0,8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])))
    throw new Error("parser_signature_mismatch");
  return {extension, expectedMime: expected};
}

function archiveSizes(entry) {
  const compressed = Number(entry?._data?.compressedSize || 0);
  const uncompressed = Number(entry?._data?.uncompressedSize || 0);
  return {compressed, uncompressed};
}

async function inspectZip(buffer, depth = 0) {
  if (depth >= PARSER_LIMITS.maxArchiveDepth) throw new Error("archive_recursion_limit");
  let archive;
  try { archive = await JSZip.loadAsync(buffer, {checkCRC32:true, createFolders:false}); }
  catch { throw new Error("archive_corrupt"); }
  const entries = Object.values(archive.files);
  if (entries.length > PARSER_LIMITS.maxArchiveEntries) throw new Error("archive_entry_limit");
  let expanded = 0;
  const files = [];
  for (const entry of entries) {
    const normalized = entry.name.replaceAll("\\", "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) ||
        normalized.split("/").includes("..")) throw new Error("archive_path_traversal");
    if (EXECUTABLE.test(normalized)) throw new Error("archive_executable_forbidden");
    if (entry.dir) continue;
    const sizes = archiveSizes(entry);
    expanded += sizes.uncompressed;
    if (expanded > PARSER_LIMITS.maxArchiveBytes) throw new Error("archive_expanded_size_limit");
    if (sizes.compressed > 0 && sizes.uncompressed / sizes.compressed > PARSER_LIMITS.maxArchiveRatio)
      throw new Error("archive_ratio_limit");
    const nested = /\.zip$/i.test(normalized);
    if (nested) {
      const nestedBuffer = await entry.async("nodebuffer");
      await inspectZip(nestedBuffer, depth + 1);
    }
    files.push({name:normalized, compressedBytes:sizes.compressed, uncompressedBytes:sizes.uncompressed,
      executable:false, nestedArchive:nested, disposition:"QUARANTINED_UNTIL_APPROVED"});
  }
  return {entries:files, entryCount:files.length, expandedBytes:expanded};
}

async function parsePdf(buffer) {
  const { getDocument, PasswordResponses } = await pdfJs();
  let document;
  try {
    document = await getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported:false,
      disableFontFace:true,
      useSystemFonts:false,
      standardFontDataUrl:PDF_STANDARD_FONT_DATA_URL,
      stopEventLoop:false,
      password: "",
    }).promise;
  } catch (error) {
    if (error?.name === "PasswordException" ||
        error?.code === PasswordResponses.NEED_PASSWORD ||
        error?.code === PasswordResponses.INCORRECT_PASSWORD)
      throw new Error("pdf_encrypted_manual_review");
    throw new Error("pdf_corrupt");
  }
  try {
    const metadata = await document.getMetadata().catch(() => ({info:{},metadata:null}));
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent({disableNormalization:false, includeMarkedContent:false});
      const positioned = content.items.filter((item) => typeof item.str === "string").map((item) => ({
        text:item.str, x:Number(item.transform?.[4] || 0), y:Number(item.transform?.[5] || 0),
        width:Number(item.width || 0), height:Number(item.height || 0),
      }));
      const rows = new Map();
      for (const item of positioned) {
        const key = Math.round(item.y * 2) / 2;
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key).push(item);
      }
      const lines = [...rows.entries()].sort((a,b) => b[0]-a[0]).map(([,items]) =>
        items.sort((a,b) => a.x-b.x).map((item) => item.text).join(" ").trim()).filter(Boolean);
      const text = lines.join("\n");
      const manualReview = text.replace(/\s/g, "").length < 10;
      pages.push({pageNumber,text,lines,tables:lines.filter((line) => /\s{2,}|\t/.test(line)),
        manualReview, status:manualReview ? "MANUAL_REVIEW_REQUIRED" : "EXTRACTED"});
      page.cleanup();
    }
    const ocrRequired=pages.every((page)=>page.manualReview);
    return {type:"PDF",pageCount:document.numPages,pages,
      metadata:{info:metadata.info || {},xmp:metadata.metadata?.getAll?.() || {}},
      manualReview:pages.some((page) => page.manualReview),ocrRequired};
  } finally {
    if (typeof document.destroy === "function") await document.destroy();
    else if (typeof document.cleanup === "function") await document.cleanup();
  }
}

async function parseDocx(buffer) {
  const zipInfo = await inspectZip(buffer);
  const zip = await JSZip.loadAsync(buffer, {checkCRC32:true});
  if (zip.file("word/vbaProject.bin") || zip.file("vbaProject.bin")) throw new Error("docx_macro_forbidden");
  const documentFile = zip.file("word/document.xml");
  if (!documentFile) throw new Error("docx_document_missing");
  const documentXml = await documentFile.async("string");
  const paragraphXml = [...documentXml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)].map((m) => m[1]);
  const paragraphs = paragraphXml.map((xml,index) => ({
    index:index+1,text:textNodes(xml),list:/<w:numPr(?:\s|\/?>)/.test(xml),
  })).filter((item) => item.text);
  const tables = [...documentXml.matchAll(/<w:tbl(?:\s[^>]*)?>([\s\S]*?)<\/w:tbl>/g)].map((table) =>
    [...table[1].matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)].map((row) =>
      [...row[1].matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)].map((cell) => textNodes(cell[1]))));
  const headers = [], footers = [];
  for (const [name,entry] of Object.entries(zip.files)) {
    if (/^word\/header\d+\.xml$/.test(name)) headers.push({name,text:textNodes(await entry.async("string"))});
    if (/^word\/footer\d+\.xml$/.test(name)) footers.push({name,text:textNodes(await entry.async("string"))});
  }
  const relationships = [];
  for (const name of ["word/_rels/document.xml.rels","_rels/.rels"]) {
    const entry = zip.file(name);
    if (!entry) continue;
    const xml = await entry.async("string");
    for (const match of xml.matchAll(/<Relationship\b([^>]+)\/?>/g)) {
      const attrs = Object.fromEntries([...match[1].matchAll(/(\w+)="([^"]*)"/g)].map((item) => [item[1],item[2]]));
      relationships.push({id:attrs.Id,type:attrs.Type,target:attrs.Target,
        external:attrs.TargetMode === "External",fetched:false});
    }
  }
  return {type:"DOCX",paragraphs,tables,headers,footers,relationships,archive:zipInfo,
    manualReview:paragraphs.length === 0 && tables.length === 0};
}

async function parseXlsx(buffer) {
  const zipInfo = await inspectZip(buffer);
  const zip = await JSZip.loadAsync(buffer, {checkCRC32:true});
  if (zip.file("xl/vbaProject.bin") || zip.file("vbaProject.bin")) throw new Error("xlsx_macro_forbidden");
  const contentTypes = await zip.file("[Content_Types].xml")?.async("string") || "";
  if (/macroEnabled/i.test(contentTypes)) throw new Error("xlsx_macro_forbidden");
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  const relationshipsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!workbookXml || !relationshipsXml) throw new Error("xlsx_workbook_missing");
  const sharedStringsXml = await zip.file("xl/sharedStrings.xml")?.async("string") || "";
  const sharedStrings = [...sharedStringsXml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)]
    .map((match) => spreadsheetTextNodes(match[1]));
  const rels = new Map([...relationshipsXml.matchAll(/<Relationship\b([^>]+)\/?>/g)].map((match) => {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w:]+)="([^"]*)"/g)].map((item) => [item[1],item[2]]));
    return [attrs.Id,attrs.Target];
  }));
  const sheetDefinitions = [...workbookXml.matchAll(/<sheet\b([^>]+)\/?>/g)].map((match) =>
    Object.fromEntries([...match[1].matchAll(/([\w:]+)="([^"]*)"/g)].map((item) => [item[1],item[2]])));
  const definedNames = [...workbookXml.matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g)].map((match) => {
    const attrs=Object.fromEntries([...match[1].matchAll(/([\w:]+)="([^"]*)"/g)].map((item)=>[item[1],item[2]]));
    return {name:attrs.name||null,localSheetId:attrs.localSheetId??null,hidden:attrs.hidden==="1",reference:entityDecode(match[2])};
  });
  const worksheets = [];
  for (const definition of sheetDefinitions) {
    const target = rels.get(definition["r:id"]);
    if (!target) throw new Error("xlsx_relationship_missing");
    const sheetPath = path.posix.normalize(`xl/${target}`.replace("xl//","xl/"));
    if (!sheetPath.startsWith("xl/worksheets/")) throw new Error("xlsx_relationship_invalid");
    const xml = await zip.file(sheetPath)?.async("string");
    if (!xml) throw new Error("xlsx_sheet_missing");
    const sheetRelationshipsPath = `${path.posix.dirname(sheetPath)}/_rels/${path.posix.basename(sheetPath)}.rels`;
    const sheetRelationshipsXml = await zip.file(sheetRelationshipsPath)?.async("string") || "";
    const linkTargets = new Map([...sheetRelationshipsXml.matchAll(/<Relationship\b([^>]+)\/?>/g)].map((match) => {
      const attrs = Object.fromEntries([...match[1].matchAll(/([\w:]+)="([^"]*)"/g)].map((item) => [item[1],item[2]]));
      return [attrs.Id,{target:attrs.Target,external:attrs.TargetMode==="External"}];
    }));
    const links = new Map([...xml.matchAll(/<hyperlink\b([^>]+)\/?>/g)].map((match) => {
      const attrs = Object.fromEntries([...match[1].matchAll(/([\w:]+)="([^"]*)"/g)].map((item) => [item[1],item[2]]));
      return [attrs.ref,linkTargets.get(attrs["r:id"])];
    }));
    const rows = [...xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)].map((rowMatch,rowIndex) => {
      const rowAttrs = Object.fromEntries([...rowMatch[1].matchAll(/([\w:]+)="([^"]*)"/g)].map((item) => [item[1],item[2]]));
      const cells = [...rowMatch[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map((cellMatch,columnIndex) => {
        const attrs = Object.fromEntries([...cellMatch[1].matchAll(/([\w:]+)="([^"]*)"/g)].map((item) => [item[1],item[2]]));
        const address = attrs.r || `${columnIndex+1}:${Number(rowAttrs.r||rowIndex+1)}`;
        const formula = cellMatch[2].match(/<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/)?.[1] || null;
        const raw = cellMatch[2].match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1] ?? null;
        const inline = cellMatch[2].match(/<is(?:\s[^>]*)?>([\s\S]*?)<\/is>/)?.[1];
        const decoded = inline !== undefined ? spreadsheetTextNodes(inline) : attrs.t === "s" ? sharedStrings[Number(raw)] : entityDecode(raw);
        const result = formula ? decoded : null;
        const hyperlink = links.get(address);
        return {address,row:Number(rowAttrs.r||rowIndex+1),column:columnIndex+1,value:formula?null:decoded,
          formula,result,displayed:decoded,numFmt:attrs.s||null,hyperlink:hyperlink?.target||null,
          externalLink:Boolean(hyperlink?.external),fetched:false};
      });
      return {rowNumber:Number(rowAttrs.r||rowIndex+1),hidden:rowAttrs.hidden==="1",height:rowAttrs.ht?Number(rowAttrs.ht):null,cells};
    });
    const hiddenColumns=[...xml.matchAll(/<col\b([^>]*)\/?>/g)].map((match)=>Object.fromEntries([...match[1].matchAll(/([\w:]+)="([^"]*)"/g)].map((item)=>[item[1],item[2]]))).filter((attrs)=>attrs.hidden==="1").map((attrs)=>({min:Number(attrs.min),max:Number(attrs.max)}));
    const dataValidations=[...xml.matchAll(/<dataValidation\b([^>]*)>([\s\S]*?)<\/dataValidation>/g)].map((match)=>{const attrs=Object.fromEntries([...match[1].matchAll(/([\w:]+)="([^"]*)"/g)].map((item)=>[item[1],item[2]]));return {range:attrs.sqref||null,type:attrs.type||null,operator:attrs.operator||null,allowBlank:attrs.allowBlank==="1",formula1:entityDecode(match[2].match(/<formula1>([\s\S]*?)<\/formula1>/)?.[1]||""),formula2:entityDecode(match[2].match(/<formula2>([\s\S]*?)<\/formula2>/)?.[1]||"")};});
    const comments=[];
    for(const [relationshipId,relationship] of linkTargets){
      if(!/comments/i.test(relationship?.target||""))continue;
      const commentPath=path.posix.normalize(`${path.posix.dirname(sheetPath)}/${relationship.target}`);
      const commentXml=await zip.file(commentPath)?.async("string")||"";
      for(const comment of commentXml.matchAll(/<comment\b([^>]*)>([\s\S]*?)<\/comment>/g)){const attrs=Object.fromEntries([...comment[1].matchAll(/([\w:]+)="([^"]*)"/g)].map((item)=>[item[1],item[2]]));comments.push({cell:attrs.ref||null,authorId:attrs.authorId??null,text:spreadsheetTextNodes(comment[2])});}
    }
    worksheets.push({name:definition.name,state:definition.state||"visible",
      hidden:Boolean(definition.state&&definition.state!=="visible"),
      mergedCells:[...xml.matchAll(/<mergeCell\s+ref="([^"]+)"\s*\/?>/g)].map((match)=>match[1]),hiddenColumns,dataValidations,comments,rows});
  }
  return {type:"XLSX",worksheets,definedNames,archive:zipInfo,
    externalLinks:worksheets.flatMap((sheet) => sheet.rows.flatMap((row) =>
      row.cells.filter((cell) => cell.externalLink).map((cell) => ({sheet:sheet.name,address:cell.address,url:cell.hyperlink,fetched:false}))))};
}

async function parseOds(buffer) {
  const zipInfo=await inspectZip(buffer),zip=await JSZip.loadAsync(buffer,{checkCRC32:true}),content=await zip.file("content.xml")?.async("string");
  if(!content)throw new Error("ods_content_missing");
  const worksheets=[...content.matchAll(/<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g)].map((sheet,index)=>{
    const name=sheet[1].match(/table:name="([^"]*)"/)?.[1]||`Tabelle ${index+1}`,visibility=sheet[1].match(/table:display="([^"]*)"/)?.[1];
    const rows=[...sheet[2].matchAll(/<table:table-row\b([^>]*)>([\s\S]*?)<\/table:table-row>/g)].map((row,rowIndex)=>({rowNumber:rowIndex+1,hidden:/table:visibility="collapse"|table:display="false"/.test(row[1]),cells:[...row[2].matchAll(/<table:table-cell\b([^>]*)>([\s\S]*?)<\/table:table-cell>/g)].map((cell,columnIndex)=>({address:`${columnIndex+1}:${rowIndex+1}`,row:rowIndex+1,column:columnIndex+1,value:entityDecode(cell[2].replace(/<text:p\b[^>]*>/g,"").replace(/<\/text:p>/g,"\n").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim()),formula:cell[1].match(/table:formula="([^"]*)"/)?.[1]||null}))}));
    return {name,state:visibility==="false"?"hidden":"visible",hidden:visibility==="false",rows};
  });
  return {type:"ODS",worksheets,archive:zipInfo};
}

function decodeCsv(buffer) {
  if (buffer.subarray(0,3).equals(Buffer.from([0xef,0xbb,0xbf]))) return {encoding:"utf8-bom",text:buffer.subarray(3).toString("utf8")};
  if (buffer.subarray(0,2).equals(Buffer.from([0xff,0xfe]))) return {encoding:"utf16le",text:iconv.decode(buffer.subarray(2),"utf16-le")};
  if (buffer.subarray(0,2).equals(Buffer.from([0xfe,0xff]))) return {encoding:"utf16be",text:iconv.decode(buffer.subarray(2),"utf16-be")};
  const utf8 = buffer.toString("utf8");
  if (!utf8.includes("\uFFFD")) return {encoding:"utf8",text:utf8};
  return {encoding:"windows-1252",text:iconv.decode(buffer,"windows-1252")};
}

function parseCsvDocument(buffer) {
  const {encoding,text} = decodeCsv(buffer);
  const sample = text.split(/\r?\n/,1)[0] || "";
  const delimiters = [",",";","\t","|"];
  const delimiter = delimiters.sort((a,b) => sample.split(b).length-sample.split(a).length)[0];
  let records;
  try {
    records = parseCsv(text,{delimiter,quote:"\"",bom:true,relax_column_count:false,
      skip_empty_lines:true,max_record_size:1_000_000});
  } catch (error) { throw new Error("csv_corrupt", { cause: error }); }
  const cells = records.map((row,rowIndex) => row.map((value,columnIndex) => {
    const formulaInjection = /^[=+\-@\t\r]/.test(value);
    return {row:rowIndex+1,column:columnIndex+1,value,
      exportValue:formulaInjection ? `'${value}` : value,formulaInjection};
  }));
  return {type:"CSV",encoding,delimiter,rows:cells,
    formulaInjectionCells:cells.flat().filter((cell) => cell.formulaInjection).map(({row,column}) => ({row,column}))};
}

function xmlDepthAndNodes(text) {
  let depth = 0, maxDepth = 0, nodes = 0;
  for (const token of text.matchAll(/<\/?([A-Za-z_][\w:.-]*)(?:\s[^<>]*?)?\/?>/g)) {
    const raw = token[0];
    if (raw.startsWith("</")) depth -= 1;
    else {
      nodes += 1;
      if (!raw.endsWith("/>")) depth += 1;
      maxDepth = Math.max(maxDepth,depth);
    }
    if (depth < 0) throw new Error("xml_corrupt");
    if (maxDepth > PARSER_LIMITS.maxXmlDepth) throw new Error("xml_depth_limit");
    if (nodes > PARSER_LIMITS.maxXmlNodes) throw new Error("xml_node_limit");
  }
  if (depth !== 0) throw new Error("xml_corrupt");
  return {maxDepth,nodes};
}

function parseXmlDocument(buffer) {
  const {encoding,text} = decodeCsv(buffer);
  if (/<!DOCTYPE|<!ENTITY|SYSTEM\s+["']|PUBLIC\s+["']/i.test(text)) throw new Error("xml_dtd_forbidden");
  const limits = xmlDepthAndNodes(text);
  try {
    const parser = new XMLParser({ignoreAttributes:false,processEntities:false,htmlEntities:false,
      allowBooleanAttributes:false,parseTagValue:false,parseAttributeValue:false,trimValues:false});
    return {type:"XML",encoding,document:parser.parse(text),...limits,externalEntitiesFetched:false};
  } catch (error) {
    if (error.message?.startsWith("xml_")) throw error;
    throw new Error("xml_corrupt");
  }
}

function parseJsonDocument(buffer) {
  const {encoding,text}=decodeCsv(buffer);
  if(text.length>PARSER_LIMITS.maxBytes)throw new Error("parser_size_invalid");
  try{return {type:"JSON",encoding,document:JSON.parse(text)}}catch(error){throw new Error("json_corrupt",{cause:error})}
}

function parseHtmlDocument(buffer) {
  const {encoding,text}=decodeCsv(buffer);
  if(/<!DOCTYPE[^>]+(?:SYSTEM|PUBLIC)/i.test(text))throw new Error("html_external_doctype_forbidden");
  const safe=text.replace(/<script\b[\s\S]*?<\/script>/gi,"").replace(/<style\b[\s\S]*?<\/style>/gi,"");
  const links=[...safe.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)].map(x=>x[1]);
  const plain=entityDecode(safe.replace(/<\/?(?:p|div|li|tr|h[1-6]|br)\b[^>]*>/gi,"\n").replace(/<[^>]+>/g," ")).replace(/[ \t]+/g," ").replace(/\n{3,}/g,"\n\n").trim();
  return {type:"HTML",encoding,text:plain,links,externalResourcesFetched:false};
}

function parseLegacyXls(buffer) {
  const strings=[];
  for(const match of buffer.toString("latin1").matchAll(/[\x20-\x7e\x80-\xff]{4,}/g))strings.push(match[0].trim());
  return {type:"XLS",strings:[...new Set(strings)].slice(0,10000),manualReview:true,
    legacyBinary:true,warning:"VORHANDEN_MANUELL_ZU_PRÜFEN"};
}

function parseLegacyDoc(buffer){const strings=[];for(const match of buffer.toString("latin1").matchAll(/[\x20-\x7e\x80-\xff]{4,}/g))strings.push(match[0].trim());return {type:"DOC",paragraphs:[...new Set(strings)].slice(0,20000).map((text,index)=>({index:index+1,text})),manualReview:true,legacyBinary:true,warning:"VORHANDEN_MANUELL_ZU_PRÜFEN"}}

function gaebFacts(document){
  const root=document?.GAEB??document,items=[];
  const walk=(value,path=[])=>{if(!value||typeof value!=="object")return;for(const [key,item] of Object.entries(value)){const next=[...path,key];if(/^Item$/i.test(key)){for(const candidate of Array.isArray(item)?item:[item])if(candidate&&typeof candidate==="object")items.push({path:next.join("."),position:candidate.RNoPart??candidate.ID??candidate.OZ??null,quantity:candidate.Qty??candidate.Quantity??null,unit:candidate.QU??candidate.Unit??null,shortText:candidate.BriefDescr??candidate.ShortText??null,longText:candidate.CompleteText??candidate.LongText??null,price:candidate.UP??candidate.UnitPrice??null})}walk(item,next)}};walk(root);return items;
}

export async function parseBinaryDocument(input) {
  const started = Date.now();
  const {buffer,name,mediaType} = input;
  const envelope = assertEnvelope(input);
  let parsed;
  const operation = (async () => {
    if (envelope.extension === ".pdf") return parsePdf(buffer);
    if (envelope.extension === ".docx") return parseDocx(buffer);
    if (envelope.extension === ".xlsx") return parseXlsx(buffer);
    if (envelope.extension === ".ods") return parseOds(buffer);
    if (envelope.extension === ".csv") return parseCsvDocument(buffer);
    if ([".xml",".gaeb",".x81",".x82",".x83",".d81",".d82",".d83",".p81",".p82",".p83"].includes(envelope.extension)){const xml=parseXmlDocument(buffer);return envelope.extension===".xml"?xml:{...xml,type:"GAEB",gaeb:{items:gaebFacts(xml.document)}}}
    if (envelope.extension === ".json") return parseJsonDocument(buffer);
    if ([".html",".htm"].includes(envelope.extension)) return parseHtmlDocument(buffer);
    if (envelope.extension === ".xls") return parseLegacyXls(buffer);
    if (envelope.extension === ".doc") return parseLegacyDoc(buffer);
    if (envelope.extension === ".zip") return {type:"ZIP",archive:await inspectZip(buffer)};
    throw new Error("parser_not_supported");
  })();
  let timeoutHandle;
  const timeout = new Promise((_,reject) => {
    timeoutHandle = setTimeout(() => reject(new Error("parser_timeout")), input.timeoutMs || PARSER_LIMITS.timeoutMs);
    timeoutHandle.unref?.();
  });
  try {
    parsed = await Promise.race([operation,timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
  return {status:parsed.ocrRequired ? "OCR_ERFORDERLICH" : parsed.manualReview ? "VORHANDEN_MANUELL_ZU_PRÜFEN" : "VORHANDEN",name,mediaType,
    sha256:sha256(buffer),sizeBytes:buffer.length,parserVersion:PARSER_VERSION,
    parsedAt:new Date().toISOString(),durationMs:Date.now()-started,audit:{action:"document_parsed",externalEffects:false},...parsed};
}

export async function inspectArchive(buffer, depth = 0) {
  return inspectZip(buffer,depth);
}

export async function extractArchiveDocuments(buffer, depth = 0, prefix = "") {
  if (depth >= PARSER_LIMITS.maxArchiveDepth) throw new Error("archive_recursion_limit");
  const inspection = await inspectZip(buffer, depth);
  const archive = await JSZip.loadAsync(buffer, {checkCRC32:true, createFolders:false});
  const extracted = [];
  let expandedBytes = 0;
  for (const metadata of inspection.entries) {
    const entry = archive.file(metadata.name)||Object.values(archive.files).find(candidate=>candidate.name.replaceAll("\\", "/")===metadata.name);
    if (!entry) continue;
    const content = await entry.async("nodebuffer");
    expandedBytes += content.length;
    if (expandedBytes > PARSER_LIMITS.maxArchiveBytes) throw new Error("archive_expanded_size_limit");
    const archivePath = prefix ? `${prefix}/${metadata.name}` : metadata.name;
    if (metadata.nestedArchive) {
      const nested = await extractArchiveDocuments(content, depth + 1, archivePath);
      extracted.push(...nested);
      continue;
    }
    const extension = path.extname(metadata.name).toLowerCase();
    const mediaType = MIME_BY_EXT.get(extension);
    if (!mediaType) continue;
    extracted.push({name:path.basename(metadata.name),archivePath,mediaType,buffer:content,depth});
  }
  if (extracted.length > PARSER_LIMITS.maxArchiveEntries) throw new Error("archive_entry_limit");
  return extracted;
}
