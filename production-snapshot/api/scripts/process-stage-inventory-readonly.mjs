import fs from "node:fs";
import pg from "pg";
import {createFixedScopedPool,loadBackgroundScope} from "../platform/scoped-pg-pool.mjs";

const connectionString=process.env.DATABASE_URL||fs.readFileSync(
  process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8",
).trim();
const rawPool=new pg.Pool({connectionString,max:1,options:["-c default_transaction_read_only=on -c statement_timeout=120000",process.env.DATABASE_SESSION_OPTIONS].filter(Boolean).join(" ")});
const pool=createFixedScopedPool(rawPool,await loadBackgroundScope(rawPool)).pool;
const client=await pool.connect();
const detail=process.argv.includes("--detail");

const grouped=async(sql)=>(await client.query(sql)).rows;
try{
  await client.query("BEGIN READ ONLY");
  const activeRelevant=await grouped(`SELECT company.legal_name,count(DISTINCT relevance.tender_id)::int tenders,
      count(*) FILTER(WHERE relevance.lot_key IS NOT NULL)::int lot_contexts
    FROM tender.current_service_relevance relevance
    JOIN tender.enterprise_company_links company ON company.company_id=relevance.company_id AND company.active
    JOIN tender.tenders tender ON tender.id=relevance.tender_id
      AND tender.source_lifecycle_status='ACTIVE' AND tender.data_class='PUBLIC_REAL'
    WHERE relevance.relevance_status='RELEVANT' AND relevance.service_scope_gate='PASSED'
    GROUP BY company.legal_name ORDER BY company.legal_name`);
  const calculations=await grouped(`SELECT company.legal_name,calculation.status,count(*)::int count,
      count(*) FILTER(WHERE tender.source_lifecycle_status='ACTIVE' AND tender.data_class='PUBLIC_REAL')::int active_public
    FROM tender.calculations calculation
    JOIN tender.enterprise_company_links company ON company.company_id=calculation.company_id
    JOIN tender.tenders tender ON tender.id=calculation.tender_id
    GROUP BY company.legal_name,calculation.status ORDER BY company.legal_name,calculation.status`);
  const requiredDocuments=await grouped(`SELECT company.legal_name,document.satisfaction_status,
      document.requirement_classification,count(*)::int count,
      count(*) FILTER(WHERE document.mandatory AND document.submission_relevant)::int mandatory_submission,
      count(*) FILTER(WHERE tender.source_lifecycle_status='ACTIVE' AND tender.data_class='PUBLIC_REAL')::int active_public
    FROM tender.required_documents document
    JOIN tender.enterprise_company_links company ON company.company_id=document.company_id
    JOIN tender.tenders tender ON tender.id=document.tender_id
    GROUP BY company.legal_name,document.satisfaction_status,document.requirement_classification
    ORDER BY company.legal_name,document.satisfaction_status,document.requirement_classification`);
  const formWork=await grouped(`SELECT company.legal_name,count(DISTINCT copy.id)::int working_copies,
      count(DISTINCT upload.id)::int uploads,
      count(DISTINCT upload.id) FILTER(WHERE upload.validation_status='VALIDATED' AND upload.malware_scan_status='CLEAN')::int validated_clean_uploads
    FROM tender.enterprise_company_links company
    LEFT JOIN tender.required_document_working_copies copy ON copy.company_id=company.company_id AND copy.is_current
    LEFT JOIN tender.required_document_uploads upload ON upload.company_id=company.company_id AND upload.is_current
    WHERE company.active GROUP BY company.legal_name ORDER BY company.legal_name`);
  const packages=await grouped(`SELECT company.legal_name,package.status,count(*)::int count
    FROM tender.bid_packages package JOIN tender.enterprise_company_links company ON company.company_id=package.company_id
    GROUP BY company.legal_name,package.status ORDER BY company.legal_name,package.status`);
  const approvals=await grouped(`SELECT company.legal_name,approval.status,count(*)::int count,
      count(*) FILTER(WHERE approval.expires_at IS NULL OR approval.expires_at>now())::int unexpired
    FROM tender.approval_requests approval JOIN tender.enterprise_company_links company ON company.company_id=approval.company_id
    GROUP BY company.legal_name,approval.status ORDER BY company.legal_name,approval.status`);
  const preflight=await grouped(`SELECT company.legal_name,context.readiness_status,context.binding_valid,count(*)::int count
    FROM tender.final_preflight_contexts context
    JOIN tender.enterprise_company_links company ON company.company_id=context.company_id
    WHERE context.is_current GROUP BY company.legal_name,context.readiness_status,context.binding_valid
    ORDER BY company.legal_name,context.readiness_status`);
  const submissions=await grouped(`SELECT company.legal_name,context.submission_status,context.preflight_status,
      context.portal_validation_status,context.final_approval_status,count(*)::int count,
      count(*) FILTER(WHERE context.transmitted)::int transmitted
    FROM tender.submission_contexts context
    JOIN tender.enterprise_company_links company ON company.company_id=context.company_id
    GROUP BY company.legal_name,context.submission_status,context.preflight_status,
      context.portal_validation_status,context.final_approval_status
    ORDER BY company.legal_name,context.submission_status`);
  const receipts=Number((await client.query("SELECT count(*) count FROM tender.submission_receipts")).rows[0].count);
  const summarize=(rows,keys,valueKeys=["count"])=>(Object.values(rows.reduce((result,row)=>{
    const identity=keys.map((key)=>row[key]??"NULL").join("\u0000");
    result[identity]??=Object.fromEntries(keys.map((key)=>[key,row[key]]));
    for(const valueKey of valueKeys){
      result[identity][valueKey]=(result[identity][valueKey]||0)+Number(row[valueKey]||0);
    }
    return result;
  },{})));
  const calculationSummary=summarize(calculations,["legal_name","status"],["count","active_public"]);
  const requiredDocumentSummary=summarize(requiredDocuments,["legal_name","satisfaction_status"],
    ["count","mandatory_submission","active_public"]);
  const requiredDocumentClassifications=summarize(requiredDocuments,["requirement_classification"],
    ["count","mandatory_submission","active_public"]);
  const totals={
    activeRelevantTenders:activeRelevant.reduce((sum,row)=>sum+Number(row.tenders),0),
    activeRelevantLotContexts:activeRelevant.reduce((sum,row)=>sum+Number(row.lot_contexts),0),
    calculations:calculations.reduce((sum,row)=>sum+Number(row.count),0),
    activePublicCalculations:calculations.reduce((sum,row)=>sum+Number(row.active_public),0),
    requiredDocuments:requiredDocuments.reduce((sum,row)=>sum+Number(row.count),0),
    mandatorySubmissionDocuments:requiredDocuments.reduce((sum,row)=>sum+Number(row.mandatory_submission),0),
    activePublicRequiredDocuments:requiredDocuments.reduce((sum,row)=>sum+Number(row.active_public),0),
    workingCopies:formWork.reduce((sum,row)=>sum+Number(row.working_copies),0),
    uploads:formWork.reduce((sum,row)=>sum+Number(row.uploads),0),
    validatedCleanUploads:formWork.reduce((sum,row)=>sum+Number(row.validated_clean_uploads),0),
    packages:packages.reduce((sum,row)=>sum+Number(row.count),0),
    approvals:approvals.reduce((sum,row)=>sum+Number(row.count),0),
    preflights:preflight.reduce((sum,row)=>sum+Number(row.count),0),
    submissionContexts:submissions.reduce((sum,row)=>sum+Number(row.count),0),
    transmitted:submissions.reduce((sum,row)=>sum+Number(row.transmitted),0),
    submissionReceipts:receipts,
  };
  await client.query("ROLLBACK");
  console.log(JSON.stringify({capturedAt:new Date().toISOString(),transaction:"READ_ONLY_ROLLED_BACK",
    totals,activeRelevant,calculationSummary,requiredDocumentSummary,requiredDocumentClassifications,
    formWork,packages,approvals,preflight,submissions,
    ...(detail?{calculations,requiredDocuments}:{}),submissionReceiptCount:receipts},null,2));
}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}finally{await client.release();await rawPool.end()}
