import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { inspectPdfForOverlay, normalizeOverlayRect, renderPdfOverlays, summarizePdfOverlays, validatePdfOverlays } from "../platform/required-pdf-overlay.mjs";
import { fillPdfAcroForm, inspectPdfAcroForm } from "../platform/required-pdf-form.mjs";

const sha256 = content => createHash("sha256").update(content).digest("hex");
const fixture = async pages => { const pdf=await PDFDocument.create();for(let index=0;index<pages;index++)pdf.addPage([600,800]);return Buffer.from(await pdf.save()) };

test("normal PDF without AcroForm receives visible overlays on page 83 and leaves source immutable",async()=>{
  const source=await fixture(96),sourceHash=sha256(source),elements=[
    {id:"synthetic-text",type:"text",page:83,x:.1,y:.2,width:.35,height:.04,text:"SYNTHETIC PAGE 83",fontSize:.018,color:"black"},
    {id:"synthetic-checkbox",type:"checkbox",page:83,x:.5,y:.2,width:.035,height:.035,checked:true,mark:"x",color:"black"},
    {id:"synthetic-highlight",type:"mark",page:83,x:.1,y:.3,width:.4,height:.03,mark:"highlight",color:"blue"},
  ];
  assert.deepEqual(await inspectPdfForOverlay(source),{pageCount:96,pages:Array.from({length:96},(_,index)=>({page:index+1,width:600,height:800}))});
  const rendered=await renderPdfOverlays(source,elements);
  assert.equal(sha256(source),sourceHash);
  assert.notEqual(sha256(rendered.content),sourceHash);
  assert.equal((await PDFDocument.load(rendered.content)).getPageCount(),96);
  const pdfjs=await import("pdfjs-dist/legacy/build/pdf.mjs"),document=await pdfjs.getDocument({data:new Uint8Array(rendered.content),disableWorker:true}).promise;
  const page82=await document.getPage(82),page83=await document.getPage(83),text82=await page82.getTextContent(),text83=await page83.getTextContent(),synthetic=text83.items.find(x=>x.str.includes("SYNTHETIC PAGE 83"));
  assert.doesNotMatch(text82.items.map(x=>x.str).join(" "),/SYNTHETIC/);assert.ok(synthetic);assert.ok(synthetic.transform[4]>59&&synthetic.transform[4]<63);assert.ok(synthetic.transform[5]>620&&synthetic.transform[5]<630);
  assert.ok((await page83.getOperatorList()).fnArray.length>(await page82.getOperatorList()).fnArray.length,"checkbox and highlight add visible page drawing operators");
});

test("viewport zoom normalizes to identical page coordinates",()=>{
  assert.deepEqual(normalizeOverlayRect({left:60,top:160,width:180,height:40},{width:600,height:800}),normalizeOverlayRect({left:120,top:320,width:360,height:80},{width:1200,height:1600}));
});

test("resized dimensions and text font size survive version-data round trip",()=>{
  const resized={id:"resized-text",type:"text",page:83,x:.125,y:.25,width:.173,height:.027,text:"synthetic",fontSize:.009,color:"black"};
  const saved=JSON.parse(JSON.stringify(validatePdfOverlays([resized],96)));
  assert.deepEqual(saved,[resized]);
  assert.deepEqual(validatePdfOverlays(saved,96),[resized]);
});

test("overlay validation fails closed and audit summary excludes text values",()=>{
  const element={id:"note-1",type:"note",page:1,x:.1,y:.1,width:.3,height:.1,text:"AUDIT MUST NOT CONTAIN THIS",fontSize:.02,color:"blue"};
  const valid=validatePdfOverlays([element],1),summary=summarizePdfOverlays(valid);
  assert.equal(summary.elementCount,1);assert.equal(JSON.stringify(summary).includes(element.text),false);
  assert.throws(()=>validatePdfOverlays([{...element,type:"signature"}],1),/pdf_overlay_type_invalid/);
  assert.throws(()=>validatePdfOverlays([{...element,page:2}],1),/pdf_overlay_page_invalid/);
  assert.throws(()=>validatePdfOverlays([{...element,x:.9,width:.2}],1),/pdf_overlay_coordinates_invalid/);
  assert.throws(()=>validatePdfOverlays([{...element,unexpected:true}],1),/pdf_overlay_property_invalid/);
});

test("AcroForm remains editable together with universal overlays",async()=>{
  const pdf=await PDFDocument.create(),page=pdf.addPage([600,800]),form=pdf.getForm();form.createTextField("Synthetic.Name").addToPage(page,{x:30,y:700,width:200,height:24});const source=Buffer.from(await pdf.save());
  const inspection=await inspectPdfAcroForm(source);assert.equal(inspection.editable,true);assert.equal(inspection.signatureFieldCount,0);
  const filled=await fillPdfAcroForm(source,{"Synthetic.Name":"SYNTHETIC ACROFORM"}),rendered=await renderPdfOverlays(filled.content,[{id:"mark",type:"mark",page:1,x:.1,y:.3,width:.04,height:.04,mark:"check",color:"black"}]),saved=await PDFDocument.load(rendered.content);
  assert.equal(saved.getForm().getTextField("Synthetic.Name").getText(),"SYNTHETIC ACROFORM");
});
