import pg from "pg";
import { readFileSync } from "node:fs";

const connectionString = process.env.DATABASE_URL || readFileSync(process.env.DATABASE_URL_FILE, "utf8").toString().trim();
const pool = new pg.Pool({ connectionString, max: 1 });
const reports = {
  sources: `select code,name,interface,enabled,last_status,last_success_at from tender.sources order by code`,
  schedulers: `select source_code,enabled,kill_switch,mode,last_success_at,last_failure_at,retry_count from tender.scheduler_sources order by source_code`,
  tenders_by_source: `select source_code,count(*)::int total,count(*) filter(where status='ACTIVE')::int active,count(*) filter(where source_lifecycle_status='ACTIVE')::int lifecycle_active,max(last_synced_at) last_synced_at from tender.tenders group by source_code order by source_code`,
  source_references: `select source_code,count(*)::int total,count(distinct tender_id)::int tenders,count(*) filter(where source_url is not null)::int with_url from tender.source_references group by source_code order by source_code`,
  queue: `select action_type,status,count(*)::int total,count(*) filter(where status in('CLAIMED','RUNNING') and coalesce(timeout_at,now()+interval '1 second')>now())::int active_leases from tender.autopilot_queue group by action_type,status order by action_type,status`,
  scheduler_leases: `select source_code,count(*)::int total,count(*) filter(where expires_at>now())::int active from tender.scheduler_leases group by source_code order by source_code`,
  submission_jobs: `select status,count(*)::int total,count(*) filter(where lease_expires_at>now())::int active_leases from tender.external_submission_jobs group by status order by status`,
  lot_coverage: `with current_t as (select id from tender.current_participation_eligible_tenders), x as (select tender_id,count(*) filter(where is_current)::int current_lots,count(*) filter(where is_current and lifecycle_status='ACTIVE' and participation_status='ELIGIBLE' and offer_deadline>now())::int eligible_lots,count(*) filter(where is_current and deadline_quality<>'EXACT')::int unclear_deadlines from tender.tender_lot_lifecycles group by tender_id) select count(*)::int active_tenders,count(*) filter(where coalesce(x.current_lots,0)=0)::int missing_lots,count(*) filter(where coalesce(x.eligible_lots,0)=1)::int single_eligible,count(*) filter(where coalesce(x.eligible_lots,0)>1)::int multiple_eligible,count(*) filter(where coalesce(x.unclear_deadlines,0)>0)::int unclear_deadline_tenders from current_t left join x on x.tender_id=current_t.id`,
  canonical_lots: `select count(*)::int total,count(distinct tender_id)::int tenders,count(*) filter(where external_id is null or external_id='')::int missing_source_lot_id from tender.lots`,
  enrichment_coverage: `with active as (select id from tender.current_participation_eligible_tenders), latest as (select distinct on(tender_id) tender_id,id from tender.enrichment_versions where historical=false order by tender_id,version desc) select count(*)::int active_tenders,count(*) filter(where latest.id is null)::int missing_enrichment,count(*) filter(where latest.id is not null)::int with_enrichment from active left join latest on latest.tender_id=active.id`,
  documents: `select count(*)::int total,count(*) filter(where source_url is not null)::int with_url,count(*) filter(where content is not null)::int with_content,count(*) filter(where payload_sha256 is not null)::int hashed,count(*) filter(where fetch_status in('VORHANDEN','DOWNLOADED','ANALYZED'))::int available,count(*) filter(where fetch_status like '%FEHL%' or fetch_status like '%BLOCK%' or resolution_status in('FAILED','PORTAL_ACCESS_REQUIRED'))::int blocked from tender.enrichment_documents`,
  downstream: `select (select count(*) from tender.calculations)::int calculations,(select count(*) from tender.management_outputs)::int management_outputs,(select count(*) from tender.approval_requests)::int approvals,(select count(*) from tender.bid_packages)::int bid_packages`,
  registry: `select count(*)::int total,count(*) filter(where adapter_enabled)::int adapter_enabled,count(*) filter(where authentication_entry_url is not null)::int login_urls,count(*) filter(where registration_entry_url is not null)::int registration_urls,count(*) filter(where document_path is not null or 'DOCUMENT_DOWNLOAD'=any(coalesce(capabilities,'{}'::text[])))::int document_capability from tender.portal_registry`,
  registry_hosts: `select canonical_domain,count(*)::int entries,bool_or(adapter_enabled) adapter_enabled,bool_or(authentication_entry_url is not null) login,bool_or(registration_entry_url is not null) registration from tender.portal_registry group by canonical_domain order by canonical_domain`,
  evidence_hosts: `with urls as (select source_url url,'TENDER' kind from tender.tenders where source_url~'^https?://' union all select source_url,'SOURCE_REFERENCE' from tender.source_references where source_url~'^https?://' union all select source_url,'DOCUMENT' from tender.enrichment_documents where source_url~'^https?://'), hosts as (select lower((regexp_match(url,'^https?://([^/:?#]+)'))[1]) host,kind from urls) select host,count(*)::int occurrences,count(distinct kind)::int evidence_kinds,exists(select 1 from tender.portal_registry p where host=p.canonical_domain or host=any(p.allowed_subdomains)) registered from hosts where host is not null group by host order by occurrences desc,host`,
};

try {
  for (const [name, sql] of Object.entries(reports)) {
    try {
      const rows = (await pool.query(sql)).rows;
      console.log(`${name}|${JSON.stringify(rows)}`);
    } catch (error) {
      console.log(`${name}|ERROR:${error.code}:${error.message}`);
    }
  }
} finally {
  await pool.end();
}
