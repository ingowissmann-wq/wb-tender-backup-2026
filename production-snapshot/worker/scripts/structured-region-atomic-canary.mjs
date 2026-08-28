import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";

const baseUrl=String(process.env.ATOMIC_CANARY_BASE_URL||"").replace(/\/$/,"");
const session=JSON.parse(fs.readFileSync(process.env.ATOMIC_CANARY_SESSION_FILE||"/tmp/wb-portal-access-button-canary-session.json","utf8"));
const databaseUrlObject=new URL(fs.readFileSync(process.env.DATABASE_URL_FILE||"/tmp/wb-structured-dryrun-database-url","utf8").trim());
if(process.env.ATOMIC_CANARY_DATABASE_HOST)databaseUrlObject.hostname=process.env.ATOMIC_CANARY_DATABASE_HOST;
const databaseUrl=databaseUrlObject.toString();
if(!baseUrl)throw new Error("ATOMIC_CANARY_BASE_URL_required");
const pool=new pg.Pool({connectionString:databaseUrl,max:3});
const companyId="7edf1812-b5e9-4b5c-addf-95d2339362b3",serviceLine="security";
const headers={"content-type":"application/json","x-csrf-token":session.csrf,cookie:`wb_session=${session.token}; wb_csrf=${session.csrf}`};
async function request(path,{method="GET",body}={}){const response=await fetch(`${baseUrl}${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}),payload=await response.json().catch(()=>({}));return{status:response.status,payload}}
const post=(path,body)=>request(path,{method:"POST",body});
async function decisionHash(){return (await pool.query(`SELECT encode(digest(coalesce(string_agg(concat_ws('|',current.tender_id::text,current.company_id::text,current.workflow_status,coalesce(current.responsible_user_id::text,'')),';' ORDER BY current.tender_id,current.company_id),''),'sha256'),'hex') hash FROM(SELECT DISTINCT ON(tender_id,company_id) tender_id,company_id,workflow_status,responsible_user_id FROM tender.management_inbox ORDER BY tender_id,company_id,created_at DESC,id DESC)current`)).rows[0].hash}
async function scopeState(){return (await pool.query(`SELECT scope.active_region_version_id,(SELECT count(*)::int FROM tender.region_profile_versions version WHERE version.tenant_id=scope.tenant_id AND version.company_id=scope.company_id AND version.canonical_service=scope.canonical_service AND version.profile_id=scope.profile_id AND version.status='ACTIVE') active_count FROM tender.configuration_scopes scope WHERE scope.company_id=$1 AND scope.canonical_service=$2`,[companyId,serviceLine])).rows[0]}
async function createDraft(configuration,label){const result=await post("/api/configuration/drafts",{clientRequestId:crypto.randomUUID(),companyId,serviceLine,category:"REGION_CAPACITY",parameterKey:"A08",newValue:configuration,unit:"NUTS/Bundesland/Radius-Liste",source:"ISOLATED_CANARY",dataAsOf:"2026-08-19",validFrom:"2026-08-19",validUntil:null,reason:`Isolierter atomarer Canary ${label}`});if(result.status!==201)throw new Error(`draft_${label}_${result.status}_${result.payload.error||"unknown"}`);return result.payload}
async function preview(draft){const result=await post(`/api/configuration/versions/${draft.id}/preview`,{});if(result.status!==200)throw new Error(`preview_${result.status}_${result.payload.error||"unknown"}`);return result.payload}
async function activate(draft,previewResult){return post(`/api/configuration/versions/${draft.id}/self-approve-activate`,{expectedVersionNo:Number(draft.versionNo),expectedParameterKey:"A08",expectedActiveRegionVersionId:previewResult.regionPreview?.previousActiveRegionVersionId||"none"})}

let triggerInstalled=false;
try{
 const catalog=await request("/api/configuration/catalog");if(catalog.status!==200||catalog.payload.currentUser?.canSelfApproveActivate!==true)throw new Error("canary_self_approval_permission_missing");
 const beforeHash=await decisionHash(),beforeScope=await scopeState();
 const validation=await post("/api/configuration/regions/validate",{companyId,serviceLine,configuration:{schema:"WB_CORE_REGIONS_V1",regions:[{id:"augsburg-canary",type:"PLACE_RADIUS",place:"Augsburg",postalCode:"86150",state:"Bayern",radiusKm:150}]}});
 if(validation.status!==200||validation.payload.valid!==true)throw new Error(`validation_${validation.status}_${validation.payload.errors?.join(",")||validation.payload.error}`);
 const row=validation.payload.configuration.regions[0];
 if(row.nutsCode!=="DE271"||row.latitude==null||row.longitude==null||row.validationStatus!=="VALID")throw new Error("augsburg_precision_not_proven");

 const rollbackDraft=await createDraft(validation.payload.configuration,"ROLLBACK");const rollbackPreview=await preview(rollbackDraft);
 if(!/^[0-9a-f-]{36}$/i.test(rollbackDraft.id))throw new Error("invalid_canary_draft_id");
 await pool.query(`CREATE OR REPLACE FUNCTION tender.atomic_canary_fail_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.configuration_version_id='${rollbackDraft.id}'::uuid THEN RAISE EXCEPTION 'synthetic_canary_job_failure' USING ERRCODE='XX999'; END IF; RETURN NEW; END $$`);
 await pool.query("CREATE TRIGGER atomic_canary_fail_job BEFORE INSERT ON tender.region_recalculation_jobs FOR EACH ROW EXECUTE FUNCTION tender.atomic_canary_fail_job()");triggerInstalled=true;
 const failed=await activate(rollbackDraft,rollbackPreview);
 await pool.query("DROP TRIGGER atomic_canary_fail_job ON tender.region_recalculation_jobs");await pool.query("DROP FUNCTION tender.atomic_canary_fail_job()");triggerInstalled=false;
 const failedState=(await pool.query("SELECT status FROM tender.configuration_versions WHERE id=$1",[rollbackDraft.id])).rows[0];const afterFailureScope=await scopeState();
 if(failed.status!==500||failed.payload.error!=="board_activation_failed"||!failed.payload.errorId||failedState.status!=="DRAFT"||String(afterFailureScope.active_region_version_id)!==String(beforeScope.active_region_version_id)||Number(afterFailureScope.active_count)!==1)throw new Error("rollback_invariant_failed");

 const draftA=await createDraft(validation.payload.configuration,"PARALLEL_A"),draftB=await createDraft(validation.payload.configuration,"PARALLEL_B"),previewA=await preview(draftA),previewB=await preview(draftB);
 const [activationA,activationB]=await Promise.all([activate(draftA,previewA),activate(draftB,previewB)]),attempts=[{draft:draftA,result:activationA},{draft:draftB,result:activationB}],winner=attempts.find(x=>x.result.status===200),loser=attempts.find(x=>x.result.status===409);
 if(!winner||!loser||loser.result.payload.error!=="version_conflict")throw new Error(`parallel_gate_failed_${activationA.status}_${activationB.status}`);
 const repeat=await activate(winner.draft,winner.draft.id===draftA.id?previewA:previewB);
 const state=(await pool.query(`SELECT version.id,version.status,version.configuration_version_id,rule.nuts_code,rule.latitude,rule.longitude,(SELECT count(*)::int FROM tender.region_profile_versions x WHERE x.tenant_id=version.tenant_id AND x.company_id=version.company_id AND x.canonical_service=version.canonical_service AND x.profile_id=version.profile_id AND x.status='ACTIVE') active_count,(SELECT count(*)::int FROM tender.region_recalculation_jobs job WHERE job.configuration_version_id=version.configuration_version_id) job_count,(SELECT count(*)::int FROM tender.configuration_audit audit WHERE audit.version_id=version.configuration_version_id AND audit.action IN('BOARD_SELF_APPROVED','ACTIVE')) audit_count FROM tender.region_profile_versions version JOIN tender.region_profile_rules rule ON rule.region_version_id=version.id WHERE version.configuration_version_id=$1`,[winner.draft.id])).rows[0];
 const loserState=(await pool.query("SELECT status FROM tender.configuration_versions WHERE id=$1",[loser.draft.id])).rows[0];
 if(repeat.status!==200||repeat.payload.idempotent!==true||state.status!=="ACTIVE"||state.nuts_code!=="DE271"||Number(state.active_count)!==1||Number(state.job_count)!==1||Number(state.audit_count)!==2||loserState.status!=="DRAFT")throw new Error("post_commit_invariant_failed");
 const job=(await pool.query("SELECT id,status,tenant_id,company_id,canonical_service,profile_id,region_profile_version_id FROM tender.region_recalculation_jobs WHERE configuration_version_id=$1",[winner.draft.id])).rows[0];
 for(let i=0;i<30&&["QUEUED","RUNNING"].includes(job.status);i++){await new Promise(resolve=>setTimeout(resolve,500));Object.assign(job,(await pool.query("SELECT status,total_count,processed_count,error_code FROM tender.region_recalculation_jobs WHERE id=$1",[job.id])).rows[0])}
 const afterHash=await decisionHash();
 console.log(JSON.stringify({passed:true,isolated:true,validation:{place:row.place,postalCode:row.postalCode,state:row.state,nutsCode:row.nutsCode,nutsHierarchy:row.nutsHierarchy,latitude:row.latitude,longitude:row.longitude,radiusKm:row.radiusKm,provider:row.evidence?.nutsProvider},rollback:{httpStatus:failed.status,error:failed.payload.error,errorIdPresent:Boolean(failed.payload.errorId),draftStatus:failedState.status,activeRegionUnchanged:true},parallel:{statuses:[activationA.status,activationB.status],winnerVersionNo:winner.draft.versionNo,loserStatus:loserState.status,activeCount:Number(state.active_count)},idempotency:{httpStatus:repeat.status,idempotent:repeat.payload.idempotent,jobCount:Number(state.job_count),auditCount:Number(state.audit_count)},regionalization:{status:job.status,total:Number(job.total_count||0),processed:Number(job.processed_count||0),errorCode:job.error_code||null,companyId:job.company_id,canonicalService:job.canonical_service},decisionHashUnchanged:beforeHash===afterHash},null,2));
}finally{
 if(triggerInstalled){await pool.query("DROP TRIGGER IF EXISTS atomic_canary_fail_job ON tender.region_recalculation_jobs");await pool.query("DROP FUNCTION IF EXISTS tender.atomic_canary_fail_job()")}
 await pool.end();
}
