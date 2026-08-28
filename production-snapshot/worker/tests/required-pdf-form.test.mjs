import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { fillPdfAcroForm, inspectPdfAcroForm } from "../platform/required-pdf-form.mjs";
import { resolveRequiredOriginalForm } from "../platform/required-form-mapping.mjs";

const sha256 = (content) => createHash("sha256").update(content).digest("hex");

async function formFixture() {
  const pdf=await PDFDocument.create(),page=pdf.addPage([600,800]),form=pdf.getForm();
  form.createTextField("Bieter.Name").addToPage(page,{x:20,y:700,width:250,height:24});
  form.createCheckBox("Erklaerung.Bestaetigt").addToPage(page,{x:20,y:650,width:20,height:20});
  const choice=form.createDropdown("Leistung.Los");choice.addOptions(["LOT-1","LOT-2"]);choice.addToPage(page,{x:20,y:600,width:150,height:24});
  return Buffer.from(await pdf.save());
}

test("real AcroForm fields are inspected and filled without changing the original bytes",async()=>{
  const original=await formFixture(),originalHash=sha256(original),inspection=await inspectPdfAcroForm(original);
  assert.equal(inspection.editable,true);
  assert.deepEqual(inspection.editableFields.map(x=>x.name),["Bieter.Name","Erklaerung.Bestaetigt","Leistung.Los"]);
  const result=await fillPdfAcroForm(original,{"Bieter.Name":"Vorhandener menschlicher Wert","Erklaerung.Bestaetigt":true,"Leistung.Los":"LOT-2"});
  assert.equal(sha256(original),originalHash,"source buffer must remain byte-identical");
  assert.notEqual(sha256(result.content),originalHash,"filled working copy must be a distinct version");
  const saved=await PDFDocument.load(result.content),form=saved.getForm();
  assert.equal(form.getTextField("Bieter.Name").getText(),"Vorhandener menschlicher Wert");
  assert.equal(form.getCheckBox("Erklaerung.Bestaetigt").isChecked(),true);
  assert.deepEqual(form.getDropdown("Leistung.Los").getSelected(),["LOT-2"]);
  const cleared=await fillPdfAcroForm(result.content,{"Leistung.Los":""});
  assert.deepEqual((await PDFDocument.load(cleared.content)).getForm().getDropdown("Leistung.Los").getSelected(),[]);
});

test("unknown, malformed and invented fields fail closed",async()=>{
  const original=await formFixture();
  await assert.rejects(()=>fillPdfAcroForm(original,{Erfunden:"Wert"}),/pdf_form_unknown_field/);
  await assert.rejects(()=>fillPdfAcroForm(original,{"Erklaerung.Bestaetigt":"ja"}),/pdf_form_checkbox_value_invalid/);
  await assert.rejects(()=>fillPdfAcroForm(original,{"Leistung.Los":"LOT-999"}),/pdf_form_option_invalid/);
  await assert.rejects(()=>fillPdfAcroForm(original,{}),/pdf_form_values_count_invalid/);
});

test("non-interactive PDF stays non-AcroForm while universal source editing is independent",async()=>{
  const pdf=await PDFDocument.create();pdf.addPage();const content=Buffer.from(await pdf.save()),hash=sha256(content);
  const requirement={id:"r",tender_id:"t",company_id:"c",lot_key:"LOT",source_document_id:"d"};
  const resolved=await resolveRequiredOriginalForm(requirement,[{id:"d",tender_id:"t",company_id:"c",lot_key:"LOT",filename:"form.pdf",mime_type:"application/pdf",payload_sha256:hash,content,procurement_verification_status:"VERIFIED",explicit_form_mapping:true}]);
  assert.equal(resolved.status,"PROVEN_ORIGINAL_ONLY");
  assert.equal(resolved.downloadable,true);
  assert.equal(resolved.editable,false);
});

test("mapping stays exact to required document, tender, company and lot",async()=>{
  const content=await formFixture(),hash=sha256(content),requirement={id:"r",tender_id:"t",company_id:"c",lot_key:"LOT-1",source_document_id:"d"};
  const candidate={id:"d",tender_id:"t",company_id:"other-company",lot_key:"LOT-1",filename:"form.pdf",mime_type:"application/pdf",payload_sha256:hash,content,procurement_verification_status:"VERIFIED",explicit_form_mapping:true};
  assert.equal((await resolveRequiredOriginalForm(requirement,[candidate])).status,"NO_PROVEN_MAPPING");
});
