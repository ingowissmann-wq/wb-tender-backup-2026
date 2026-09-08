import {TenantLotCalculations} from './tenant-lot-calculations.mjs';
import {TenantDocumentReview} from './tenant-document-review.mjs';
export async function dispatchTenantJob({pool,storage,context,moduleKey,jobType,payload}){
 if(moduleKey!=='tender_autopilot'||!['CALCULATE_LOT','REVIEW_LOT_DOCUMENTS'].includes(jobType))throw Object.assign(new Error('job_type_not_supported'),{statusCode:422});
 if(jobType==='CALCULATE_LOT'){
  const result=await new TenantLotCalculations(pool,storage).create(context,payload?.assignmentId,payload);
  return {id:result.calculation.id,module_key:moduleKey,job_type:jobType,status:result.calculation.status==='CALCULATED'?'SUCCEEDED':'FAILED',result:result.calculation,idempotent:result.idempotent};
 }
 const review=await new TenantDocumentReview(pool,storage).analyze(context,payload?.assignmentId,payload);
 return {id:review.id,module_key:moduleKey,job_type:jobType,status:'SUCCEEDED',result:review};
}
