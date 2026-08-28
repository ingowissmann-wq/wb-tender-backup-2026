import pg from "pg";
import {readFileSync} from "node:fs";

const pool=new pg.Pool({connectionString:process.env.DATABASE_URL||readFileSync(process.env.DATABASE_URL_FILE,"utf8").trim()});
const specs=[
  ["tenders","tender.tenders","to_jsonb(x)"],
  ["versions","tender.tender_versions","jsonb_build_object('id',id,'tender_id',tender_id,'version',version,'source_sha256',source_sha256,'change_kind',change_kind,'source_timestamp',source_timestamp)"],
  ["service_relevance","tender.service_relevance_evaluations","to_jsonb(x)"],
  ["regions","tender.region_evaluations","to_jsonb(x)"],
  ["region_rules","tender.region_profile_rules","to_jsonb(x)"],
  ["region_versions","tender.region_profile_versions","to_jsonb(x)"],
  ["region_zones","tender.region_zones","to_jsonb(x)"],
  ["management_inbox","tender.management_inbox","to_jsonb(x)"],
  ["portal_registry","tender.portal_registry","to_jsonb(x)"],
  ["credential_metadata","tender.portal_credential_secrets","to_jsonb(x)-'ciphertext'-'iv'-'auth_tag'"],
  ["credential_payloads","tender.portal_credential_secrets","jsonb_build_object('id',id,'ciphertext_sha',encode(digest(ciphertext,'sha256'),'hex'),'iv_sha',encode(digest(iv,'sha256'),'hex'),'tag_sha',encode(digest(auth_tag,'sha256'),'hex'))"],
  ["credential_scopes","tender.portal_credential_companies","to_jsonb(x)"],
  ["decisions","tender.decisions","to_jsonb(x)"],
  ["overrides","tender.decision_overrides","to_jsonb(x)"],
  ["company_profiles","tender.company_profiles","to_jsonb(x)"],
  ["documents","tender.enrichment_documents","to_jsonb(x)-'content'-'extracted_data'"],
  ["enrichments","tender.enrichment_versions","to_jsonb(x)-'raw_payload'-'structured_data'"],
  ["calculations","tender.calculations","to_jsonb(x)"],
  ["approvals","tender.approval_requests","to_jsonb(x)"],
  ["bid_packages","tender.bid_packages","to_jsonb(x)"],
  ["users","iam.users","to_jsonb(x)-'password_hash'-'mfa_secret_encrypted'"],
  ["roles","iam.roles","to_jsonb(x)"],
  ["role_permissions","iam.role_permissions","to_jsonb(x)"],
  ["submission_entitlements","tender.submission_product_entitlements","to_jsonb(x)"],
  ["website","cms.landing_pages","to_jsonb(x)"],
  ["career","recruiting.application_files","to_jsonb(x)-'content'"],
];
try{
  for(const [name,table,expression] of specs){
    const sql=`SELECT count(*)::bigint count,encode(digest(coalesce(string_agg(md5((${expression})::text),'' ORDER BY md5((${expression})::text)),''),'sha256'),'hex') hash FROM ${table} x`;
    const row=(await pool.query(sql)).rows[0];
    console.log(`${name}|${row.count}|${row.hash}`);
  }
}finally{await pool.end()}
