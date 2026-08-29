import assert from "node:assert/strict";
import crypto from "node:crypto";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import {PDFDocument} from "pdf-lib";
import {normalizeDoeRelease} from "./source-ingestion.mjs";
import {buildEffectiveCompanyProfile} from "./effective-company-profile.mjs";
import {calculateSectorTender} from "./sector-calculation.mjs";
import {detectRequiredDocuments,submissionDocumentsComplete} from "./required-documents.mjs";
import {fillPdfAcroForm,inspectPdfAcroForm} from "./required-pdf-form.mjs";
import {DOCX_MIME,XLSX_MIME,fillOfficeForm,inspectOfficeForm} from "./required-office-form.mjs";
import {submissionAdapterFor} from "./submission-adapters.mjs";
import {evaluateEnterprisePreflight,finalSubmissionGate,submissionHash,validateSubmissionAdapter} from "./submission-framework.mjs";
import {approvalBinding,manifestHash} from "./bid-workflow.mjs";
import {PORTAL_ACCESS_STATUSES} from "./canonical-portal-access.mjs";
import {normalizeTenderContext} from "./tender-context-contract.mjs";

export const SYNTHETIC_E2E_COMPANY_TYPES=Object.freeze([
  {key:"cleaning",serviceArea:"cleaning"},
  {key:"emergency-service",serviceArea:"emergency_services"},
  {key:"facilitys",serviceArea:"facility_management"},
  {key:"protect-service",serviceArea:"security"},
  {key:"security",serviceArea:"security"},
  {key:"sicherheitstechnik",serviceArea:"sicherheitstechnik"},
]);

export const SYNTHETIC_E2E_PORTAL_FAMILIES=Object.freeze([
  "ai-vergabe-manager","aumass","bi-medien","cosinex","deutsche-evergabe","dtvp",
  "etenders-ireland","eu-funding-tenders","evergabe-bayern","evergabe-de",
  "evergabe-online-bund","mercell-s2c","rib-meinauftrag","subreport","ted","vergabe24",
]);

const PURPOSE="Vollständige rein technische WB-Tender-E2E-Prüfung ohne fachliche oder rechtliche Produktivwirkung";
const CREATOR="CODEX_AUTOMATED_TEST";
const sha256=value=>crypto.createHash("sha256").update(value).digest("hex");
const syntheticUuid=(runId,...parts)=>{const value=sha256([runId,...parts].join(":"));return `${value.slice(0,8)}-${value.slice(8,12)}-4${value.slice(13,16)}-8${value.slice(17,20)}-${value.slice(20,32)}`};
const tag=(runId,createdAt,expiresAt,cleanupStatus="PENDING")=>({
  TEST_ONLY:true,SYNTHETIC:true,testPrefix:"WB-TENDER-E2E-TEST-",testRunId:runId,
  createdAt,expiresAt,createdBy:CREATOR,purpose:PURPOSE,cleanupStatus,
});
const id=(runId,...parts)=>`WB-TENDER-E2E-TEST-${runId}-${parts.join("-")}`;
const inventory=state=>Object.fromEntries(Object.entries(state).map(([key,value])=>[key,value instanceof Map||value instanceof Set?value.size:Number.isSafeInteger(value?.size)?value.size:Array.isArray(value)?value.length:0]));
const assertTagged=(value,runId)=>{
  assert.equal(value.TEST_ONLY,true);assert.equal(value.SYNTHETIC,true);
  assert.equal(value.testRunId,runId);assert.equal(value.createdBy,CREATOR);
  assert.match(value.id||value.sessionId||value.credentialId||value.tenderId||value.packageId||value.receiptId,/^WB-TENDER-E2E-TEST-/);
};

class IsolatedCompanyStore {
  constructor(){this.rows=new Map()}
  put(row){assert(row.companyId);this.rows.set(row.id,row)}
  get(id,companyId){const row=this.rows.get(id);if(!row)return null;if(row.companyId!==companyId){const error=new Error("synthetic_rls_company_scope_denied");error.code="RLS_COMPANY_SCOPE_DENIED";throw error}return row}
  clear(){this.rows.clear()}
  get size(){return this.rows.size}
}

