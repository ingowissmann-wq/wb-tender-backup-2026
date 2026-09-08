import test from 'node:test';
import assert from 'node:assert/strict';
import {addSourceConfirmedRequirements,reviewDocumentRequirements,documentReviewPages} from '../platform/tenant-document-review.mjs';
const file={id:'11111111-1111-4111-8111-111111111111',filename:'Vergabeunterlagen.pdf',parsed:{pages:[{page:2,text:'Das Sicherheitskonzept ist vollständig mit dem Angebot einzureichen.'}]}};
const addition={fileId:file.id,page:2,title:'Sicherheitskonzept',quote:'Das Sicherheitskonzept ist vollständig mit dem Angebot einzureichen.'};
test('manual obligations require exact evidence from the selected source file and page',()=>{
 const a=addSourceConfirmedRequirements([], [addition], [file], 'L1');
 assert.deepEqual(a,addSourceConfirmedRequirements([], [addition], [file], 'L1'));
 assert.equal(a[0].sourcePage,2);assert.equal(a[0].status,'MISSING');
 assert.throws(()=>addSourceConfirmedRequirements([],[{...addition,quote:'Eine erfundene Leistung ist zusätzlich erforderlich.'}],[file],'L1'),/quote_not_in_source/);
 assert.throws(()=>addSourceConfirmedRequirements([],[{...addition,page:3}],[file],'L1'),/quote_not_in_source/);
 assert.throws(()=>addSourceConfirmedRequirements([],[addition],[],'L1'),/source_file_required/);
 assert.throws(()=>addSourceConfirmedRequirements(a,[addition],[file],'L1'),/duplicate_requirement/);
});
test('every obligation needs an explicit reason and validated evidence cannot omit the file',()=>{
 const requirements=addSourceConfirmedRequirements([],[addition],[file],'L1');
 const decision={key:requirements[0].requirementKey,status:'VALIDATED',fileId:file.id,reason:'Konzept vollständig fachlich geprüft.'};
 assert.equal(reviewDocumentRequirements(requirements,[decision])[0].evidenceFileId,file.id);
 assert.throws(()=>reviewDocumentRequirements(requirements,[]),/all_requirements/);
 assert.throws(()=>reviewDocumentRequirements(requirements,[{...decision,fileId:null}]),/evidence_required/);
 assert.throws(()=>reviewDocumentRequirements(requirements,[{...decision,reason:'ok'}]),/decision_invalid/);
 assert.equal(reviewDocumentRequirements(requirements,[{...decision,status:'NOT_REQUIRED'}])[0].evidenceFileId,null);
});

test('structured document text retains content without inventing a printed page',()=>{
 assert.deepEqual(documentReviewPages({type:'DOCX',paragraphs:[{text:'Eine Pflicht'}],headers:[],footers:[]}),[{page:null,text:'Eine Pflicht'}]);
 assert.deepEqual(documentReviewPages({type:'CSV',rows:[['Beleg','Pflicht']]}),[{page:null,text:'Beleg Pflicht'}]);
 assert.deepEqual(documentReviewPages({type:'XLSX',worksheets:[{rows:[{cells:[{value:'C23 Pflicht'}]}]}]}),[{page:null,text:'C23 Pflicht'}]);
 assert.throws(()=>addSourceConfirmedRequirements([],[{...addition,page:'2'}],[file],'L1'),/addition_invalid/);
});
