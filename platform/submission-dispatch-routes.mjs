import {withTenantContext,requireTenantContext} from './tenant-context.mjs';
import {requireSaasModule} from './saas-platform.mjs';
import {MODULE_KEYS} from './saas-catalog.mjs';
import {nativeDispatchSource} from './submission-dispatch-sources.mjs';
import {enqueueApprovedDispatch} from './submission-dispatch-store.mjs';
import {DISPATCH_CONFIRMATION,requireDispatch} from './submission-dispatch-core.mjs';
import {liveSubmissionHash} from './submission-live-core.mjs';

export async function releaseNativeSubmission(db,context,packageId,body,storage){
 requireDispatch(body?.confirmation===DISPATCH_CONFIRMATION,'submission_explicit_confirmation_required');
 const source=await nativeDispatchSource(db,context,packageId,storage);
 requireDispatch(body.bindingSha256===liveSubmissionHash(source.binding),'submission_approved_source_changed');
 return enqueueApprovedDispatch(db,{...source.binding,releasedBy:context.actorUserId,releasedAt:new Date().toISOString()});
}
export function registerSubmissionDispatchRoutes(app,{pool,storage,authenticate,csrf,isFreshWbMfa}){
 const admin=async(req,reply)=>{if(!['OWNER','ADMIN'].includes(req.identity?.saas?.role))return reply.code(403).send({error:'tenant_admin_required'})};
 const guards=[authenticate,async(req,reply)=>requireTenantContext(req,reply),requireSaasModule(MODULE_KEYS.TENDER_AUTOPILOT),admin];
 const safe=fn=>async(req,reply)=>{reply.header('Cache-Control','no-store');try{return await fn(req,reply)}catch(error){const known=/^(submission_|offer_package_|document_review_)[a-zA-Z0-9_]+$/.test(error.code||error.message);return reply.code(known?(error.statusCode||409):503).send({error:known?(error.code||error.message):'submission_operation_failed'})}};
 app.get('/api/tenant-portal/packages/:id/submission-preview',{preHandler:guards},safe(req=>withTenantContext(pool,req.tenant,async db=>{const source=await nativeDispatchSource(db,req.tenant,req.params.id,storage);return {binding:source.binding,bindingSha256:liveSubmissionHash(source.binding),confirmation:DISPATCH_CONFIRMATION}})));
 app.post('/api/tenant-portal/packages/:id/submit',{preHandler:[...guards,csrf],bodyLimit:4096},safe(async(req,reply)=>{
  if(!await isFreshWbMfa(req))return reply.code(403).send({error:'wb_mfa_required'});
  const result=await withTenantContext(pool,req.tenant,db=>releaseNativeSubmission(db,req.tenant,req.params.id,req.body,storage));return reply.code(202).send(result);
 }));
 app.get('/api/tenant-portal/submissions',{preHandler:guards},safe(req=>withTenantContext(pool,req.tenant,async db=>({items:(await db.query(`SELECT d.id,d.company_id,d.tender_id,d.lot_key,d.portal_id,d.status,d.released_by,d.released_at,d.deadline_at,d.package_sha256,d.attempt,d.last_error,d.updated_at,r.portal_reference,r.submitted_at,r.receipt_sha256 FROM tender.submission_dispatches d LEFT JOIN tender.submission_dispatch_receipts r ON r.dispatch_id=d.id WHERE d.tenant_id=$1 ORDER BY d.created_at DESC LIMIT 200`,[req.tenant.id])).rows}))));
 app.get('/api/tenant-portal/submissions/:id/receipt',{preHandler:guards},safe(async(req,reply)=>withTenantContext(pool,req.tenant,async db=>{const receipt=(await db.query('SELECT media_type,receipt_bytes,receipt_sha256 FROM tender.submission_dispatch_receipts WHERE tenant_id=$1 AND dispatch_id=$2',[req.tenant.id,req.params.id])).rows[0];requireDispatch(receipt,'submission_receipt_missing');return reply.header('Content-Disposition','attachment; filename="Portalbeleg.'+(receipt.media_type==='application/pdf'?'pdf':'json')+'"').header('X-Content-SHA256',receipt.receipt_sha256).type(receipt.media_type).send(receipt.receipt_bytes)})));
 app.get('/api/tenant-portal/submissions/:id/audit',{preHandler:guards},safe(req=>withTenantContext(pool,req.tenant,async db=>({items:(await db.query('SELECT from_status,to_status,actor_id,occurred_at,previous_sha256,event_sha256,evidence FROM tender.submission_dispatch_audit WHERE tenant_id=$1 AND dispatch_id=$2 ORDER BY id',[req.tenant.id,req.params.id])).rows}))));
}
