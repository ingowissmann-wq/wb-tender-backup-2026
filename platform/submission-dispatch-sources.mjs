import {TenantOfferPackage,offerPackageZip} from './tenant-offer-package.mjs';
import {loadTenderLinkEvidence} from './tender-link-evidence.mjs';
import {canonicalJson,liveSubmissionHash} from './submission-live-core.mjs';
import {bytesHash,requireDispatch,assertDispatchDocuments,assertFrozenDispatch} from './submission-dispatch-core.mjs';
import {loadCredentialKeyring,openPortalCredential} from './tenant-credential-vault.mjs';
import {credentialKey,decryptSecret} from './portal-credentials.mjs';
import {effectiveAccess,resolveModuleEntitlements,SUITE_PRODUCT_KEY,MODULE_KEYS} from './saas-catalog.mjs';

export async function nativeDispatchSource(db,context,packageId,storage){
 const actor=(await db.query("SELECT 1 FROM saas.tenant_memberships WHERE tenant_id=$1 AND user_id=$2 AND status='ACTIVE' AND role IN('OWNER','ADMIN')",[context.id,context.actorUserId])).rows[0];
 requireDispatch(actor,'submission_management_permission_required');
 const subscription=(await db.query('SELECT s.*,t.status tenant_status FROM saas.subscriptions s JOIN saas.tenants t ON t.id=s.tenant_id WHERE s.tenant_id=$1',[context.id])).rows[0];
 requireDispatch(subscription&&effectiveAccess(subscription).allowed,'submission_paid_access_required');
 const grants=(await db.query('SELECT module_key,enabled,source,starts_at,ends_at FROM saas.tenant_module_entitlements WHERE tenant_id=$1 AND starts_at<=now() AND (ends_at IS NULL OR ends_at>now())',[context.id])).rows;
 const suiteEnabled=Boolean((await db.query('SELECT 1 FROM saas.tenant_product_entitlements WHERE tenant_id=$1 AND product_key=$2 AND enabled AND starts_at<=now() AND (ends_at IS NULL OR ends_at>now())',[context.id,SUITE_PRODUCT_KEY])).rowCount);
 requireDispatch(resolveModuleEntitlements({planCode:subscription.plan_code,commercialScope:subscription.commercial_scope,suiteEnabled,grants}).includes(MODULE_KEYS.TENDER_AUTOPILOT),'submission_product_entitlement_required');
 const packages=new TenantOfferPackage(null,storage),row=await packages.current(db,context,packageId);
 const decision=(await db.query('SELECT * FROM tenant_portal.offer_package_decisions WHERE tenant_id=$1 AND package_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[context.id,packageId])).rows[0];
 requireDispatch(decision?.decision==='APPROVED'&&decision.manifest_sha256===row.manifest_sha256,'submission_package_management_approval_required');
 const source=(await db.query(`SELECT t.id tender_id,t.procurement_number,t.notice_number,t.title,t.source_lifecycle_status,w.id workspace_id,c.version calculation_version,c.result,a.company_id,a.lot_key,a.source_version_id,a.profile_id,l.offer_deadline,l.deadline_quality
 FROM tenant_portal.lot_calculation_versions c JOIN tenant_portal.lot_assignment_versions a ON a.tenant_id=c.tenant_id AND a.id=c.assignment_id
 JOIN tenant_portal.tender_workspaces w ON w.tenant_id=a.tenant_id AND w.id=a.workspace_id JOIN tender.tenders t ON t.id=w.public_tender_id
 JOIN tender.current_participation_eligible_lots l ON l.tender_id=t.id AND l.lot_key=a.lot_key WHERE c.tenant_id=$1 AND c.id=$2`,[context.id,row.calculation_id])).rows[0];
 requireDispatch(source&&source.company_id===row.manifest.companyId&&source.lot_key===row.manifest.lotKey,'submission_lot_or_company_changed');
 requireDispatch(source.source_lifecycle_status==='ACTIVE'&&source.deadline_quality==='EXACT'&&Date.parse(source.offer_deadline)>Date.now(),'submission_deadline_expired');
 const company=(await db.query('SELECT tender_company_id FROM saas.tenant_companies WHERE tenant_id=$1 AND id=$2',[context.id,source.company_id])).rows[0];requireDispatch(company,'submission_scope_changed');
 const evidence=(await loadTenderLinkEvidence(db,[source.tender_id])).get(source.tender_id);
 const target=evidence?.electronicSubmission?.url||evidence?.procurementPortal?.url;
 requireDispatch(target,'submission_portal_target_unresolved');
 let url;try{url=new URL(target)}catch{throw Object.assign(new Error('submission_portal_target_unresolved'),{code:'submission_portal_target_unresolved'})}
 const portals=(await db.query('SELECT * FROM tender.portal_registry WHERE canonical_domain=$1 OR $1=ANY(allowed_subdomains)',[url.hostname])).rows;
 requireDispatch(portals.length===1,'submission_portal_target_ambiguous');const portal=portals[0];
 requireDispatch(!['ted','ted-discovery','datenservice-oeffentlicher-einkauf'].includes(portal.adapter_id),'submission_publication_source_is_not_submission_portal');
 requireDispatch(source.procurement_number,'submission_portal_reference_required');
 const files=await packages.documents.files(db,context.id,row.manifest.files.map(f=>f.id));
 const documents=files.map(f=>({id:f.id,filename:f.filename,sha256:f.sha256,sizeBytes:Number(f.size_bytes),version:1,mediaType:f.media_type,buffer:f.buffer}));
 // Each native file ID is an immutable object; all bytes are re-read and checked.
 for(const d of documents){if(!Buffer.isBuffer(d.buffer))d.buffer=await storage.get(context.id,d.id);requireDispatch(bytesHash(d.buffer)===d.sha256,'submission_document_bytes_changed');}
 const archive=await offerPackageZip({...row.manifest,packageId:row.id,packageVersion:row.version,manifestHash:row.manifest_sha256,managementDecisionId:decision.id},documents);
 const metadata=documents.map(({buffer,...d})=>d);
 const binding={origin:'TENANT_PORTAL',sourceId:row.id,tenantId:context.id,companyId:source.company_id,canonicalCompanyId:company.tender_company_id||source.company_id,tenderId:source.tender_id,lotKey:source.lot_key,portalId:portal.id,portalHost:url.hostname,portalTenderUrl:url.href,portalTenderReference:source.procurement_number,portalAdapterId:portal.adapter_id,portalAdapterVersion:portal.adapter_version||'unvalidated',deadlineAt:new Date(source.offer_deadline).toISOString(),calculationId:row.calculation_id,calculationVersion:source.calculation_version,calculationSha256:source.result.calculationHash,packageVersion:row.version,packageSha256:bytesHash(archive),sourceSha256:row.manifest_sha256,documents:metadata,sourceVersionId:source.source_version_id,companyProfileId:source.profile_id,price:row.manifest.price};
 return {binding,documents,portal,archive};
}

export async function legacyDispatchDocuments(db,submission){
 const uploads=(await db.query(`SELECT u.id,u.filename,u.version,u.sha256,u.size_bytes,u.media_type,u.content buffer FROM tender.required_document_package_bindings b JOIN tender.required_document_uploads u ON u.id=b.upload_id WHERE b.bid_package_id=$1 AND u.company_id=$2 AND u.tender_id=$3 AND u.lot_key=$4 AND u.is_current=true AND u.validation_status='VALIDATED' AND u.malware_scan_status IN('CLEAN','PASSED')`,[submission.bid_package_id,submission.company_id,submission.tender_id,submission.binding.lotKey])).rows;
 const generated=(await db.query(`SELECT d.id,d.category||'.'||lower(d.format) filename,d.version,d.sha256,d.output_size_bytes size_bytes,d.output_media_type media_type,b.content buffer FROM tender.generated_documents d JOIN tender.document_blobs b ON b.payload_sha256=d.sha256 WHERE d.bid_package_id=$1 AND d.calculation_id=(SELECT calculation_id FROM tender.bid_packages WHERE id=$1) AND d.status='INTERNAL_DRAFT_READY' AND d.missing_fields='[]'::jsonb`,[submission.bid_package_id])).rows;
 return [...uploads,...generated].map(f=>({id:f.id,filename:f.filename,version:f.version,sha256:f.sha256,sizeBytes:Number(f.size_bytes),mediaType:f.media_type,buffer:f.buffer}));
}

export async function loadDispatchCredential(db,row,{keyringFile,legacyKeyFile}){
 let stored,secret;
 if(row.origin==='TENANT_PORTAL'){
  stored=(await db.query('SELECT * FROM tenant_portal.credential_vault WHERE tenant_id=$1 AND company_id=$2 AND portal_id=$3',[row.tenant_id,row.company_id,row.portal_id])).rows[0];
  requireDispatch(stored,'submission_credentials_required');
  try{secret=openPortalCredential(loadCredentialKeyring(keyringFile),stored,stored.ciphertext);}catch{throw Object.assign(new Error('submission_credentials_required'),{code:'submission_credentials_required'})}
 }else{
  stored=(await db.query(`WITH RECURSIVE recovered(id,depth) AS(SELECT $2::uuid,0 UNION ALL SELECT r.new_credential_id,recovered.depth+1 FROM recovered JOIN tender.submission_credential_recoveries r ON r.previous_credential_id=recovered.id AND r.tenant_id=$4 AND r.company_id=$1 AND r.portal_id=$3 WHERE recovered.depth<16) SELECT c.* FROM recovered JOIN tender.portal_credential_secrets c ON c.id=recovered.id JOIN tender.portal_credential_companies b ON b.credential_id=c.id AND b.company_id=$1 AND b.active WHERE c.portal_id=$3 AND c.status='ACTIVE' AND c.revoked_at IS NULL ORDER BY recovered.depth DESC LIMIT 1`,[row.company_id,row.binding.credentialId,row.portal_id,row.tenant_id])).rows[0];
  requireDispatch(stored,'submission_credentials_required');
  requireDispatch(!stored.valid_until||Number.isFinite(Date.parse(stored.valid_until))&&Date.parse(stored.valid_until)>Date.now(),'submission_credentials_required');
  requireDispatch(!stored.bound_host||stored.bound_host===row.binding.portalHost,'submission_credential_host_mismatch');
  try{secret=decryptSecret(stored,credentialKey(legacyKeyFile));}catch{throw Object.assign(new Error('submission_credentials_required'),{code:'submission_credentials_required'})}
 }
 requireDispatch(typeof secret?.username==='string'&&typeof secret.password==='string'&&secret.password.length>0,'submission_credentials_required');
 return {secret,credentialId:stored.id,revision:stored.revision||stored.version};
}

export function compareDispatchSource(row,current){
 const binding=assertFrozenDispatch(row),{releasedAt,releasedBy,releaseStatus,schemaVersion,...expected}=binding;
 requireDispatch(canonicalJson({...current.binding,documents:[...current.binding.documents].sort((a,b)=>a.id.localeCompare(b.id))})===canonicalJson(expected),'submission_approved_source_changed');
 assertDispatchDocuments(binding,current.documents);return current;
}

export async function legacyDispatchSource(db,context,submissionId){
 const {loadPreparationSource,managementPreparationBlockers}=await import('./submission-live-routes.mjs');
 const submission=(await db.query('SELECT * FROM tender.external_submissions WHERE id=$1 AND tenant_id=$2',[submissionId,context.id])).rows[0];
 requireDispatch(submission,'submission_not_found');
 const permissions=(await db.query(`SELECT DISTINCT p.code FROM iam.users u JOIN iam.user_roles ur ON ur.user_id=u.id JOIN iam.role_permissions rp ON rp.role_id=ur.role_id JOIN iam.permissions p ON p.id=rp.permission_id WHERE u.id=$1 AND u.active`,[context.actorUserId])).rows.map(r=>r.code);
 const companies=(await db.query("SELECT scope_id FROM iam.tender_identity_scopes WHERE user_id=$1 AND active AND scope_type='company'",[context.actorUserId])).rows.map(r=>String(r.scope_id));
 requireDispatch(permissions.includes('tender.submission.approve')&&companies.includes(submission.company_id),'submission_management_permission_required');
 const source=await loadPreparationSource(db,{tenderId:submission.tender_id,companyId:submission.company_id,lotKey:submission.binding.lotKey,bidPackageId:submission.bid_package_id,portalId:submission.portal_id,credentialId:submission.credential_id});
 const blockers=managementPreparationBlockers(source,{companyIds:companies,permissions});
 requireDispatch(!blockers.length,'submission_legacy_preflight_failed');
 requireDispatch(source.tenant_id===context.id&&source.company_id===submission.company_id,'submission_scope_changed');
 const documents=(await legacyDispatchDocuments(db,submission)).sort((a,b)=>a.id.localeCompare(b.id));requireDispatch(documents.length>0,'submission_documents_required');
 const calculation=(await db.query('SELECT * FROM tender.calculations WHERE id=$1 AND company_id=$2 AND tender_id=$3',[source.calculation_id,submission.company_id,submission.tender_id])).rows[0];
 requireDispatch(calculation,'submission_calculation_required');
 const portal=(await db.query('SELECT * FROM tender.portal_registry WHERE id=$1',[submission.portal_id])).rows[0];
 const binding={origin:'LEGACY',sourceId:submission.id,tenantId:context.id,companyId:submission.company_id,canonicalCompanyId:submission.company_id,tenderId:submission.tender_id,lotKey:submission.binding.lotKey,portalId:submission.portal_id,portalHost:new URL(source.portal_tender_url).hostname,portalTenderUrl:source.portal_tender_url,portalTenderReference:source.portal_tender_reference,portalAdapterId:portal.adapter_id,portalAdapterVersion:portal.adapter_version||'unvalidated',deadlineAt:new Date(source.offer_deadline).toISOString(),calculationId:calculation.id,calculationVersion:calculation.version,calculationSha256:liveSubmissionHash(calculation),packageVersion:source.bid_package_version,packageSha256:liveSubmissionHash({manifest:source.package_manifest,documents:documents.map(({buffer,...d})=>d).sort((a,b)=>a.id.localeCompare(b.id))}),sourceSha256:source.package_sha256,documents:documents.map(({buffer,...d})=>d),credentialId:submission.credential_id,price:source.totals};
 return {binding,documents,portal};
}
export const dispatchSource=(db,context,row,storage)=>row.origin==='LEGACY'?legacyDispatchSource(db,context,row.source_id):nativeDispatchSource(db,context,row.source_id,storage);
