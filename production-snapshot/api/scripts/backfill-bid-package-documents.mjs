import fs from "node:fs";
import pg from "pg";
import { generateBidPackageDocuments } from "../platform/bid-package-documents.mjs";
import { evaluateSubmissionGate } from "../platform/bid-workflow.mjs";

const connectionString=process.env.DATABASE_URL||fs.readFileSync(process.env.DATABASE_URL_FILE,"utf8").trim();
const pool=new pg.Pool({connectionString,max:1});
const packages=(await pool.query(`SELECT bp.id,bp.created_by,a.id approval_request_id,a.payload_sha256
  FROM tender.bid_packages bp JOIN tender.approval_requests a ON a.tender_id=bp.tender_id AND a.calculation_id=bp.calculation_id AND a.status='APPROVED'
  WHERE NOT EXISTS(SELECT 1 FROM tender.generated_documents gd WHERE gd.bid_package_id=bp.id)
  ORDER BY bp.created_at`)).rows;
const results=[];
for(const row of packages){const client=await pool.connect();try{await client.query("BEGIN");const generation=await generateBidPackageDocuments(client,{bidPackageId:row.id,createdBy:row.created_by});const gate=evaluateSubmissionGate({publicReal:true,tenderActive:true,deadlineOpen:true,calculationStatus:"CALCULATED",managementOutputCurrent:true,documentsVerified:true,packageComplete:generation.packageComplete,approvalStatus:"APPROVED",bindingHash:row.payload_sha256,approvalPayloadHash:row.payload_sha256,portalSessionValid:false,mfaComplete:false,perActionRelease:false,alreadySubmitted:false});await client.query("INSERT INTO tender.bid_submission_gates(bid_package_id,approval_request_id,status,reasons,binding_sha256,evaluated_at) VALUES($1,$2,$3,$4::jsonb,$5,now()) ON CONFLICT(bid_package_id,binding_sha256) DO UPDATE SET status=excluded.status,reasons=excluded.reasons,evaluated_at=excluded.evaluated_at",[row.id,row.approval_request_id,gate.status,JSON.stringify(gate.reasons),row.payload_sha256]);await client.query("INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) SELECT created_by,'SUBMISSION_GATE_RECHECKED',tender_id,$2::jsonb FROM tender.bid_packages WHERE id=$1",[row.id,JSON.stringify({bidPackageId:row.id,status:gate.status,reasons:gate.reasons,externalWrite:false})]);await client.query("COMMIT");results.push({bidPackageId:row.id,documents:generation.documents.length,packageComplete:generation.packageComplete,gate:gate.status,reasons:gate.reasons.map(item=>item.code)})}catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}}
console.log(JSON.stringify({processed:results.length,results},null,2));await pool.end();
