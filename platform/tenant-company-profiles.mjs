import crypto from 'node:crypto';
import {validTenantId,withTenantContext} from './tenant-context.mjs';
import {normalizeDecimal,normalizeUnit,parameterUnitRules} from './unit-catalog.mjs';
import {validateStructuredRegionConfiguration} from './structured-regions.mjs';
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const services=new Set(['cleaning','security','facility_management']);
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const canonical=value=>JSON.stringify(value&&typeof value==='object'?(Array.isArray(value)?value.map(item=>JSON.parse(canonical(item))):Object.fromEntries(Object.keys(value).sort().map(key=>[key,JSON.parse(canonical(value[key]))]))):value??null);
export function validateCompanyProfileInput(input){
 if(!input||!validTenantId(input.id)||!services.has(input.serviceLine)||!date(input.validFrom)||(input.validUntil!=null&&(!date(input.validUntil)||input.validUntil<input.validFrom))||input.confirmed!==true)throw fail('company_profile_input_invalid');
 if(!input.regions||!Array.isArray(input.regions.regions)||input.regions.regions.length<1||input.regions.regions.length>50)throw fail('company_profile_regions_required');
 const expected=Object.keys(parameterUnitRules).filter(key=>key.startsWith('C')||input.serviceLine==='security');
 if(!input.parameters||Object.keys(input.parameters).some(key=>!expected.includes(key)))throw fail('company_profile_parameters_invalid');
 const parameters={};
 for(const key of expected){
  const raw=input.parameters[key],rule=parameterUnitRules[key];
  if(!raw||typeof raw.source!=='string'||!raw.source.trim()||raw.source.length>500)throw fail('company_profile_parameter_source_required:'+key);
  const unit=normalizeUnit(key,raw.unit);if(!unit)throw fail('company_profile_parameter_unit_invalid:'+key);
  let value;
  if(key==='C02'){
   if(typeof raw.value!=='string'||!raw.value.trim()||raw.value.length>500)throw fail('company_profile_tariff_required');
   value=raw.value.trim();
  }else if(key==='C03'){
   if(!raw.value||typeof raw.value!=='object'||Array.isArray(raw.value)||!Object.keys(raw.value).length||Object.keys(raw.value).length>20)throw fail('company_profile_supplements_required');
   value={};for(const [kind,amount] of Object.entries(raw.value).sort(([a],[b])=>a.localeCompare(b))){const parsed=normalizeDecimal(amount);if(!/^[a-z][a-z0-9_]{0,39}$/.test(kind)||parsed===null||parsed<0||parsed>1000)throw fail('company_profile_supplement_invalid');value[kind]=parsed;}
  }else{
   value=normalizeDecimal(raw.value);
   if(!rule.numeric||value===null||value<0||key==='C01'&&value===0||['C19','C20','C21'].includes(key)&&unit.id==='PERCENT'&&value>=100)throw fail('company_profile_parameter_value_invalid:'+key);
  }
  const validFrom=raw.validFrom??input.validFrom,validUntil=raw.validUntil??input.validUntil??null;
  if(!date(validFrom)||(validUntil!==null&&(!date(validUntil)||validUntil<validFrom))||validFrom>input.validFrom||(validUntil&&validUntil<input.validFrom))throw fail('company_profile_parameter_validity_invalid:'+key);
  parameters[key]={value,unit:unit.id,source:raw.source.trim(),parameterId:input.id+':'+key,sourceVersionId:input.id,validFrom,validUntil};
 }
 return {parameters,requestSha256:crypto.createHash('sha256').update(canonical(input)).digest('hex')};
}
export class TenantCompanyProfiles{
 constructor(pool,{validateRegions=validateStructuredRegionConfiguration}={}){this.pool=pool;this.validateRegions=validateRegions;}
 async create(context,companyId,input){
  if(!validTenantId(companyId))throw fail('company_not_found',404);
  const validated=validateCompanyProfileInput(input);
  const existing=await withTenantContext(this.pool,context,async db=>(await db.query('SELECT * FROM tenant_portal.company_profile_versions WHERE tenant_id=$1 AND id=$2',[context.id,input.id])).rows[0]);
  const repeat=row=>{if(row.company_id!==companyId||row.request_sha256!==validated.requestSha256)throw fail('company_profile_request_conflict',409);return {profile:row,idempotent:true}};
  if(existing)return repeat(existing);
  const regionValidation=await this.validateRegions(input.regions);
  if(!regionValidation.valid)throw fail('company_profile_regions_invalid',422);
  return withTenantContext(this.pool,context,async db=>{
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended('tenant-profile:'||$1::text||':'||$2::text||':'||$3,0))",[context.id,companyId,input.serviceLine]);
   const repeated=(await db.query('SELECT * FROM tenant_portal.company_profile_versions WHERE tenant_id=$1 AND id=$2',[context.id,input.id])).rows[0];if(repeated)return repeat(repeated);
   const company=(await db.query("SELECT id FROM saas.tenant_companies WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",[context.id,companyId])).rows[0];if(!company)throw fail('company_not_found',404);
   const version=Number((await db.query('SELECT coalesce(max(version),0)+1 version FROM tenant_portal.company_profile_versions WHERE tenant_id=$1 AND company_id=$2 AND service_line=$3',[context.id,companyId,input.serviceLine])).rows[0].version);
   const profile=(await db.query('INSERT INTO tenant_portal.company_profile_versions(id,tenant_id,company_id,service_line,version,valid_from,valid_until,regions,parameters,request_sha256,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[input.id,context.id,companyId,input.serviceLine,version,input.validFrom,input.validUntil??null,regionValidation.configuration,validated.parameters,validated.requestSha256,context.actorUserId])).rows[0];
   await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id) VALUES($1,$2,'COMPANY_PROFILE_VERSION_CREATED','company_profile',$3)",[context.id,context.actorUserId,input.id]);
   return {profile,idempotent:false};
  });
 }
 async list(context,companyId){
  if(!validTenantId(companyId))throw fail('company_not_found',404);
  return withTenantContext(this.pool,context,async db=>(await db.query('SELECT * FROM tenant_portal.company_profile_versions WHERE tenant_id=$1 AND company_id=$2 ORDER BY service_line,version DESC',[context.id,companyId])).rows);
 }
 async effective(context,companyId,serviceLine,effectiveDate){
  if(!validTenantId(companyId)||!services.has(serviceLine)||!date(effectiveDate))throw fail('company_profile_selection_invalid');
  return withTenantContext(this.pool,context,async db=>(await db.query('SELECT * FROM tenant_portal.company_profile_versions WHERE tenant_id=$1 AND company_id=$2 AND service_line=$3 AND valid_from<=$4::date AND (valid_until IS NULL OR valid_until>=$4::date) ORDER BY valid_from DESC,version DESC LIMIT 1',[context.id,companyId,serviceLine,effectiveDate])).rows[0]??null);
 }
}
