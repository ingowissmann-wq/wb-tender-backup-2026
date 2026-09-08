import crypto from 'node:crypto';
import {withTenantContext,validTenantId} from './tenant-context.mjs';
import {classifyCompanyService,SERVICE_CLASSIFIER_VERSION} from './service-relevance.mjs';
import {classifyRegion} from './region-gate.mjs';
import {lotRegionTender} from './inbox-pipeline.mjs';
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const canonical=value=>JSON.stringify(value&&typeof value==='object'?(Array.isArray(value)?value.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(value).sort().map(key=>[key,JSON.parse(canonical(value[key]))]))):value??null);
const sha=value=>crypto.createHash('sha256').update(canonical(value)).digest('hex');
export const ASSIGNMENT_VERSION='TENANT_LOT_ASSIGNMENT_V1';
export function evaluateTenantLot({tender,lot,normalized,profiles=[],prior=null}){
 const scoped=lotRegionTender({...tender,...lot,lot_key:lot.lot_key},normalized);
 const sourceLots=normalized?.lots||normalized?.raw?.tender?.lots||[];
 const matching=sourceLots.filter(x=>String(x.id??x.lotKey??'')===lot.lot_key);
 const source=matching.length===1?matching[0]:null;
 const notice=lot.lot_key==='__NOTICE__'&&Number(lot.eligible_lot_count)===1;
 const currentCanonical=lot.lot_source_version_id&&lot.lot_source_version_id===tender.tender_version_id;
 const cpvs=source?.cpvCodes||source?.cpv_codes||[];
 const itemCpvs=(normalized?.raw?.tender?.items||[]).filter(item=>String(item.relatedLot??'')===lot.lot_key).flatMap(item=>[item.classification?.id,...(item.additionalClassifications||[]).map(x=>x.id)]).filter(Boolean);
 const evidenceLot={lot_key:lot.lot_key,title:source?.title||(currentCanonical?lot.lot_title:'')||'',description:source?.description||(currentCanonical?lot.lot_description:'')||'',cpv_codes:[...new Set([...cpvs,...itemCpvs,...(currentCanonical?lot.lot_cpv_codes||[]:[])])].sort()};
 const candidates=profiles.map(profile=>{
  const company={company_id:profile.company_id,legal_name:profile.display_name,sector_slug:profile.service_line.replace('_','-'),sector_status:'approved'};
  const service=classifyCompanyService({tender,lot:notice?null:evidenceLot,company});
  const region=classifyRegion({company,tender:scoped,config:{structuredRegions:profile.regions,regionProfileVersionId:profile.id,versionId:profile.id,versionNo:profile.version},applicable:service.relevanceStatus==='RELEVANT'});
  return {companyId:profile.company_id,companyName:profile.display_name,profileId:profile.id,serviceLine:profile.service_line,serviceStatus:service.relevanceStatus,regionStatus:region.classification,serviceReason:service.reason,regionReason:region.reason};
 }).sort((a,b)=>a.companyId.localeCompare(b.companyId)||a.profileId.localeCompare(b.profileId));
 const eligible=candidates.filter(x=>x.serviceStatus==='RELEVANT'&&x.regionStatus==='CORE_REGION');
 const manual=prior?.assignment_kind==='MANUAL'||prior?.details?.manualDecision;
 const selected=manual?{companyId:prior.company_id,profileId:prior.profile_id}:eligible.length===1?eligible[0]:null;
 const changedManual=manual&&((prior.details.manualDecision?.sourceVersionId||prior.source_version_id)!==tender.tender_version_id||!candidates.some(x=>x.profileId===prior.profile_id&&x.serviceStatus==='RELEVANT'));
 const kind=manual?(changedManual?'REVIEW_REQUIRED':'MANUAL'):selected?'AUTOMATIC':'REVIEW_REQUIRED';
 const details={algorithm:ASSIGNMENT_VERSION,classifier:SERVICE_CLASSIFIER_VERSION,lot:lot.lot_key,locations:scoped.locations,candidates,reason:manual?(changedManual?'SOURCE_CHANGED_REVIEW_SAVED_DECISION':'SAVED_MANUAL_DECISION'):eligible.length>1?'AMBIGUOUS_COMPANY':selected?'UNIQUE_SERVICE_AND_REGION_MATCH':'NO_UNIQUE_MATCH',manualDecision:manual?prior.details.manualDecision||{companyId:prior.company_id,profileId:prior.profile_id}:null};
 return {assignment_kind:kind,company_id:selected?.companyId||null,profile_id:selected?.profileId||null,details};
}
export class TenantLotAssignments{
 constructor(pool){this.pool=pool;}
 async list(context){return withTenantContext(this.pool,context,async db=>(await db.query(`SELECT DISTINCT ON(a.workspace_id,a.lot_key) a.*,t.title,t.buyer,t.source_url FROM tenant_portal.lot_assignment_versions a JOIN tenant_portal.tender_workspaces w ON w.tenant_id=a.tenant_id AND w.id=a.workspace_id JOIN tender.tenders t ON t.id=w.public_tender_id WHERE a.tenant_id=$1 ORDER BY a.workspace_id,a.lot_key,a.version DESC`,[context.id])).rows);}
 async import(context,tenderId){
  if(!validTenantId(tenderId))throw fail('tender_not_found',404);
  return withTenantContext(this.pool,context,async db=>{
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended('tenant-tender:'||$1::text||':'||$2::text,0))",[context.id,tenderId]);
   const tender=(await db.query(`SELECT t.id,t.title,t.description,t.buyer,t.regions,t.cpv_codes,t.source_code,v.id tender_version_id,v.normalized_data FROM tender.tenders t JOIN LATERAL(SELECT id,normalized_data FROM tender.tender_versions WHERE tender_id=t.id ORDER BY version DESC LIMIT 1)v ON true WHERE t.id=$1 AND t.data_class='PUBLIC_REAL' AND t.source_lifecycle_status='ACTIVE' AND t.participation_status IN('ELIGIBLE','PARTIALLY_ELIGIBLE')`,[tenderId])).rows[0];
   if(!tender)throw fail('tender_not_found',404);
   const lots=(await db.query(`SELECT eligible.lot_key,l.id canonical_lot_id,l.locations lot_locations,l.title lot_title,l.description lot_description,l.cpv_codes lot_cpv_codes,s.tender_version_id lot_source_version_id,count(*) OVER() eligible_lot_count FROM tender.current_participation_eligible_lots eligible LEFT JOIN tender.lots l ON l.tender_id=eligible.tender_id AND l.external_id=eligible.lot_key LEFT JOIN tender.source_references s ON s.id=l.source_reference_id WHERE eligible.tender_id=$1 ORDER BY eligible.lot_key`,[tenderId])).rows;
   if(!lots.length)throw fail('tender_no_eligible_lots',409);
   const profiles=(await db.query(`SELECT DISTINCT ON(p.company_id,p.service_line) p.*,c.display_name FROM tenant_portal.company_profile_versions p JOIN saas.tenant_companies c ON c.tenant_id=p.tenant_id AND c.id=p.company_id WHERE p.tenant_id=$1 AND c.status='ACTIVE' AND p.valid_from<=(now() AT TIME ZONE 'UTC')::date AND (p.valid_until IS NULL OR p.valid_until>=(now() AT TIME ZONE 'UTC')::date) ORDER BY p.company_id,p.service_line,p.valid_from DESC,p.version DESC`,[context.id])).rows;
   const workspace=(await db.query(`INSERT INTO tenant_portal.tender_workspaces(tenant_id,public_tender_id) VALUES($1,$2) ON CONFLICT(tenant_id,public_tender_id) DO NOTHING RETURNING id`,[context.id,tenderId])).rows[0]||(await db.query('SELECT id FROM tenant_portal.tender_workspaces WHERE tenant_id=$1 AND public_tender_id=$2',[context.id,tenderId])).rows[0];
   const items=[];
   for(const lot of lots){
    const prior=(await db.query('SELECT * FROM tenant_portal.lot_assignment_versions WHERE tenant_id=$1 AND workspace_id=$2 AND lot_key=$3 ORDER BY version DESC LIMIT 1',[context.id,workspace.id,lot.lot_key])).rows[0];
    const decision=evaluateTenantLot({tender,lot,normalized:tender.normalized_data,profiles,prior});
    const fingerprint=sha({sourceVersion:tender.tender_version_id,...decision});
    const old=(await db.query('SELECT * FROM tenant_portal.lot_assignment_versions WHERE tenant_id=$1 AND workspace_id=$2 AND lot_key=$3 AND snapshot_sha256=$4',[context.id,workspace.id,lot.lot_key,fingerprint])).rows[0];
    if(old){items.push(old);continue;}
    const row=(await db.query(`INSERT INTO tenant_portal.lot_assignment_versions(tenant_id,workspace_id,source_version_id,lot_key,version,assignment_kind,company_id,profile_id,snapshot_sha256,details,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[context.id,workspace.id,tender.tender_version_id,lot.lot_key,Number(prior?.version||0)+1,decision.assignment_kind,decision.company_id,decision.profile_id,fingerprint,decision.details,context.actorUserId])).rows[0];
    await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id,metadata) VALUES($1,$2,'LOT_ASSIGNMENT_EVALUATED','lot_assignment',$3,$4)",[context.id,context.actorUserId,row.id,{workspaceId:workspace.id,lotKey:lot.lot_key,sourceVersionId:tender.tender_version_id,status:decision.assignment_kind}]);items.push(row);
   }
   return {workspaceId:workspace.id,items};
  });
 }
 async decide(context,assignmentId,input){
  if(!validTenantId(assignmentId)||!validTenantId(input?.profileId)||input?.confirmed!==true||typeof input.reason!=='string'||input.reason.trim().length<10||input.reason.length>1000)throw fail('lot_decision_invalid');
  return withTenantContext(this.pool,context,async db=>{
   const original=(await db.query('SELECT a.*,w.public_tender_id FROM tenant_portal.lot_assignment_versions a JOIN tenant_portal.tender_workspaces w ON w.tenant_id=a.tenant_id AND w.id=a.workspace_id WHERE a.tenant_id=$1 AND a.id=$2',[context.id,assignmentId])).rows[0];if(!original)throw fail('lot_assignment_not_found',404);
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended('tenant-tender:'||$1::text||':'||$2::text,0))",[context.id,original.public_tender_id]);
   const latest=(await db.query('SELECT * FROM tenant_portal.lot_assignment_versions WHERE tenant_id=$1 AND workspace_id=$2 AND lot_key=$3 ORDER BY version DESC LIMIT 1',[context.id,original.workspace_id,original.lot_key])).rows[0];
   const manual={profileId:input.profileId,reason:input.reason.trim()};
   if(latest.details?.manualRequest===canonical(manual)&&latest.details?.manualBase===assignmentId)return latest;
   if(latest.id!==assignmentId)throw fail('lot_assignment_changed',409);
   const eligible=(await db.query('SELECT 1 FROM tender.current_participation_eligible_lots WHERE tender_id=$1 AND lot_key=$2',[original.public_tender_id,latest.lot_key])).rowCount;
   if(!eligible)throw fail('lot_no_longer_eligible',409);
   const validProfile=(await db.query("SELECT p.id FROM tenant_portal.company_profile_versions p JOIN saas.tenant_companies c ON c.tenant_id=p.tenant_id AND c.id=p.company_id WHERE p.tenant_id=$1 AND p.id=$2 AND c.status='ACTIVE' AND p.valid_from<=(now() AT TIME ZONE 'UTC')::date AND (p.valid_until IS NULL OR p.valid_until>=(now() AT TIME ZONE 'UTC')::date)",[context.id,input.profileId])).rows[0];
   if(!validProfile)throw fail('lot_profile_not_current',409);
   const candidate=latest.details.candidates.find(x=>x.profileId===input.profileId);
   if(!candidate||candidate.serviceStatus!=='RELEVANT'||candidate.regionStatus==='EXCLUDED_REGION')throw fail('lot_profile_not_eligible',409);
   const current=(await db.query('SELECT id FROM tender.tender_versions WHERE tender_id=$1 ORDER BY version DESC LIMIT 1',[original.public_tender_id])).rows[0];
   if(current?.id!==latest.source_version_id)throw fail('lot_source_changed_reimport',409);
   const details={...latest.details,manualDecision:{...manual,companyId:candidate.companyId,sourceVersionId:latest.source_version_id},manualRequest:canonical(manual),manualBase:assignmentId,reason:'EXPLICIT_MANUAL_DECISION'};
   const row=(await db.query(`INSERT INTO tenant_portal.lot_assignment_versions(tenant_id,workspace_id,source_version_id,lot_key,version,assignment_kind,company_id,profile_id,snapshot_sha256,details,created_by) VALUES($1,$2,$3,$4,$5,'MANUAL',$6,$7,$8,$9,$10) RETURNING *`,[context.id,latest.workspace_id,latest.source_version_id,latest.lot_key,latest.version+1,candidate.companyId,input.profileId,sha({sourceVersion:latest.source_version_id,details}),details,context.actorUserId])).rows[0];
   await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id) VALUES($1,$2,'LOT_ASSIGNMENT_MANUALLY_CONFIRMED','lot_assignment',$3)",[context.id,context.actorUserId,row.id]);return row;
  });
 }
}