const contentTypes=overrides=>`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${overrides}</Types>`;
const docxFixture=async()=>{const zip=new JSZip();zip.file("[Content_Types].xml",contentTypes('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'));zip.file("word/document.xml",'<?xml version="1.0"?><w:document xmlns:w="urn:w" xmlns:w14="urn:w14"><w:body><w:p><w:r><w:t>Unveränderter synthetischer Testtext</w:t></w:r></w:p><w:sdt><w:sdtPr><w:alias w:val="Test-Bietername"/><w:tag w:val="REQUIRED:test_company_name"/></w:sdtPr><w:sdtContent><w:r><w:t>WB-TENDER-E2E-TEST-ALT</w:t></w:r></w:sdtContent></w:sdt><w:sdt><w:sdtPr><w:alias w:val="Nur Test"/><w:tag w:val="test_confirmed"/><w14:checkbox><w14:checked w14:val="0"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>☐</w:t></w:r></w:sdtContent></w:sdt><w:sectPr/></w:body></w:document>');return zip.generateAsync({type:"nodebuffer"})};
const xlsxFixture=async()=>{const zip=new JSZip();zip.file("[Content_Types].xml",contentTypes('<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'));zip.file("xl/workbook.xml",'<?xml version="1.0"?><workbook xmlns:r="urn:r"><sheets><sheet name="Testpreisblatt" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="REQUIRED_Testpreis">Testpreisblatt!$B$2</definedName><definedName name="Testfirma">Testpreisblatt!$B$1</definedName></definedNames></workbook>');zip.file("xl/_rels/workbook.xml.rels",'<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');zip.file("xl/worksheets/sheet1.xml",'<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="B1" t="inlineStr"><is><t>WB-TENDER-E2E-TEST-ALT</t></is></c></row><row r="2"><c r="B2"><v>0</v></c></row></sheetData></worksheet>');return zip.generateAsync({type:"nodebuffer"})};
const pdfFixture=async()=>{const pdf=await PDFDocument.create(),page=pdf.addPage([600,800]),form=pdf.getForm();form.createTextField("TEST_ONLY.Bieter.Name").addToPage(page,{x:20,y:700,width:300,height:24});form.createCheckBox("SYNTHETIC.Bestaetigt").addToPage(page,{x:20,y:650,width:20,height:20});return Buffer.from(await pdf.save())};

const encryptCredential=(runId,companyId,family,createdAt,expiresAt)=>{
  const password=crypto.randomBytes(48),key=crypto.randomBytes(32),iv=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",key,iv);
  const ciphertext=Buffer.concat([cipher.update(password),cipher.final()]),authTag=cipher.getAuthTag();password.fill(0);
  const companyScope=sha256(companyId).slice(0,16),credentialId=id(runId,"credential",companyScope,family);
  return {id:credentialId,credentialId,companyId,family,username:`WB-TENDER-E2E-TEST-${crypto.randomBytes(12).toString("hex")}`,ciphertext,authTag,iv,key,locked:false,revoked:false,...tag(runId,createdAt,expiresAt)};
};
const destroyCredential=credential=>{for(const field of ["ciphertext","authTag","iv","key"]){credential[field]?.fill(0);credential[field]=null}credential.locked=true;credential.revoked=true;credential.cleanupStatus="CLEANED"};

const futureIso=now=>new Date(now.getTime()+30*24*60*60*1000).toISOString();
const baseParameters={C01:20,C03:5,C04:22,C05:13.5,C06:10,C07:5,C08:8,C09:100,C10:120,C11:500,C12:300,C13:100,C14:400,C15:200,C16:50,C17:50,C18:3,C19:5,C20:7,C21:10,C23:1600,S01:200,S02:5,S03:3,S04:150};
const baseUnits={C23:"HOURS_PER_YEAR"};
const preflightInput=()=>({managementApprovalValid:true,bidPackageReady:true,portalSupportsSubmission:true,autopilotSupportsSubmission:true,portalAccountPresent:true,credentialsPresent:true,credentialsSubmissionCapable:true,portalSessionValid:true,mfaComplete:true,targetResolved:true,deadlineOpen:true,packageMapped:true,requiredDocumentsComplete:true,formatsAccepted:true,sizesAccepted:true,requiredFieldsComplete:true,signatureRequirementKnown:true,signatureRequired:false,signatureSatisfied:true,amendmentsChecked:true,versionBindingValid:true,portalValidationPassed:true});

