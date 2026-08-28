import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import {DOCX_MIME,XLSX_MIME,inspectOfficeForm,fillOfficeForm} from "../platform/required-office-form.mjs";

const contentTypes=overrides=>`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${overrides}</Types>`;

const docxFixture=async({macro=false,structured=true}={})=>{
  const zip=new JSZip();
  zip.file("[Content_Types].xml",contentTypes(`<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${macro?'<Override PartName="/word/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>':""}`));
  zip.file("word/document.xml",`<?xml version="1.0"?><w:document xmlns:w="urn:w" xmlns:w14="urn:w14"><w:body><w:p><w:r><w:t>Unveränderter Vertragstext</w:t></w:r></w:p>${structured?`<w:sdt><w:sdtPr><w:alias w:val="Firmenname"/><w:tag w:val="REQUIRED:company_name"/></w:sdtPr><w:sdtContent><w:r><w:t>Alt</w:t></w:r></w:sdtContent></w:sdt><w:sdt><w:sdtPr><w:alias w:val="Rechtsform"/><w:tag w:val="company_type"/><w:dropDownList><w:listItem w:displayText="GmbH"/><w:listItem w:displayText="AG"/></w:dropDownList></w:sdtPr><w:sdtContent><w:r><w:t>GmbH</w:t></w:r></w:sdtContent></w:sdt><w:sdt><w:sdtPr><w:alias w:val="Bestätigt"/><w:tag w:val="confirmed"/><w14:checkbox><w14:checked w14:val="0"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>☐</w:t></w:r></w:sdtContent></w:sdt>`:""}<w:sectPr/></w:body></w:document>`);
  zip.file("docProps/custom.xml","<Properties><property name=\"Preserve\">yes</property></Properties>");
  if(macro)zip.file("word/vbaProject.bin",Buffer.from([1,2,3]));
  return zip.generateAsync({type:"nodebuffer"});
};

const xlsxFixture=async({macro=false}={})=>{
  const zip=new JSZip();
  zip.file("[Content_Types].xml",contentTypes(`${macro?'<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>':""}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`));
  zip.file("xl/workbook.xml",`<?xml version="1.0"?><workbook xmlns:r="urn:r"><sheets><sheet name="Preisblatt" sheetId="1" r:id="rId1"/><sheet name="Versteckt" sheetId="2" state="hidden" r:id="rId2"/></sheets><definedNames><definedName name="REQUIRED_Stundensatz">Preisblatt!$B$2</definedName><definedName name="Firma">Preisblatt!$B$1</definedName><definedName name="FormelNichtEditierbar">Preisblatt!$C$2</definedName></definedNames></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels",`<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`);
  zip.file("xl/worksheets/sheet1.xml",`<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="B1" s="4" t="inlineStr"><is><t>Alt GmbH</t></is></c></row><row r="2"><c r="B2" s="5"><v>0</v></c><c r="C2" s="6"><f>B2*2</f><v>0</v></c></row><row r="3"><c r="B3" s="7" t="inlineStr"><is><t>A</t></is></c></row></sheetData><dataValidations count="1"><dataValidation type="list" allowBlank="0" sqref="B3"><formula1>"A,B,C"</formula1></dataValidation></dataValidations></worksheet>`);
  zip.file("xl/worksheets/sheet2.xml",`<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>`);
  zip.file("xl/comments1.xml","<comments><commentList><comment ref=\"B2\"><text><t>Erhalten</t></text></comment></commentList></comments>");
  if(macro)zip.file("xl/vbaProject.bin",Buffer.from([1,2,3]));
  return zip.generateAsync({type:"nodebuffer"});
};

test("DOCX structured controls round-trip and preserve unrelated package parts",async()=>{
  const source=await docxFixture(),before=Buffer.from(source),inspection=await inspectOfficeForm(source,DOCX_MIME);
  assert.equal(inspection.editable,true);assert.equal(inspection.fields.length,3);assert.equal(inspection.fields[0].required,true);
  const values=Object.fromEntries(inspection.fields.map(field=>[field.id,field.type==="checkbox"?true:field.type==="select"?"AG":"WB-Cleaning GmbH"]));
  const filled=await fillOfficeForm(source,DOCX_MIME,values);
  assert.deepEqual(source,before);assert.equal(filled.originalUnchanged,true);assert.equal(filled.rereadVerified,true);assert.equal(filled.transmitted,false);
  const reread=await inspectOfficeForm(filled.content,DOCX_MIME),actual=Object.fromEntries(reread.fields.map(field=>[field.id,field.value]));assert.deepEqual(actual,values);
  const zip=await JSZip.loadAsync(filled.content);assert.match(await zip.file("word/document.xml").async("string"),/Unveränderter Vertragstext/);assert.match(await zip.file("docProps/custom.xml").async("string"),/Preserve/);
});

test("XLSX explicit cells round-trip while formulas, styles, hidden sheets and comments survive",async()=>{
  const source=await xlsxFixture(),inspection=await inspectOfficeForm(source,XLSX_MIME);
  assert.equal(inspection.fields.length,3);assert.equal(inspection.fields.some(field=>field.source.address==="C2"),false);
  const byAddress=Object.fromEntries(inspection.fields.map(field=>[field.source.address,field]));
  const values={[byAddress.B1.id]:"WB-Facilitys GmbH",[byAddress.B2.id]:42.75,[byAddress.B3.id]:"C"};
  const filled=await fillOfficeForm(source,XLSX_MIME,values),zip=await JSZip.loadAsync(filled.content),sheet=await zip.file("xl/worksheets/sheet1.xml").async("string");
  assert.equal(filled.rereadVerified,true);assert.match(sheet,/<c r="C2" s="6"><f>B2\*2<\/f><v>0<\/v><\/c>/);assert.match(sheet,/<c r="B2" s="5"><v>42.75<\/v><\/c>/);assert.match(await zip.file("xl/workbook.xml").async("string"),/state="hidden"/);assert.match(await zip.file("xl/comments1.xml").async("string"),/Erhalten/);
});

test("Office form boundary rejects macros, unstructured documents and invalid values",async()=>{
  await assert.rejects(inspectOfficeForm(await docxFixture({macro:true}),DOCX_MIME),/office_macro_forbidden/);
  const plain=await docxFixture({structured:false});assert.equal((await inspectOfficeForm(plain,DOCX_MIME)).editable,false);await assert.rejects(fillOfficeForm(plain,DOCX_MIME,{}),/structured_fields_missing/);
  const docx=await docxFixture(),inspection=await inspectOfficeForm(docx,DOCX_MIME),required=inspection.fields.find(field=>field.required),select=inspection.fields.find(field=>field.type==="select");
  await assert.rejects(fillOfficeForm(docx,DOCX_MIME,{[required.id]:"",[select.id]:"GmbH"}),/required_value_missing/);
  await assert.rejects(fillOfficeForm(docx,DOCX_MIME,{[required.id]:"WB",[select.id]:"KG"}),/option_invalid/);
  await assert.rejects(fillOfficeForm(docx,DOCX_MIME,{[required.id]:"WB",unknown:"secret"}),/field_unknown/);
  await assert.rejects(inspectOfficeForm(await xlsxFixture({macro:true}),XLSX_MIME),/office_macro_forbidden/);
});
