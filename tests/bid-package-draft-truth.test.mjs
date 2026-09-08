import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {generateBidPackageDocuments} from '../platform/bid-package-documents.mjs';
import {parseBinaryDocument} from '../platform/binary-parsers.mjs';
const id=()=>crypto.randomUUID();
test('real generated draft files carry current price but never claim submission readiness',async()=>{
 const context={id:id(),tender_id:id(),company_id:id(),title:'SYNTHETIC tender',buyer:'SYNTHETIC buyer',legal_name:'SYNTHETIC company',tender_version_id:id(),calculation_id:id(),calculation_version:1,version:1,lot_key:'L1',created_at:'2026-09-08T00:00:00Z',totals:{totalPrice:2000,db1:100,db2:80,db3:50,profit:50},payload:{},manifest:{}},blobs=[],audits=[];
 const client={query:async(sql,args=[])=>{
  if(sql.includes('FROM tender.bid_packages bp'))return {rows:[context]};
  if(sql.includes('FROM tender.requirements'))return {rows:[{category:'EVIDENCE',requirement:'SYNTHETIC mandatory certificate',mandatory:true,status:'OPEN'}]};
  if(sql.includes('FROM tender.company_profiles'))return {rows:[{parameters:{}}]};
  if(sql.startsWith('SELECT')&&sql.includes('generated_documents'))return {rows:[]};
  if(sql.startsWith('SELECT')&&sql.includes('document_templates'))return {rows:[{id:id()}]};
  if(sql.startsWith('INSERT INTO tender.document_blobs')){blobs.push({hash:args[0],buffer:args[1],type:args[3]});return {rows:[]};}
  if(sql.startsWith('INSERT INTO tender.generated_documents'))return {rows:[{id:id(),category:args[15],version:1,format:args[5],status:'INTERNAL_DRAFT_READY',sha256:args[7],output_size_bytes:args[13]}]};
  if(sql.startsWith('UPDATE tender.bid_packages'))return {rows:[{...context,status:args[1],manifest:JSON.parse(args[2]),missing_items:JSON.parse(args[4])}]};
  if(sql.includes('INSERT INTO tender.audit_events')){audits.push(sql);return {rows:[]};}
  throw new Error('unexpected query');
 }};
 const result=await generateBidPackageDocuments(client,{bidPackageId:context.id,createdBy:id()});
 assert.equal(result.documents.length,5);assert.equal(result.draftsComplete,true);assert.equal(result.packageComplete,false);assert.equal(result.bidPackage.status,'BID_PACKAGE_INCOMPLETE');assert.ok(result.missing.includes('SUBMISSION_DOCUMENT_REVIEW_REQUIRED'));assert.equal(result.bidPackage.manifest.documentGeneration.submissionReady,false);
 assert.ok(audits.every(sql=>!sql.includes("'PACKAGE_COMPLETE'")));
 const price=result.documents.find(x=>x.category==='PRICE_SHEET'),blob=blobs.find(x=>x.hash===price.sha256);
 const parsed=await parseBinaryDocument({buffer:blob.buffer,name:'SYNTHETIC-price.xlsx',mediaType:blob.type});
 const row=parsed.worksheets[0].rows.find(x=>x.cells.some(cell=>cell.value==='Angebotspreis_netto'));
 assert.equal(row.cells[1].value,'2000');
});
