import fs from "node:fs";
import pg from "pg";
import {createFixedScopedPool,loadBackgroundScope} from "../platform/scoped-pg-pool.mjs";

const connectionString=process.env.DATABASE_URL||fs.readFileSync(
  process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8",
).trim();
const rawPool=new pg.Pool({connectionString,max:1,options:["-c default_transaction_read_only=on -c statement_timeout=120000",process.env.DATABASE_SESSION_OPTIONS].filter(Boolean).join(" ")});
const pool=createFixedScopedPool(rawPool,await loadBackgroundScope(rawPool)).pool;
const client=await pool.connect();

try{
  await client.query("BEGIN READ ONLY");
  const companies=(await client.query(`SELECT company_id,legal_name,active,sector_slug,technical_key,
      tender_profile_id,configuration_version,sector_status,discovery_status,matching_status,calculation_status
    FROM tender.enterprise_company_links WHERE active ORDER BY legal_name`)).rows;
  const profiles=(await client.query(`SELECT profile.id,profile.company_id,profile.version,profile.lifecycle_status,
      profile.service_lines,profile.profile_sha256 IS NOT NULL profile_hash_present,
      profile.capabilities,profile.certifications,profile.commercial_profile
    FROM tender.company_profiles profile
    JOIN tender.enterprise_company_links company ON company.company_id=profile.company_id AND company.active
    ORDER BY company.legal_name,profile.version DESC`)).rows;
  const scopes=(await client.query(`SELECT scope.tenant_id,tenant.tenant_key,scope.company_id,company.legal_name,
      scope.canonical_service,scope.profile_id,scope.active_region_version_id,
      scope.profile_id=company.tender_profile_id current_profile_binding
    FROM tender.configuration_scopes scope
    JOIN tender.configuration_tenants tenant ON tenant.id=scope.tenant_id
    JOIN tender.enterprise_company_links company ON company.company_id=scope.company_id
    ORDER BY company.legal_name,scope.canonical_service`)).rows;
  const runtimeTenantBindings=(await client.query(`SELECT binding.company_id,company.legal_name,binding.tenant_id
    FROM saas.legacy_company_tenant_bindings binding
    JOIN tender.enterprise_company_links company ON company.company_id=binding.company_id AND company.active
    ORDER BY company.legal_name,binding.tenant_id`)).rows;
  const protect=companies.find(company=>company.legal_name==="WB-Protect & Service GmbH");
  const protectProfiles=profiles.filter(profile=>String(profile.company_id)===String(protect?.company_id));
  const protectScopes=scopes.filter(scope=>String(scope.company_id)===String(protect?.company_id));
  await client.query("ROLLBACK");
  console.log(JSON.stringify({capturedAt:new Date().toISOString(),transaction:"READ_ONLY_ROLLED_BACK",
    activeCompanyCount:companies.length,companies,configurationScopeCount:scopes.length,
    companyScopeSummary:companies.map(company=>({companyId:company.company_id,company:company.legal_name,
      currentProfileId:company.tender_profile_id,scopes:scopes.filter(scope=>String(scope.company_id)===String(company.company_id))
        .map(scope=>({tenantId:scope.tenant_id,tenantKey:scope.tenant_key,canonicalService:scope.canonical_service,
          profileId:scope.profile_id,currentProfileBinding:scope.current_profile_binding}))})),
    runtimeTenantBindings,protect:{company:protect,
      profiles:process.argv.includes("--detail")?protectProfiles:protectProfiles.map(profile=>({
        id:profile.id,version:profile.version,lifecycle_status:profile.lifecycle_status,
        service_lines:profile.service_lines,profile_hash_present:profile.profile_hash_present,
      })),scopes:protectScopes}},null,2));
}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}finally{await client.release();await rawPool.end()}
