import {withTenantContext} from './tenant-context.mjs';
import {CALCULATION_FORMULA_VERSION} from './sector-calculation.mjs';

export async function tenantInsights(pool,context,{auditExport=false}={}){
 return withTenantContext(pool,context,async db=>{
  const usage=(await db.query(`SELECT now() generated_at,s.plan_code,p.display_name plan_name,p.seat_limit,p.company_limit,
   CASE s.plan_code WHEN 'NORMAL' THEN 10 WHEN 'PROFESSIONAL' THEN 25 ELSE NULL END automation_limit,
   to_char(date_trunc('month',now() AT TIME ZONE 'UTC'),'YYYY-MM') usage_month,
   (SELECT count(*) FROM saas.tenant_memberships WHERE tenant_id=$1 AND status='ACTIVE') active_users,
   (SELECT count(*) FROM saas.tenant_companies WHERE tenant_id=$1 AND status='ACTIVE') active_companies,
   (SELECT count(*) FROM saas.automation_usage WHERE tenant_id=$1 AND month_start=date_trunc('month',now() AT TIME ZONE 'UTC')::date) automated_tenders,
   (SELECT count(*) FROM tenant_portal.jobs WHERE tenant_id=$1 AND status='RUNNING') running_jobs,
   (SELECT count(*) FROM tenant_portal.jobs WHERE tenant_id=$1 AND status='FAILED' AND created_at>now()-interval '30 days') failed_jobs_30d,
   (SELECT count(*) FROM tenant_portal.csm_service_cases WHERE tenant_id=$1 AND status NOT IN('RESOLVED','CLOSED') AND due_at<now()) overdue_service_cases
   FROM saas.subscriptions s JOIN saas.plans p ON p.code=s.plan_code WHERE s.tenant_id=$1`,[context.id])).rows[0];
  if(!usage)throw new Error('insights_subscription_missing');
  const companies=(await db.query(`WITH latest AS (
   SELECT DISTINCT ON(workspace_id,lot_key) * FROM tenant_portal.lot_assignment_versions WHERE tenant_id=$1 ORDER BY workspace_id,lot_key,version DESC
  ), stages AS (
   SELECT a.company_id,a.id,
    a.assignment_kind IN('AUTOMATIC','MANUAL') AND a.source_version_id=source.id AND a.profile_id=current_profile.id AND eligible.present IS TRUE valid,
    c.status,c.result->>'formulaVersion' formula_version,c.result->>'schemaVersion' schema_version
   FROM latest a JOIN tenant_portal.tender_workspaces w ON w.tenant_id=a.tenant_id AND w.id=a.workspace_id
   LEFT JOIN tenant_portal.company_profile_versions profile ON profile.tenant_id=a.tenant_id AND profile.id=a.profile_id
   LEFT JOIN LATERAL(SELECT id FROM tender.tender_versions WHERE tender_id=w.public_tender_id ORDER BY version DESC LIMIT 1) source ON true
   LEFT JOIN LATERAL(SELECT true present FROM tender.current_participation_eligible_lots WHERE tender_id=w.public_tender_id AND lot_key=a.lot_key LIMIT 1) eligible ON true
   LEFT JOIN LATERAL(SELECT id FROM tenant_portal.company_profile_versions p WHERE p.tenant_id=a.tenant_id AND p.company_id=a.company_id AND p.service_line=profile.service_line AND p.valid_from<=(now() AT TIME ZONE 'UTC')::date AND (p.valid_until IS NULL OR p.valid_until>=(now() AT TIME ZONE 'UTC')::date) ORDER BY p.valid_from DESC,p.version DESC LIMIT 1) current_profile ON true
   LEFT JOIN LATERAL(SELECT status,result FROM tenant_portal.lot_calculation_versions WHERE tenant_id=a.tenant_id AND assignment_id=a.id ORDER BY version DESC LIMIT 1) c ON true
  ) SELECT co.id,co.display_name,co.status,count(st.id) lot_count,
   count(st.id) FILTER(WHERE st.valid IS NOT TRUE OR co.status<>'ACTIVE' OR st.status='CALCULATED' AND (st.formula_version IS DISTINCT FROM $2 OR st.schema_version IS DISTINCT FROM '4')) review_required,
   count(st.id) FILTER(WHERE st.valid IS TRUE AND co.status='ACTIVE' AND st.status='CALCULATED' AND st.formula_version=$2 AND st.schema_version='4') current_calculated,
   count(st.id) FILTER(WHERE st.valid IS TRUE AND co.status='ACTIVE' AND st.status='BLOCKED') calculation_blocked,
   count(st.id) FILTER(WHERE st.valid IS TRUE AND co.status='ACTIVE' AND st.status IS NULL) awaiting_calculation
   FROM saas.tenant_companies co LEFT JOIN stages st ON st.company_id=co.id WHERE co.tenant_id=$1 GROUP BY co.id,co.display_name,co.status ORDER BY co.display_name,co.id`,[context.id,CALCULATION_FORMULA_VERSION])).rows;
  const unassigned=(await db.query(`SELECT count(*) count FROM (SELECT DISTINCT ON(workspace_id,lot_key) company_id FROM tenant_portal.lot_assignment_versions WHERE tenant_id=$1 ORDER BY workspace_id,lot_key,version DESC) latest WHERE company_id IS NULL`,[context.id])).rows[0];
  const recentFailures=(await db.query("SELECT id,job_type,created_at FROM tenant_portal.jobs WHERE tenant_id=$1 AND status='FAILED' ORDER BY created_at DESC,id LIMIT 20",[context.id])).rows;
  if(auditExport)await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id,metadata) VALUES($1,$2,'INSIGHTS_EXPORTED','tenant',$3,$4)",[context.id,context.actorUserId,context.id,{companyCount:companies.length,usageMonth:usage.usage_month}]);
  return {usage,companies,unassignedLots:Number(unassigned.count),recentFailures,scope:'CURRENT_TENANT_OPERATIONAL_COUNTS',externalSubmissionEnabled:false};
 });
}
