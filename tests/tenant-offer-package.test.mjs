import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import {verifyOfferPrice,offerPackageZip} from '../platform/tenant-offer-package.mjs';
const document={id:'11111111-1111-4111-8111-111111111111',sha256:'a'.repeat(64),parsed:{type:'XLSX',worksheets:[{name:'Preisblatt',rows:[{cells:[{address:'D28',value:2000}]}]}]}};
const binding={fileId:document.id,sheet:'Preisblatt',cell:'D28'};
test('offer price must match the current calculation in an exact literal document cell',()=>{
 assert.equal(verifyOfferPrice(document,binding,2000).value,2000);
 assert.throws(()=>verifyOfferPrice(document,binding,2001),/price_mismatch/);
 assert.throws(()=>verifyOfferPrice(document,{...binding,cell:'D29'},2000),/price_mismatch/);
 const formula=structuredClone(document);formula.parsed.worksheets[0].rows[0].cells[0].formula='SUM(A1:A2)';assert.throws(()=>verifyOfferPrice(formula,binding,2000),/price_mismatch/);
});
test('offer package contains exact verified files and a deterministic manifest without archive traversal',async()=>{
 const buffer=Buffer.from('SYNTHETIC approved evidence'),sha256=crypto.createHash('sha256').update(buffer).digest('hex');
 const files=[{id:document.id,filename:'../../fremd.txt',buffer,sha256}];
 const manifest={externalTransmission:false,files:[{id:document.id,sha256}]};
 const first=await offerPackageZip(manifest,files),second=await offerPackageZip(manifest,files);assert.deepEqual(first,second);
 const zip=await JSZip.loadAsync(first);assert.equal(await zip.file('Angebot/'+document.id+'-fremd.txt').async('string'),buffer.toString());assert.deepEqual(JSON.parse(await zip.file('Pruefnachweis.json').async('string')),manifest);
 await assert.rejects(offerPackageZip(manifest,[{...files[0],buffer:Buffer.from('changed')}]),/integrity_failed/);
});

test('denied package downloads return JSON without attempting ZIP serialization',async()=>{
 const {default:Fastify}=await import('fastify');const {registerTenantOfferPackageRoutes}=await import('../platform/tenant-offer-package-routes.mjs');
 const app=Fastify();registerTenantOfferPackageRoutes(app,{pool:{connect(){throw new Error('database_must_not_be_called_for_invalid_identifier')}},storage:null,authenticate:async req=>{req.identity={userId:'22222222-2222-4222-8222-222222222222',saas:{tenant_id:document.id,role:'OWNER',modules:['tender_autopilot'],access:{allowed:true},plan_code:'ENTERPRISE'}}},csrf:async()=>{}});
 try{const response=await app.inject({url:'/api/tenant-portal/packages/invalid/download'});assert.equal(response.statusCode,404);assert.match(response.headers['content-type'],/application\/json/);assert.equal(response.json().error,'offer_package_not_found');}finally{await app.close();}
});