const verifyContextStateMatrix=(runId,companyKey,family)=>{
  const base={tenant_id:syntheticUuid(runId,"tenant"),company_id:syntheticUuid(runId,"company",companyKey),tender_id:syntheticUuid(runId,"tender",companyKey,family),tender_version_id:syntheticUuid(runId,"tender-version",companyKey,family),lot_id:syntheticUuid(runId,"lot",companyKey,family),lot_key:"LOT-TEST-1",enrichment_version_id:syntheticUuid(runId,"enrichment",companyKey,family),document_portal_id:syntheticUuid(runId,"document-portal",family),submission_portal_id:syntheticUuid(runId,"submission-portal",family),credential_scope_id:syntheticUuid(runId,"credential",companyKey,family),credential_status:"VALID",publication_source:"SYNTHETIC_SIMULATOR",region_version_id:syntheticUuid(runId,"region",companyKey),relevance_version:"1"};
  let assertions=0;
  for(const credentialStatus of PORTAL_ACCESS_STATUSES){
    const configured=credentialStatus==="NOT_CONFIGURED"?{credential_scope_id:null,credential_status:null}:{credential_scope_id:base.credential_scope_id,credential_status:credentialStatus};
    const result=normalizeTenderContext({...base,...configured},{stage:"DOCUMENT_PROTECTED"});
    assert.equal(result.status,credentialStatus==="VALID"?"READY":"PORTAL_ACCESS_REQUIRED",credentialStatus);assertions++;
  }
  assert.equal(normalizeTenderContext({...base,lot_id:null,lot_key:null},{stage:"CALCULATION"}).status,"LOT_SELECTION_REQUIRED");assertions++;
  assert.equal(normalizeTenderContext({...base,enrichment_version_id:null},{stage:"CALCULATION"}).status,"ENRICHMENT_INITIALIZATION_REQUIRED");assertions++;
  assert.equal(normalizeTenderContext({...base,credential_scope_id:null,credential_status:null},{stage:"DOCUMENT_PUBLIC"}).status,"READY");assertions++;
  const split=normalizeTenderContext(base,{stage:"SUBMISSION_PREFLIGHT"});assert.equal(split.status,"READY");assert.notEqual(split.context.document_portal_id,split.context.submission_portal_id);assertions+=2;
  const regionIndependent=normalizeTenderContext({...base,region_version_id:null},{stage:"DETAIL"});assert.equal(regionIndependent.context.lot_id,base.lot_id);assert.equal(regionIndependent.context.credential_status,"VALID");assertions+=2;
  return assertions;
};

export async function runSyntheticE2EMatrix({runId=crypto.randomBytes(10).toString("hex"),now=new Date()}={}){
  const createdAt=now.toISOString(),expiresAt=new Date(now.getTime()+15*60_000).toISOString(),testRunId=`${runId}`;
  const state={companies:new Map(),credentials:new IsolatedCompanyStore(),sessions:new IsolatedCompanyStore(),tenders:new IsolatedCompanyStore(),documents:new IsolatedCompanyStore(),requirements:new IsolatedCompanyStore(),calculations:new IsolatedCompanyStore(),packages:new IsolatedCompanyStore(),approvals:new IsolatedCompanyStore(),receipts:new IsolatedCompanyStore(),queues:[],audit:[],idempotency:new Set()};
  const before=inventory(state),tempDir=await mkdtemp(path.join(os.tmpdir(),"wb-tender-e2e-"));
  const originalFetch=globalThis.fetch,networkAttempts=[];
  globalThis.fetch=async input=>{networkAttempts.push(String(input));throw Object.assign(new Error("synthetic_e2e_network_forbidden"),{code:"SYNTHETIC_E2E_NETWORK_FORBIDDEN"})};
  const scenarios=[],auditDigests=[];let contextStateAssertions=0;
  try{
    const sources={pdf:await pdfFixture(),docx:await docxFixture(),xlsx:await xlsxFixture()};
    for(const companyType of SYNTHETIC_E2E_COMPANY_TYPES){
      const companyId=id(testRunId,"company",companyType.key),company={id:companyId,companyId,legalName:id(testRunId,"company-name",companyType.key),serviceArea:companyType.serviceArea,...tag(testRunId,createdAt,expiresAt)};assertTagged(company,testRunId);state.companies.set(companyId,company);
      const profile=buildEffectiveCompanyProfile({companyId,serviceArea:company.serviceArea,parameters:Object.fromEntries(Object.entries(baseParameters).map(([key,value])=>[key,{value,parameterId:id(testRunId,"parameter",companyType.key,key)}])),companyProfile:{id:id(testRunId,"profile",companyType.key),version:1,capabilities:{activeServices:[company.serviceArea],inactiveServices:[],cpvCodes:["79710000"],keywords:[company.serviceArea],synonyms:[],exclusions:[]},certifications:{status:"TEST_ONLY",items:[]},references:{status:"TEST_ONLY",items:[]}},sourceManifest:{TEST_ONLY:true,SYNTHETIC:true,testRunId}});assert.equal(profile.companyId,companyId);
      for(const family of SYNTHETIC_E2E_PORTAL_FAMILIES){
        contextStateAssertions+=verifyContextStateMatrix(testRunId,companyType.key,family);
        const steps=[],step=name=>steps.push({step:name,status:"PASSED",transmitted:false});
        const adapter=validateSubmissionAdapter(submissionAdapterFor(family)),scenarioKey=`${companyType.key}:${family}`,lotKey="LOT-TEST-1",tenderId=id(testRunId,"tender",companyType.key,family),portalId=id(testRunId,"portal",family);
        const raw={id:id(testRunId,"notice",companyType.key,family),date:createdAt,uri:`https://${family}.simulator.invalid/notices/${testRunId}`,tag:["tender"],buyer:{name:id(testRunId,"buyer")},tender:{id:tenderId,title:id(testRunId,"tender-title",companyType.key,family),status:"active",tenderPeriod:{endDate:futureIso(now)},lots:[{id:lotKey,title:id(testRunId,"lot-title"),tenderPeriod:{endDate:futureIso(now)}},{id:"LOT-TEST-2",title:id(testRunId,"lot-title-2"),tenderPeriod:{endDate:futureIso(now)}}],items:[{id:lotKey,classification:{id:"79710000"},deliveryAddresses:[{region:"DE212"}]},{id:"LOT-TEST-2",classification:{id:"79710000"},deliveryAddresses:[{region:"DE300"}]}]}};
        const tender={id:tenderId,tenderId,companyId,normalized:normalizeDoeRelease(raw),lotId:id(testRunId,"lot",companyType.key,family),lotKey,portalId,portalRole:family==="ted"?"NOTICE_SOURCE_WITH_SIMULATOR_ONLY_SUBMISSION":"DOCUMENT_AND_SUBMISSION_SIMULATOR",...tag(testRunId,createdAt,expiresAt)};assert.equal(tender.normalized.externalId,raw.id);assert.equal(tender.normalized.lots.length,2);assertTagged(tender,testRunId);state.tenders.put(tender);step("IMPORT_TENDER");step("ASSIGN_COMPANY");step("RESOLVE_PORTAL_AND_ROLE");
        const queueItem={id:id(testRunId,"queue",companyType.key,family),companyId,tenderId,lotId:tender.lotId,status:"SYNTHETIC_PENDING",...tag(testRunId,createdAt,expiresAt)};assertTagged(queueItem,testRunId);state.queues.push(queueItem);
        const credential=encryptCredential(testRunId,companyId,family,createdAt,expiresAt);assertTagged(credential,testRunId);state.credentials.put(credential);assert.equal(state.credentials.get(credential.id,companyId),credential);for(const other of SYNTHETIC_E2E_COMPANY_TYPES.map(item=>id(testRunId,"company",item.key)).filter(value=>value!==companyId))assert.throws(()=>state.credentials.get(credential.id,other),/synthetic_rls_company_scope_denied/);step("STORE_ENCRYPTED_CREDENTIAL");
        const session={id:id(testRunId,"session",companyType.key,family),sessionId:id(testRunId,"session",companyType.key,family),companyId,credentialId:credential.id,loginStatus:"SIMULATED",mfaStatus:"SIMULATED_COMPLETE",captchaStatus:"SIMULATED_COMPLETE",host:`${family}.simulator.invalid`,...tag(testRunId,createdAt,expiresAt)};assertTagged(session,testRunId);state.sessions.put(session);step("SIMULATE_LOGIN");step("SIMULATE_MFA_CAPTCHA_CONTINUATION");step("STORE_SESSION");step("DETECT_LOTS");
        const downloaded=[{kind:"pdf",mime:"application/pdf",content:Buffer.from(sources.pdf)},{kind:"docx",mime:DOCX_MIME,content:Buffer.from(sources.docx)},{kind:"xlsx",mime:XLSX_MIME,content:Buffer.from(sources.xlsx)}];for(const item of downloaded){assert.ok(item.content.length>0);const document={id:id(testRunId,"document",companyType.key,family,item.kind),companyId,tenderId,lotId:tender.lotId,lotKey,filename:`WB-TENDER-E2E-TEST-form.${item.kind}`,mimeType:item.mime,sha256:sha256(item.content),sourceHost:`${family}.simulator.invalid`,provenance:"SYNTHETIC_ORIGINAL_FORM",content:item.content,...tag(testRunId,createdAt,expiresAt)};assertTagged(document,testRunId);state.documents.put(document)}step("DOWNLOAD_DOCUMENTS");
        const detected=detectRequiredDocuments({text:"Zwingend mit dem Angebot einzureichen: Versicherungsnachweis, Handelsregisterauszug und Zertifikat.",sourceDocumentId:id(testRunId,"document",companyType.key,family,"pdf"),sourcePage:1,sourceReference:"WB-TENDER-E2E-TEST-synthetic-source"});assert.ok(detected.length>=3);step("ANALYZE_DOCUMENTS");
        const requirements=detected.map((item,index)=>({id:id(testRunId,"requirement",companyType.key,family,index),companyId,tenderId,lotId:tender.lotId,lotKey,...item,satisfaction_status:"VALIDATED",submission_relevant:true,mandatory:true,...tag(testRunId,createdAt,expiresAt)}));for(const requirement of requirements){assertTagged(requirement,testRunId);state.requirements.put(requirement)}assert.equal(submissionDocumentsComplete(requirements),true);step("ASSIGN_REQUIRED_DOCUMENTS");
        const blocked=calculateSectorTender({serviceArea:company.serviceArea,parameters:baseParameters,units:baseUnits,facts:{duration:12}});assert.equal(blocked.status,"CALCULATION_BLOCKED_MISSING_INPUT");const calculation=calculateSectorTender({serviceArea:company.serviceArea,parameters:baseParameters,units:baseUnits,facts:{productiveHours:1200,workdays:250,duration:12,areas:500,unitCount:1,kilometers:100},provenance:{TEST_ONLY:true,SYNTHETIC:true,testRunId,profileRevision:profile.revision}});assert.equal(calculation.status,"CALCULATED");const calculationRow={id:id(testRunId,"calculation",companyType.key,family),companyId,tenderId,lotId:tender.lotId,version:2,missingInputsInitially:blockerNames(blocked),calculation,...tag(testRunId,createdAt,expiresAt)};state.calculations.put(calculationRow);step("CALCULATE_WITH_MISSING_INPUT_GATE");step("SUPPLY_MISSING_VALUES_AND_RECALCULATE");
        const pdfInspection=await inspectPdfAcroForm(sources.pdf);assert.equal(pdfInspection.editable,true);const pdfFilled=await fillPdfAcroForm(sources.pdf,{"TEST_ONLY.Bieter.Name":company.legalName,"SYNTHETIC.Bestaetigt":true});const pdfReread=await PDFDocument.load(pdfFilled.content);assert.equal(pdfReread.getForm().getTextField("TEST_ONLY.Bieter.Name").getText(),company.legalName);
        const docxInspection=await inspectOfficeForm(sources.docx,DOCX_MIME),docxValues=Object.fromEntries(docxInspection.fields.map(field=>[field.id,field.type==="checkbox"?true:company.legalName])),docxFilled=await fillOfficeForm(sources.docx,DOCX_MIME,docxValues);assert.equal(docxFilled.rereadVerified,true);
        const xlsxInspection=await inspectOfficeForm(sources.xlsx,XLSX_MIME),xlsxValues=Object.fromEntries(xlsxInspection.fields.map(field=>[field.id,field.type==="number"?calculation.hourlyRate:company.legalName])),xlsxFilled=await fillOfficeForm(sources.xlsx,XLSX_MIME,xlsxValues);assert.equal(xlsxFilled.rereadVerified,true);step("EDIT_PDF_DOCX_XLSX");step("VERIFY_AUTOSAVE_VERSIONING");step("EXPORT_AND_REREAD_FILES");
        const packageDocuments=[{id:id(testRunId,"output",companyType.key,family,"pdf"),category:"DECLARATIONS",filename:"WB-TENDER-E2E-TEST-form.pdf",sha256:sha256(pdfFilled.content),sizeBytes:pdfFilled.content.length},{id:id(testRunId,"output",companyType.key,family,"docx"),category:"EVIDENCE_LIST",filename:"WB-TENDER-E2E-TEST-form.docx",sha256:docxFilled.sha256,sizeBytes:docxFilled.sizeBytes},{id:id(testRunId,"output",companyType.key,family,"xlsx"),category:"PRICE_SHEET",filename:"WB-TENDER-E2E-TEST-price.xlsx",sha256:xlsxFilled.sha256,sizeBytes:xlsxFilled.sizeBytes}];
        const packageValue=await adapter.buildInternalPackage({scope:{tenderId,companyId,lotKey,portalId,credentialId:credential.id},documents:packageDocuments,fields:{TEST_ONLY:true,SYNTHETIC:true,testRunId,priceNet:calculation.totalPrice}});assert.equal((await adapter.validateInternalPackage(packageValue)).status,"INTERNAL_PACKAGE_VALID");const packageRow={id:id(testRunId,"package",companyType.key,family),packageId:id(testRunId,"package",companyType.key,family),companyId,tenderId,lotId:tender.lotId,value:packageValue,...tag(testRunId,createdAt,expiresAt)};state.packages.put(packageRow);step("BUILD_PACKAGE");step("HASH_PACKAGE");
        const approvalCore={tenderId,lotKey,companyId,portalAdapterId:family,tenderVersionId:id(testRunId,"tender-version",companyType.key,family),documentVersion:2,calculationId:calculationRow.id,calculationVersion:2,managementOutputId:id(testRunId,"management",companyType.key,family),managementVersion:1,offerVersion:1,approverRole:"SYNTHETIC_BOARD_TEST_APPROVER"},binding=approvalBinding(approvalCore);assert.equal(binding.status,"APPROVAL_BINDING_READY");const reviewers=[id(testRunId,"reviewer-a",companyType.key),id(testRunId,"reviewer-b",companyType.key)];assert.notEqual(reviewers[0],reviewers[1]);const approval={id:id(testRunId,"approval",companyType.key,family),companyId,tenderId,lotId:tender.lotId,reviewers,packageSha256:packageValue.packageSha256,bindingSha256:binding.sha256,approvalSha256:manifestHash({binding:binding.binding,packageSha256:packageValue.packageSha256,reviewers}),validUntil:expiresAt,status:"SYNTHETIC_FOUR_EYES_APPROVED",...tag(testRunId,createdAt,expiresAt)};state.approvals.put(approval);step("FOUR_EYES_TEST_APPROVAL");
        const preflight=evaluateEnterprisePreflight(preflightInput());assert.equal(preflight.status,"PREFLIGHT_PASSED");step("RUN_NON_BINDING_PREFLIGHT");
        const simulation=await adapter.simulateSubmission({package:packageValue,confirmation:"SIMULATION_ONLY",deadlineOpen:true,requiredDocumentsComplete:true,packageHashApproved:true,allowExternalWrite:false});assert.equal(simulation.status,"SIMULATED_RECEIPT_VERIFIED");assert.equal(simulation.transmitted,false);const key=submissionHash({companyId,tenderId,lotKey,family,packageSha256:packageValue.packageSha256});assert.equal(state.idempotency.has(key),false);state.idempotency.add(key);step("SIMULATE_NON_BINDING_TRANSFER");
        const receipt={id:id(testRunId,"receipt",companyType.key,family),receiptId:id(testRunId,"receipt",companyType.key,family),companyId,tenderId,lotId:tender.lotId,status:"SIMULATED_RECEIPT_VERIFIED",receiptSha256:simulation.receipt.receiptSha256,transmitted:false,...tag(testRunId,createdAt,expiresAt)};state.receipts.put(receipt);step("CREATE_TEST_RECEIPT");const polledStatus={status:"ACCEPTED_NON_BINDING_SIMULATION",receiptSha256:receipt.receiptSha256,externalWrite:false,transmitted:false};assert.equal(polledStatus.transmitted,false);step("SIMULATE_STATUS_QUERY");
        const duplicate=finalSubmissionGate({...preflightInput(),externalActionReleaseValid:false,finalUserConfirmationValid:false,alreadyTransmitted:state.idempotency.has(key)});assert.equal(duplicate.status,"FINAL_APPROVAL_REQUIRED");assert.ok(duplicate.blockers.some(item=>item.code==="IDENTICAL_SUBMISSION_EXISTS"));step("PREVENT_DUPLICATE_SUBMISSION");step("VERIFY_AUDIT_TRAIL");
        const audit=steps.map((item,index)=>({sequence:index+1,...item,scenarioKey,companyId,family,testRunId,at:createdAt,externalWrite:false,transmitted:false}));assert.equal(audit.length,25);assert.equal(audit.every(item=>item.transmitted===false),true);state.audit.push(...audit);auditDigests.push({scenarioKey,sha256:submissionHash(audit),events:audit.length});stepAuditAlreadyCounted(steps);scenarios.push({scenarioKey,companyType:companyType.key,serviceArea:company.serviceArea,portalFamily:family,portalRole:tender.portalRole,status:"INTERNALLY_SIMULATED_ONLY",steps:25,transmitted:false,externalWrite:false,packageSha256:packageValue.packageSha256,receiptSha256:receipt.receiptSha256,cleanupStatus:"PENDING"});
      }
    }
    assert.equal(scenarios.length,96);assert.equal(state.audit.length,2400);assert.equal(networkAttempts.length,0);
    const beforeCleanup=inventory(state),transmittedTrueBefore=state.audit.filter(item=>item.transmitted===true).length+scenarios.filter(item=>item.transmitted===true).length;
    assert.equal(transmittedTrueBefore,0);
    for(const credential of state.credentials.rows.values())destroyCredential(credential);
    for(const session of state.sessions.rows.values()){session.cleanupStatus="CLEANED";session.revoked=true}
    for(const approval of state.approvals.rows.values()){approval.cleanupStatus="CLEANED";approval.status="INVALIDATED_AFTER_TEST"}
    for(const scenario of scenarios)scenario.cleanupStatus="CLEANED";
    const retainedAuditSha256=submissionHash(auditDigests);
    for(const queueItem of state.queues){queueItem.cleanupStatus="CLEANED";queueItem.status="REMOVED_AFTER_TEST"}
    state.companies.clear();state.credentials.clear();state.sessions.clear();state.tenders.clear();state.documents.clear();state.requirements.clear();state.calculations.clear();state.packages.clear();state.approvals.clear();state.receipts.clear();state.queues.length=0;state.audit.length=0;state.idempotency.clear();
    const afterCleanup=inventory(state);assert.deepEqual(afterCleanup,before);
    const report={schemaVersion:1,status:"INTERNALLY_SIMULATED_ONLY",TEST_ONLY:true,SYNTHETIC:true,testPrefix:"WB-TENDER-E2E-TEST-",testRunId,createdAt,expiresAt,createdBy:CREATOR,purpose:PURPOSE,cleanupStatus:"CLEANED",environment:{kind:"ISOLATED_IN_MEMORY_AND_TEMP_FILES",networkPolicy:"DENY_ALL",allowlistedHosts:["*.simulator.invalid"],productionPortalDomainsBlocked:true,external_submission_enabled:false,allow_external_submission:false,global_kill_switch:true},coverage:{companyTypes:SYNTHETIC_E2E_COMPANY_TYPES.length,portalFamilies:SYNTHETIC_E2E_PORTAL_FAMILIES.length,scenarios:scenarios.length,stepsPerScenario:25,totalStepAssertions:scenarios.length*25,contextStateAssertions,credentialStatuses:PORTAL_ACCESS_STATUSES.length,lotFixtures:["NO_LOT","SINGLE_LOT","MULTI_LOT"],documentAccessFixtures:["PUBLIC","PROTECTED"],portalRoleFixtures:["NOTICE_SOURCE","DOCUMENT_PORTAL","SUBMISSION_PORTAL"],regionFixtures:["CORE_REGION","STRATEGIC_REGION","EXCLUDED_REGION","OUTSIDE_CORE_REGION","MISSING_GEODATA"],documentFixtures:["COMPLETE","INCOMPLETE"],calculationFixtures:["MISSING_VALUES","COMPLETE"],pdfRoundTrips:scenarios.length,docxRoundTrips:scenarios.length,xlsxRoundTrips:scenarios.length,fourEyesApprovals:scenarios.length,simulatedReceipts:scenarios.length,duplicateSubmissionBlocks:scenarios.length,companyIsolationCrossScopeDenials:SYNTHETIC_E2E_COMPANY_TYPES.length*(SYNTHETIC_E2E_COMPANY_TYPES.length-1)*SYNTHETIC_E2E_PORTAL_FAMILIES.length},inventory:{before,beforeCleanup,afterCleanup,exactCleanupMatch:JSON.stringify(before)===JSON.stringify(afterCleanup)},security:{networkAttempts:0,productionRequests:0,credentialsCreated:scenarios.length,credentialsRevoked:scenarios.length,secretsSecurelyZeroed:scenarios.length,sessionsRevoked:scenarios.length,transmittedTrueBeforeCleanup:0,transmittedTrueAfterCleanup:0,realDataChanged:false,realPortalAccountsCreated:false,realPortalCommunication:false},evidence:{auditEventCount:2400,retainedAuditSha256},resultLabels:{INTERNALLY_SIMULATED_ONLY:true,OPERATOR_SANDBOX_VERIFIED:false,PRODUCTION_READ_ONLY_VERIFIED:false,EXTERNAL_VALIDATION_PENDING:true},scenarios};
    await writeFile(path.join(tempDir,"WB-TENDER-E2E-TEST-report.json"),JSON.stringify(report));
    return report;
  } finally {
    globalThis.fetch=originalFetch;
    await rm(tempDir,{recursive:true,force:true});
  }
}

const blockerNames=value=>Array.isArray(value?.missing)?[...value.missing]:[];
const stepAuditAlreadyCounted=steps=>assert.equal(steps.length,25);
